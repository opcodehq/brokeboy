#![cfg(any(feature = "sqlite", feature = "postgres", feature = "mysql"))]
use brokeboy::{
    sql::SqlStorage,
    storage::{PageQuery, Storage},
};
use brokeboy_core::records::{Row, Table};
use serde_json::{Value, json};
use std::sync::Arc;

fn row(id: &str, data: Value) -> Row {
    Row {
        id: id.into(),
        state: "active".into(),
        data,
        extra: Default::default(),
    }
}

async fn contract(storage: Arc<dyn Storage>, scope: String, dialect: &str, database: &str) {
    let mut tx = storage.begin(&scope).await.unwrap();
    tx.put(
        Table::Customers,
        row(
            "customer",
            json!({"id":"customer", "future":{"v":2}, "amount":"1.00"}),
        ),
    )
    .await
    .unwrap();
    tx.put(Table::Counters, row("count", json!({"count":0})))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // Changes and newly inserted rows must both roll back.
    let mut tx = storage.begin(&scope).await.unwrap();
    tx.put(Table::Counters, row("count", json!({"count":999})))
        .await
        .unwrap();
    tx.put(Table::Customers, row("discarded", json!({})))
        .await
        .unwrap();
    tx.rollback().await.unwrap();

    // Dropping an unfinished transaction quarantines its connection.
    let mut tx = storage.begin(&scope).await.unwrap();
    tx.put(Table::Counters, row("count", json!({"count":888})))
        .await
        .unwrap();
    drop(tx);

    let mut jobs = Vec::new();
    for _ in 0..40 {
        let storage = storage.clone();
        let scope = scope.clone();
        jobs.push(tokio::spawn(async move {
            let mut tx = storage.begin(&scope).await.unwrap();
            let current = tx
                .get(Table::Counters, "count")
                .await
                .unwrap()
                .unwrap()
                .data["count"]
                .as_u64()
                .unwrap();
            tokio::task::yield_now().await;
            tx.put(Table::Counters, row("count", json!({"count":current + 1})))
                .await
                .unwrap();
            tx.commit().await.unwrap();
        }));
    }
    for job in jobs {
        job.await.unwrap();
    }
    let mut tx = storage.begin(&scope).await.unwrap();
    assert_eq!(
        tx.get(Table::Counters, "count")
            .await
            .unwrap()
            .unwrap()
            .data["count"],
        40
    );
    assert!(
        tx.get(Table::Customers, "discarded")
            .await
            .unwrap()
            .is_none()
    );
    let customer = tx.get(Table::Customers, "customer").await.unwrap().unwrap();
    assert_eq!(customer.data["amount"], "1.00");
    assert_eq!(customer.data["future"]["v"], 2);
    let page = tx
        .page(
            Table::Customers,
            PageQuery {
                limit: 2,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
    let mut work = row("w", json!({"availableAt":1, "leaseUntil":10}));
    work.state = "processing".into();
    tx.put(Table::Work, work).await.unwrap();
    assert!(
        tx.page(
            Table::Work,
            PageQuery {
                limit: 2,
                due_before: Some(9),
                ..Default::default()
            }
        )
        .await
        .unwrap()
        .is_empty()
    );
    assert_eq!(
        tx.page(
            Table::Work,
            PageQuery {
                limit: 2,
                due_before: Some(10),
                ..Default::default()
            }
        )
        .await
        .unwrap()
        .len(),
        1
    );
    tx.commit().await.unwrap();
    let mut isolated = storage.begin(&format!("{scope}:other")).await.unwrap();
    assert!(
        isolated
            .get(Table::Customers, "customer")
            .await
            .unwrap()
            .is_none()
    );
    isolated.rollback().await.unwrap();
    assert_eq!(
        storage.scopes(None, 1, &scope).await.unwrap(),
        vec![scope.clone()]
    );
    mixed_process_writers(storage.clone(), &scope, dialect, database).await;
    if dialect != "sqlite" {
        let a = storage.begin(&scope).await.unwrap();
        let b = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            storage.begin(&format!("{scope}:other")),
        )
        .await
        .unwrap()
        .unwrap();
        b.rollback().await.unwrap();
        a.rollback().await.unwrap();
    }
    replay_legacy_archive(storage.clone()).await;
    storage.close().await.unwrap();
    assert!(storage.begin(&scope).await.is_err());
}

async fn mixed_process_writers(
    storage: Arc<dyn Storage>,
    scope: &str,
    dialect: &str,
    database: &str,
) {
    let mut tx = storage.begin(scope).await.unwrap();
    tx.put(Table::Counters, row("mixed-writers", json!({"count":0})))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/legacy-storage-writer.ts");
    let child = std::process::Command::new("bun")
        .arg(script)
        .arg(dialect)
        .arg(scope)
        .env("BROKEBOY_CONTRACT_DATABASE", database)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let waiting = tokio::task::spawn_blocking(move || child.wait_with_output().unwrap());
    for _ in 0..20 {
        let mut tx = storage.begin(scope).await.unwrap();
        let count = tx
            .get(Table::Counters, "mixed-writers")
            .await
            .unwrap()
            .unwrap()
            .data["count"]
            .as_u64()
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        tx.put(
            Table::Counters,
            row("mixed-writers", json!({"count":count + 1})),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
    let output = waiting.await.unwrap();
    assert!(
        output.status.success(),
        "legacy writer: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut tx = storage.begin(scope).await.unwrap();
    assert_eq!(
        tx.get(Table::Counters, "mixed-writers")
            .await
            .unwrap()
            .unwrap()
            .data["count"],
        40
    );
    tx.rollback().await.unwrap();
}

struct FixedClock;
impl brokeboy::storage::Clock for FixedClock {
    fn now(&self) -> i64 {
        1_800_000_000_000
    }
}

async fn replay_legacy_archive(storage: Arc<dyn Storage>) {
    use brokeboy::operations::{Environment, Operations, WriteScope};
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/compatibility/engine-v1.json"
    ))
    .unwrap();
    for group in fixture["records"].as_array().unwrap() {
        let scope = group["scope"].as_str().unwrap();
        let table: Table = serde_json::from_value(group["table"].clone()).unwrap();
        let mut tx = storage.begin(scope).await.unwrap();
        for raw in group["rows"].as_array().unwrap() {
            tx.put(table, serde_json::from_value(raw.clone()).unwrap())
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
    }
    let operations = Operations::new(storage.clone(), Arc::new(FixedClock), Environment::Test);
    for trace in fixture["traces"].as_array().unwrap() {
        let key = trace["input"]["idempotencyKey"].as_str().unwrap();
        let result = operations
            .write(
                WriteScope {
                    customer_id: "fixture",
                    entity_id: None,
                    idempotency_key: key,
                },
                trace["method"].as_str().unwrap(),
                &trace["input"],
                false,
                None,
                |_, _| {
                    Box::pin(async { panic!("a legacy retry must not rerun its domain action") })
                },
            )
            .await
            .unwrap();
        assert_eq!(result, trace["result"], "replaying {}", trace["method"]);
    }
    let mut altered = fixture["traces"][0]["input"].clone();
    altered["metadata"]["changed"] = json!("conflict");
    let error = operations
        .write(
            WriteScope {
                customer_id: "fixture",
                entity_id: None,
                idempotency_key: "create",
            },
            "customers.create",
            &altered,
            true,
            None,
            |_, _| Box::pin(async { panic!("conflicting retries must not execute") }),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "idempotency_conflict");

    // A failed operation must not leave either its mutation or a replay result.
    let error = operations
        .write(
            WriteScope {
                customer_id: "fixture",
                entity_id: None,
                idempotency_key: "failed-rust-op",
            },
            "test.rollback",
            &json!({}),
            false,
            None,
            |tx, _| {
                Box::pin(async move {
                    tx.put(Table::Counters, row("rollback-probe", json!({"value":1})))
                        .await?;
                    Err(brokeboy_core::BillingError::new("intentional_failure"))
                })
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "intentional_failure");
    let lifecycle = brokeboy::lifecycle::Lifecycle::default();
    lifecycle.register("cancel-operation").unwrap();
    let request = lifecycle.start("cancel-operation").unwrap();
    let cancellation = lifecycle.clone();
    let error = operations
        .write(
            WriteScope {
                customer_id: "fixture",
                entity_id: None,
                idempotency_key: "cancel-rust-op",
            },
            "test.cancel",
            &json!({}),
            false,
            Some(&request),
            move |tx, _| {
                Box::pin(async move {
                    tx.put(Table::Counters, row("cancel-probe", json!({"value":1})))
                        .await?;
                    cancellation.cancel("cancel-operation");
                    Ok(json!({"value":1}))
                })
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "interrupted");
    drop(request);
    let mut tx = storage.begin("test:c:fixture").await.unwrap();
    assert!(
        tx.get(Table::Counters, "rollback-probe")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        tx.get(Table::Operations, "failed-rust-op")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        tx.get(Table::Counters, "cancel-probe")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        tx.get(Table::Operations, "cancel-rust-op")
            .await
            .unwrap()
            .is_none()
    );
    tx.rollback().await.unwrap();
}

fn statements(dialect: &str) -> Vec<String> {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../test/fixtures/compatibility/v1.json")).unwrap();
    fixture["schema"][dialect]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().into())
        .collect()
}

#[cfg(feature = "sqlite")]
#[tokio::test]
async fn sqlite_contract_and_borrowed_pool_ownership() {
    let path = std::env::temp_dir().join(format!("brokeboy-rust-{}.sqlite", std::process::id()));
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .busy_timeout(std::time::Duration::from_secs(15));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .unwrap();
    for sql in statements("sqlite") {
        sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
            .execute(&pool)
            .await
            .unwrap();
    }
    contract(
        Arc::new(SqlStorage::borrowed(pool.clone())),
        "test:c:rust-sqlite-contract".into(),
        "sqlite",
        path.to_str().unwrap(),
    )
    .await;
    assert!(!pool.is_closed());
    sqlx::query("SELECT 1").execute(&pool).await.unwrap();
    let owned = SqlStorage::owned(pool.clone());
    owned.close().await.unwrap();
    assert!(pool.is_closed());
    std::fs::remove_file(path).unwrap();
}

#[cfg(feature = "postgres")]
#[tokio::test]
async fn postgres_contract() {
    let Ok(url) = std::env::var("TEST_POSTGRES_URL") else {
        eprintln!("TEST_POSTGRES_URL absent; PostgreSQL integration not qualified");
        return;
    };
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    for sql in statements("postgres") {
        sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
            .execute(&pool)
            .await
            .unwrap();
    }
    contract(
        Arc::new(SqlStorage::borrowed(pool.clone())),
        format!("test:c:rust-pg-{}", std::process::id()),
        "postgres",
        &url,
    )
    .await;
    assert!(!pool.is_closed());
    pool.close().await;
}

#[cfg(feature = "mysql")]
#[tokio::test]
async fn mysql_contract() {
    let Ok(url) = std::env::var("TEST_MYSQL_URL") else {
        eprintln!("TEST_MYSQL_URL absent; MySQL integration not qualified");
        return;
    };
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    for sql in statements("mysql") {
        sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
            .execute(&pool)
            .await
            .unwrap();
    }
    contract(
        Arc::new(SqlStorage::borrowed(pool.clone())),
        format!("test:c:rust-mysql-{}", std::process::id()),
        "mysql",
        &url,
    )
    .await;
    assert!(!pool.is_closed());
    pool.close().await;
}
