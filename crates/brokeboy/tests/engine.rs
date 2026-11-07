#![cfg(feature = "sqlite")]
use brokeboy::{
    Billing, BillingOptions,
    sql::SqlStorage,
    storage::{Clock, Identifiers},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
struct FixedClock(i64);
impl Clock for FixedClock {
    fn now(&self) -> i64 {
        self.0
    }
}
struct SequentialIds(AtomicU64);
impl Identifiers for SequentialIds {
    fn next(&self) -> String {
        format!(
            "00000000-0000-4000-8000-{:012x}",
            self.0.fetch_add(1, Ordering::SeqCst) + 1
        )
    }
}
async fn setup() -> Billing {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../test/fixtures/compatibility/v1.json")).unwrap();
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    for sql in fixture["schema"]["sqlite"].as_array().unwrap() {
        sqlx::query(sqlx::AssertSqlSafe(sql.as_str().unwrap()))
            .execute(&pool)
            .await
            .unwrap();
    }
    Billing::from_storage(
        Arc::new(SqlStorage::owned(pool)),
        BillingOptions {
            clock: Arc::new(FixedClock(1_769_862_896_789)),
            identifiers: Arc::new(SequentialIds(AtomicU64::new(0))),
            ..Default::default()
        },
    )
}
async fn legacy_receipts(billing: Billing) {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/compatibility/engine-v1.json"
    ))
    .unwrap();
    assert_eq!(fixture["now"], json!(1_769_862_896_789_i64));
    let groups = fixture["records"].as_array().unwrap();
    let catalog = groups.iter().find(|g| g["table"] == "catalog").unwrap();
    let rows = catalog["rows"].as_array().unwrap();
    let features = rows.iter().find(|r| r["id"] == "features").unwrap()["data"].clone();
    let mut plan = rows.iter().find(|r| r["state"] == "published").unwrap()["data"].clone();
    plan.as_object_mut().unwrap().remove("version");
    plan.as_object_mut().unwrap().remove("revision");
    billing
        .call(
            "catalog.publish",
            json!({"catalog":{"features":features,"plans":[plan]},"expectedRevision":0}),
        )
        .await
        .unwrap();
    for trace in fixture["traces"].as_array().unwrap().iter() {
        let method = trace["method"].as_str().unwrap();
        let result = billing.call(method, trace["input"].clone()).await.unwrap();
        assert_eq!(result, trace["result"], "executing {method}");
        assert_eq!(
            billing.call(method, trace["input"].clone()).await.unwrap(),
            result,
            "retrying {method}"
        );
    }
    assert_eq!(
        billing
            .call("credits.reconcile", json!({"customerId":"fixture"}))
            .await
            .unwrap()["consistent"],
        true
    );
    let exported = billing
        .call("migration.export", json!({"customerId":"fixture"}))
        .await
        .unwrap();
    fn ordered(value: &Value, path: &str) -> Value {
        match value {
            Value::Array(values) => {
                let mut values: Vec<Value> = values
                    .iter()
                    .map(|v| ordered(v, &format!("{path}/[]")))
                    .collect();
                let records = matches!(
                    path,
                    "/grants"
                        | "/positions"
                        | "/subscriptions"
                        | "/entities"
                        | "/reservations"
                        | "/licenses"
                        | "/quantities"
                        | "/policyCounters"
                ) || (path.starts_with("/archive/")
                    && path.matches('/').count() == 2);
                if records {
                    values.sort_by_key(|v| {
                        v.get("id")
                            .or_else(|| v.get("grantId"))
                            .unwrap()
                            .to_string()
                    });
                }
                json!(values)
            }
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), ordered(v, &format!("{path}/{k}"))))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    assert_eq!(
        ordered(&exported, ""),
        ordered(&fixture["snapshot"], ""),
        "full migration archive execution parity"
    );
    billing.close().await.unwrap();
}
#[tokio::test]
async fn native_concurrent_spending_and_reservations_cannot_overspend() {
    let billing = setup().await;
    billing
        .call(
            "customers.create",
            json!({"id":"concurrent","idempotencyKey":"create"}),
        )
        .await
        .unwrap();
    billing.call("credits.grant",json!({"customerId":"concurrent","feature":"budget","amount":"10","idempotencyKey":"fund"})).await.unwrap();
    let mut jobs = Vec::new();
    for i in 0..40 {
        let billing = billing.clone();
        jobs.push(tokio::spawn(async move{
        billing.call(if i%2==0{"usage.consume"}else{"reservations.create"},json!({"customerId":"concurrent","feature":"budget","amount":"1","idempotencyKey":format!("op-{i}")})).await
    }));
    }
    let mut winners = 0;
    for job in jobs {
        match job.await.unwrap() {
            Ok(_) => winners += 1,
            Err(e) => assert_eq!(e.code, "insufficient_balance"),
        }
    }
    assert_eq!(winners, 10);
    let balance = billing
        .call(
            "credits.balance",
            json!({"customerId":"concurrent","feature":"budget"}),
        )
        .await
        .unwrap();
    assert_eq!(balance["available"], "0");
    assert_eq!(
        billing
            .call("credits.reconcile", json!({"customerId":"concurrent"}))
            .await
            .unwrap()["consistent"],
        true
    );
    billing.close().await.unwrap();
}

#[tokio::test]
async fn native_domain_execution_matches_legacy_receipts() {
    legacy_receipts(setup().await).await;
}

#[cfg(feature = "postgres")]
#[tokio::test]
async fn postgres_native_domain_matches_legacy_receipts() {
    let Ok(url) = std::env::var("TEST_POSTGRES_URL") else {
        eprintln!("PostgreSQL domain parity not qualified: TEST_POSTGRES_URL missing");
        return;
    };
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    let schema = format!("engine_{}", uuid::Uuid::new_v4().simple());
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&pool)
        .await
        .unwrap();
    let isolated_schema = schema.clone();
    let isolated = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |c, _| {
            let q = format!("SET search_path TO {isolated_schema}");
            Box::pin(async move {
                sqlx::raw_sql(sqlx::AssertSqlSafe(q)).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    for sql in brokeboy_core::schema::migration_sql(brokeboy_core::schema::Dialect::Postgres) {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&isolated)
            .await
            .unwrap();
    }
    legacy_receipts(Billing::from_storage(
        Arc::new(SqlStorage::owned(isolated)),
        BillingOptions {
            clock: Arc::new(FixedClock(1_769_862_896_789)),
            identifiers: Arc::new(SequentialIds(AtomicU64::new(0))),
            ..Default::default()
        },
    ))
    .await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

#[cfg(feature = "mysql")]
#[tokio::test]
async fn mysql_native_domain_matches_legacy_receipts() {
    use std::str::FromStr;
    let Ok(url) = std::env::var("TEST_MYSQL_URL") else {
        eprintln!("MySQL domain parity not qualified: TEST_MYSQL_URL missing");
        return;
    };
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    let database = format!("engine_{}", uuid::Uuid::new_v4().simple());
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {database}")))
        .execute(&pool)
        .await
        .unwrap();
    let options = sqlx::mysql::MySqlConnectOptions::from_str(&url)
        .unwrap()
        .database(&database);
    let isolated = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .unwrap();
    for sql in brokeboy_core::schema::migration_sql(brokeboy_core::schema::Dialect::Mysql) {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&isolated)
            .await
            .unwrap();
    }
    legacy_receipts(Billing::from_storage(
        Arc::new(SqlStorage::owned(isolated)),
        BillingOptions {
            clock: Arc::new(FixedClock(1_769_862_896_789)),
            identifiers: Arc::new(SequentialIds(AtomicU64::new(0))),
            ..Default::default()
        },
    ))
    .await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP DATABASE {database}")))
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
