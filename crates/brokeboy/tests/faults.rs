#![cfg(feature = "postgres")]
use brokeboy::{
    Billing, BillingOptions,
    sql::SqlStorage,
    storage::{BillingFuture, PageQuery, Storage, Transaction},
};
use brokeboy_core::{
    records::{Row, Table},
    schema::{Dialect, migration_sql},
};
use serde_json::json;
use std::{
    io::{BufRead, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

struct FaultStorage {
    sql: SqlStorage<sqlx::Postgres>,
    pool: sqlx::PgPool,
    control: sqlx::PgPool,
    armed: Arc<AtomicBool>,
    hold_process: bool,
}
struct FaultTransaction {
    inner: Box<dyn Transaction>,
    control: sqlx::PgPool,
    backend: i32,
    fail: bool,
    hold_process: bool,
}
impl Storage for FaultStorage {
    fn begin(&self, scope: &str) -> BillingFuture<'_, Box<dyn Transaction>> {
        let scope = scope.to_owned();
        Box::pin(async move {
            let backend: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                .fetch_one(&self.pool)
                .await
                .unwrap();
            let inner = self.sql.begin(&scope).await?;
            Ok(Box::new(FaultTransaction {
                inner,
                control: self.control.clone(),
                backend,
                fail: self.armed.swap(false, Ordering::SeqCst),
                hold_process: self.hold_process,
            }) as Box<dyn Transaction>)
        })
    }
    fn scopes(
        &self,
        after: Option<&str>,
        limit: u32,
        prefix: &str,
    ) -> BillingFuture<'_, Vec<String>> {
        let after = after.map(str::to_owned);
        let prefix = prefix.to_owned();
        Box::pin(async move { self.sql.scopes(after.as_deref(), limit, &prefix).await })
    }
    fn close(&self) -> BillingFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}
impl Transaction for FaultTransaction {
    fn get(&mut self, table: Table, id: &str) -> BillingFuture<'_, Option<Row>> {
        self.inner.get(table, id)
    }
    fn page(&mut self, table: Table, query: PageQuery) -> BillingFuture<'_, Vec<Row>> {
        self.inner.page(table, query)
    }
    fn put(&mut self, table: Table, row: Row) -> BillingFuture<'_, ()> {
        self.inner.put(table, row)
    }
    fn rollback(self: Box<Self>) -> BillingFuture<'static, ()> {
        self.inner.rollback()
    }
    fn commit(self: Box<Self>) -> BillingFuture<'static, ()> {
        Box::pin(async move {
            if self.fail {
                if self.hold_process {
                    println!("financial-write-awaiting-commit");
                    std::io::stdout().flush().unwrap();
                    let mut line = String::new();
                    std::io::stdin().read_line(&mut line).unwrap();
                    panic!("parent must terminate the child before commit");
                }
                let killed: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1)")
                    .bind(self.backend)
                    .fetch_one(&self.control)
                    .await
                    .unwrap();
                assert!(killed);
            }
            self.inner.commit().await
        })
    }
}
fn debit() -> serde_json::Value {
    json!({"customerId":"fault","feature":"wallet","amount":"3","idempotencyKey":"debit"})
}
async fn storage(
    url: &str,
    hold_process: bool,
) -> (Billing, Arc<AtomicBool>, sqlx::PgPool, sqlx::PgPool) {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(url)
        .await
        .unwrap();
    let control = sqlx::PgPool::connect(url).await.unwrap();
    let armed = Arc::new(AtomicBool::new(false));
    let storage = Arc::new(FaultStorage {
        sql: SqlStorage::borrowed(pool.clone()),
        pool: pool.clone(),
        control: control.clone(),
        armed: armed.clone(),
        hold_process,
    });
    (
        Billing::from_storage(storage, BillingOptions::default()),
        armed,
        pool,
        control,
    )
}
#[tokio::test]
async fn fault_child() {
    let Ok(url) = std::env::var("BROKEBOY_FAULT_CHILD_URL") else {
        return;
    };
    let (billing, armed, _, _) = storage(&url, true).await;
    armed.store(true, Ordering::SeqCst);
    billing.call("usage.consume", debit()).await.unwrap();
    panic!("child must not commit");
}
#[tokio::test]
async fn postgres_connection_and_process_loss_roll_back_financial_writes() {
    let Ok(base) = std::env::var("TEST_POSTGRES_URL") else {
        eprintln!("TEST_POSTGRES_URL missing; financial fault test not qualified");
        return;
    };
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("fault_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&admin)
        .await
        .unwrap();
    let mut url = url::Url::parse(&base).unwrap();
    url.query_pairs_mut()
        .append_pair("options", &format!("-csearch_path={schema}"));
    let (billing, armed, pool, control) = storage(url.as_str(), false).await;
    for sql in migration_sql(Dialect::Postgres) {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&pool)
            .await
            .unwrap();
    }
    billing
        .customers()
        .create(json!({"id":"fault","idempotencyKey":"create"}))
        .await
        .unwrap();
    billing
        .credits()
        .grant(
            json!({"customerId":"fault","feature":"wallet","amount":"10","idempotencyKey":"fund"}),
        )
        .await
        .unwrap();
    armed.store(true, Ordering::SeqCst);
    assert_eq!(
        billing
            .call("usage.consume", debit())
            .await
            .unwrap_err()
            .code,
        "storage_error"
    );
    assert_eq!(
        billing
            .credits()
            .balance(json!({"customerId":"fault","feature":"wallet"}))
            .await
            .unwrap()
            .available,
        "10"
    );
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "fault_child", "--nocapture"])
        .env("BROKEBOY_FAULT_CHILD_URL", url.as_str())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let output = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        for line in std::io::BufReader::new(output).lines() {
            if line.unwrap().contains("financial-write-awaiting-commit") {
                return;
            }
        }
        panic!("child exited before its financial write");
    });
    let started = std::time::Instant::now();
    while !reader.is_finished() && started.elapsed() < std::time::Duration::from_secs(20) {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    if !reader.is_finished() {
        child.kill().unwrap();
        panic!("child readiness timed out");
    }
    reader.join().unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(
        billing
            .credits()
            .balance(json!({"customerId":"fault","feature":"wallet"}))
            .await
            .unwrap()
            .available,
        "10"
    );
    let receipt = billing.call("usage.consume", debit()).await.unwrap();
    assert_eq!(
        billing.call("usage.consume", debit()).await.unwrap(),
        receipt
    );
    assert_eq!(
        billing
            .credits()
            .balance(json!({"customerId":"fault","feature":"wallet"}))
            .await
            .unwrap()
            .available,
        "7"
    );
    assert_eq!(
        billing
            .credits()
            .reconcile(json!({"customerId":"fault"}))
            .await
            .unwrap()["consistent"],
        true
    );
    billing.close().await.unwrap();
    pool.close().await;
    control.close().await;
    sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}
