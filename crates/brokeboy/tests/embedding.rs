#![cfg(feature = "postgres")]
use brokeboy::{
    Billing, BillingOptions,
    sql::{DatabaseConfig, Driver},
};
use brokeboy_core::schema::{Dialect, migration_sql};
use serde_json::json;

#[tokio::test]
async fn owned_pool_preserves_application_tables_in_a_shared_database() {
    let Ok(base) = std::env::var("TEST_POSTGRES_URL") else {
        eprintln!("TEST_POSTGRES_URL missing; embedding not qualified");
        return;
    };
    let host = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("embedding_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&host)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "CREATE TABLE {schema}.host_documents(id text PRIMARY KEY, body text NOT NULL)"
    )))
    .execute(&host)
    .await
    .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO {schema}.host_documents VALUES('sentinel','application-owned')"
    )))
    .execute(&host)
    .await
    .unwrap();
    let mut url = url::Url::parse(&base).unwrap();
    url.query_pairs_mut()
        .append_pair("options", &format!("-csearch_path={schema}"));
    let migration = sqlx::PgPool::connect(url.as_str()).await.unwrap();
    for sql in migration_sql(Dialect::Postgres) {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&migration)
            .await
            .unwrap();
    }
    migration.close().await;
    let billing = Billing::open(
        DatabaseConfig {
            driver: Driver::Postgres,
            url: url.into(),
            max_connections: Some(2),
            acquire_timeout_ms: Some(5000),
        },
        BillingOptions::default(),
    )
    .await
    .unwrap();
    billing
        .customers()
        .create(json!({"id":"embedded","idempotencyKey":"create"}))
        .await
        .unwrap();
    billing.credits().grant(json!({"customerId":"embedded","feature":"wallet","amount":"10","idempotencyKey":"fund"})).await.unwrap();
    let input =
        json!({"customerId":"embedded","feature":"wallet","amount":"1","idempotencyKey":"usage"});
    let receipt = billing.usage().consume(input.clone()).await.unwrap();
    assert_eq!(billing.usage().consume(input).await.unwrap().id, receipt.id);
    billing.close().await.unwrap();
    let body: String = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT body FROM {schema}.host_documents WHERE id='sentinel'"
    )))
    .fetch_one(&host)
    .await
    .unwrap();
    assert_eq!(body, "application-owned");
    assert!(!host.is_closed());
    sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
        .execute(&host)
        .await
        .unwrap();
    host.close().await;
}
