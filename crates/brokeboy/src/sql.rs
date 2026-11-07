//! SQL transactions retain the 0.1 table names, scope locks and raw row payloads.
use crate::storage::{BillingFuture, PageQuery, Storage, Transaction};
use brokeboy_core::{
    BillingError, Result,
    records::{Row, Table},
};
use sqlx::{Database, Pool, Row as SqlRow};
use std::sync::atomic::{AtomicBool, Ordering};

pub use brokeboy_core::models::DatabaseConnection as DatabaseConfig;
pub use brokeboy_core::schema::Dialect as Driver;
impl crate::Billing {
    pub async fn open(database: DatabaseConfig, options: crate::BillingOptions) -> Result<Self> {
        let max = database.max_connections.unwrap_or(10);
        let timeout = database.acquire_timeout_ms.unwrap_or(30000);
        if max == 0 || max > 1000 || timeout == 0 || timeout > 300000 {
            return Err(BillingError::new("invalid_database_configuration"));
        }
        let timeout = std::time::Duration::from_millis(timeout);
        let storage: std::sync::Arc<dyn Storage> = match database.driver {
            #[cfg(feature = "postgres")]
            Driver::Postgres => std::sync::Arc::new(SqlStorage::owned(
                sqlx::postgres::PgPoolOptions::new()
                    .max_connections(max)
                    .acquire_timeout(timeout)
                    .connect(&database.url)
                    .await
                    .map_err(storage_error)?,
            )),
            #[cfg(feature = "mysql")]
            Driver::Mysql => std::sync::Arc::new(SqlStorage::owned(
                sqlx::mysql::MySqlPoolOptions::new()
                    .max_connections(max)
                    .acquire_timeout(timeout)
                    .connect(&database.url)
                    .await
                    .map_err(storage_error)?,
            )),
            #[cfg(feature = "sqlite")]
            Driver::Sqlite => {
                use std::str::FromStr;
                let config = sqlx::sqlite::SqliteConnectOptions::from_str(&database.url)
                    .map_err(|_| BillingError::new("invalid_database_configuration"))?
                    .create_if_missing(false)
                    .busy_timeout(timeout);
                std::sync::Arc::new(SqlStorage::owned(
                    sqlx::sqlite::SqlitePoolOptions::new()
                        .max_connections(max)
                        .acquire_timeout(timeout)
                        .connect_with(config)
                        .await
                        .map_err(storage_error)?,
                ))
            }
            #[cfg(not(all(feature = "postgres", feature = "mysql", feature = "sqlite")))]
            _ => return Err(BillingError::new("database_driver_not_enabled")),
        };
        Ok(Self::from_storage(storage, options))
    }
}

fn storage_error(error: sqlx::Error) -> BillingError {
    // Driver errors can contain URLs, credentials and customer data.
    let mut result = BillingError::message(
        "storage_error",
        "Billing database operation failed; inspect application database diagnostics.",
    );
    let category = match &error {
        sqlx::Error::Database(_) => "database",
        sqlx::Error::PoolTimedOut => "pool_timeout",
        sqlx::Error::PoolClosed => "pool_closed",
        sqlx::Error::Io(_) => "connection",
        sqlx::Error::Tls(_) => "tls",
        _ => "driver",
    };
    let code = error
        .as_database_error()
        .and_then(|db| db.code())
        .filter(|code| {
            !code.is_empty() && code.len() <= 16 && code.bytes().all(|b| b.is_ascii_alphanumeric())
        });
    result.details = Some(serde_json::json!({"category":category, "databaseCode":code}));
    result
}

/// A borrowed pool is never closed by Brokeboy. An owned pool is drained on close.
pub struct SqlStorage<DB: Database> {
    pool: Pool<DB>,
    owned: bool,
    closed: AtomicBool,
}
impl<DB: Database> SqlStorage<DB> {
    pub fn borrowed(pool: Pool<DB>) -> Self {
        Self {
            pool,
            owned: false,
            closed: AtomicBool::new(false),
        }
    }
    pub fn owned(pool: Pool<DB>) -> Self {
        Self {
            pool,
            owned: true,
            closed: AtomicBool::new(false),
        }
    }
}

macro_rules! adapter {
    ($db:ty, $variant:ident, $begin:literal, $lock_insert:literal, $lock:expr, $postgres:expr, $mysql:expr) => {
        struct $variant {
            connection: sqlx::pool::PoolConnection<$db>,
            scope: String,
            finished: bool,
        }
        impl Drop for $variant {
            fn drop(&mut self) {
                // If a future is dropped during BEGIN, a query, COMMIT or ROLLBACK,
                // its outcome is ambiguous. Never recycle that connection.
                if !self.finished {
                    self.connection.close_on_drop();
                }
            }
        }
        impl Storage for SqlStorage<$db> {
            fn scopes(
                &self,
                after: Option<&str>,
                limit: u32,
                prefix: &str,
            ) -> BillingFuture<'_, Vec<String>> {
                let after = after.unwrap_or_default().to_owned();
                let prefix = format!("{prefix}%");
                Box::pin(async move {
                    if self.closed.load(Ordering::Acquire) {
                        return Err(BillingError::new("billing_closed"));
                    }
                    if limit == 0 || limit > 1001 {
                        return Err(BillingError::new("invalid_limit"));
                    }
                    let sql = format!(
                        "SELECT scope FROM brokeboy_locks WHERE scope>{} AND scope LIKE {} ORDER BY scope LIMIT {}",
                        marker($postgres, 1),
                        marker($postgres, 2),
                        marker($postgres, 3)
                    );
                    // Only enum-selected identifiers and generated placeholders enter SQL;
                    // every caller-provided value is bound separately.
                    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
                        .bind(after)
                        .bind(prefix)
                        .bind(i64::from(limit))
                        .fetch_all(&self.pool)
                        .await
                        .map_err(storage_error)?;
                    rows.into_iter()
                        .map(|row| row.try_get("scope").map_err(storage_error))
                        .collect()
                })
            }
            fn begin(&self, scope: &str) -> BillingFuture<'_, Box<dyn Transaction>> {
                let scope = scope.to_owned();
                Box::pin(async move {
                    if self.closed.load(Ordering::Acquire) {
                        return Err(BillingError::new("billing_closed"));
                    }
                    if scope.is_empty() || scope.len() > 191 {
                        return Err(BillingError::new("invalid_scope"));
                    }
                    let connection = self.pool.acquire().await.map_err(storage_error)?;
                    let mut tx = $variant {
                        connection,
                        scope,
                        finished: false,
                    };
                    // Driver futures must finish before explicit rollback is attempted.
                    let setup: Result<()> = async {
                        sqlx::raw_sql($begin)
                            .execute(&mut *tx.connection)
                            .await
                            .map_err(storage_error)?;
                        sqlx::query($lock_insert)
                            .bind(&tx.scope)
                            .execute(&mut *tx.connection)
                            .await
                            .map_err(storage_error)?;
                        if let Some(lock) = $lock {
                            sqlx::query(lock)
                                .bind(&tx.scope)
                                .fetch_optional(&mut *tx.connection)
                                .await
                                .map_err(storage_error)?;
                        }
                        Ok(())
                    }
                    .await;
                    if let Err(error) = setup {
                        sqlx::raw_sql("ROLLBACK")
                            .execute(&mut *tx.connection)
                            .await
                            .map_err(storage_error)?;
                        tx.finished = true;
                        return Err(error);
                    }
                    Ok(Box::new(tx) as Box<dyn Transaction>)
                })
            }
            fn close(&self) -> BillingFuture<'_, ()> {
                Box::pin(async move {
                    self.closed.store(true, Ordering::Release);
                    if self.owned {
                        self.pool.close().await;
                    }
                    Ok(())
                })
            }
        }
        impl Transaction for $variant {
            fn get(&mut self, table: Table, id: &str) -> BillingFuture<'_, Option<Row>> {
                let id = id.to_owned();
                Box::pin(async move {
                    let sql = format!(
                        "SELECT id,state,data FROM brokeboy_{} WHERE scope={} AND id={}",
                        table.name(),
                        marker($postgres, 1),
                        marker($postgres, 2)
                    );
                    let row = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
                        .bind(&self.scope)
                        .bind(id)
                        .fetch_optional(&mut *self.connection)
                        .await
                        .map_err(storage_error)?;
                    row.map(|r| {
                        decode(
                            r.try_get("id").map_err(storage_error)?,
                            r.try_get("state").map_err(storage_error)?,
                            r.try_get("data").map_err(storage_error)?,
                        )
                    })
                    .transpose()
                })
            }
            fn page(&mut self, table: Table, query: PageQuery) -> BillingFuture<'_, Vec<Row>> {
                Box::pin(async move {
                    if query.limit == 0 || query.limit > 1001 {
                        return Err(BillingError::new("invalid_limit"));
                    }
                    if query.due_before.is_some() && table != Table::Work {
                        return Err(BillingError::new("invalid_due_query"));
                    }
                    let mut n = 2;
                    let mut sql = format!(
                        "SELECT id,state,data FROM brokeboy_{} WHERE scope={} AND id>{}",
                        table.name(),
                        marker($postgres, 1),
                        marker($postgres, 2)
                    );
                    if query.state.is_some() {
                        n += 1;
                        sql.push_str(&format!(" AND state={}", marker($postgres, n)));
                    }
                    if query.due_before.is_some() {
                        n += 1;
                        sql.push_str(&format!(" AND due<={}", marker($postgres, n)));
                    }
                    n += 1;
                    sql.push_str(&format!(
                        " ORDER BY id LIMIT {}",
                        marker($postgres, n)
                    ));
                    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
                        .bind(&self.scope)
                        .bind(query.after.unwrap_or_default());
                    if let Some(state) = query.state {
                        q = q.bind(state);
                    }
                    if let Some(due) = query.due_before {
                        q = q.bind(due);
                    }
                    let rows = q
                        .bind(i64::from(query.limit))
                        .fetch_all(&mut *self.connection)
                        .await
                        .map_err(storage_error)?;
                    rows.into_iter()
                        .map(|r| {
                            decode(
                                r.try_get("id").map_err(storage_error)?,
                                r.try_get("state").map_err(storage_error)?,
                                r.try_get("data").map_err(storage_error)?,
                            )
                        })
                        .collect()
                })
            }
            fn put(&mut self, table: Table, row: Row) -> BillingFuture<'_, ()> {
                Box::pin(async move {
                    if !row.extra.is_empty() {
                        return Err(BillingError::message("unsupported_record", "Unrecognized row envelope fields cannot be written to this database schema."));
                    }
                    let data = serde_json::to_string(&row.data)
                        .map_err(|_| BillingError::new("invalid_record"))?;
                    let work = table == Table::Work;
                    let values = (1..=if work { 5 } else { 4 })
                        .map(|i| marker($postgres, i))
                        .collect::<Vec<_>>()
                        .join(",");
                    let fields = if work { ",due" } else { "" };
                    let update = if $mysql {
                        format!(
                            "ON DUPLICATE KEY UPDATE state=VALUES(state),data=VALUES(data){}",
                            if work { ",due=VALUES(due)" } else { "" }
                        )
                    } else {
                        format!(
                            "ON CONFLICT(scope,id) DO UPDATE SET state=excluded.state,data=excluded.data{}",
                            if work { ",due=excluded.due" } else { "" }
                        )
                    };
                    let sql = format!(
                        "INSERT INTO brokeboy_{} (scope,id,state,data{}) VALUES ({}) {}",
                        table.name(),
                        fields,
                        values,
                        update
                    );
                    let due = if work { due_at(&row)? } else { 0 };
                    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
                        .bind(&self.scope)
                        .bind(row.id)
                        .bind(row.state)
                        .bind(data);
                    if work {
                        q = q.bind(due);
                    }
                    q.execute(&mut *self.connection)
                        .await
                        .map_err(storage_error)?;
                    Ok(())
                })
            }
            fn commit(mut self: Box<Self>) -> BillingFuture<'static, ()> {
                Box::pin(async move {
                    sqlx::raw_sql("COMMIT")
                        .execute(&mut *self.connection)
                        .await
                        .map_err(storage_error)?;
                    self.finished = true;
                    Ok(())
                })
            }
            fn rollback(mut self: Box<Self>) -> BillingFuture<'static, ()> {
                Box::pin(async move {
                    sqlx::raw_sql("ROLLBACK")
                        .execute(&mut *self.connection)
                        .await
                        .map_err(storage_error)?;
                    self.finished = true;
                    Ok(())
                })
            }
        }
    }
}

fn marker(postgres: bool, index: u32) -> String {
    if postgres {
        format!("${index}")
    } else {
        "?".into()
    }
}
fn decode(id: String, state: String, data: String) -> Result<Row> {
    Ok(Row { id, state, data: serde_json::from_str(&data).map_err(|_| BillingError::message("corrupt_record", "Stored billing data is invalid JSON; restore or reconcile the record before retrying."))?, extra: Default::default() })
}
fn due_at(row: &Row) -> Result<i64> {
    fn field(row: &Row, name: &str) -> Result<i64> {
        match row.data.get(name) {
            None => Ok(0),
            Some(v) => v
                .as_i64()
                .filter(|v| *v >= 0 && *v <= 9_007_199_254_740_991)
                .ok_or_else(|| BillingError::new("corrupt_record")),
        }
    }
    Ok(
        field(row, "availableAt")?.max(if row.state == "processing" {
            field(row, "leaseUntil")?
        } else {
            0
        }),
    )
}

#[cfg(feature = "sqlite")]
adapter!(
    sqlx::Sqlite,
    SqliteTransaction,
    "BEGIN IMMEDIATE",
    "INSERT INTO brokeboy_locks (scope,revision) VALUES (?,0) ON CONFLICT(scope) DO NOTHING",
    None::<&str>,
    false,
    false
);
#[cfg(feature = "postgres")]
adapter!(
    sqlx::Postgres,
    PostgresTransaction,
    "BEGIN",
    "INSERT INTO brokeboy_locks (scope,revision) VALUES ($1,0) ON CONFLICT(scope) DO NOTHING",
    Some("SELECT revision FROM brokeboy_locks WHERE scope=$1 FOR UPDATE"),
    true,
    false
);
#[cfg(feature = "mysql")]
adapter!(
    sqlx::MySql,
    MysqlTransaction,
    "BEGIN",
    "INSERT INTO brokeboy_locks (scope,revision) VALUES (?,0) ON DUPLICATE KEY UPDATE scope=VALUES(scope)",
    Some("SELECT revision FROM brokeboy_locks WHERE scope=? FOR UPDATE"),
    false,
    true
);
