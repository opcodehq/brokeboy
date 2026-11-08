//! Run with `cargo run -p brokeboy --features sqlite --example streaming`.
//! The injectable demo clock advances an hour without leaving a timer running.
use brokeboy::{Billing, BillingOptions, sql::SqlStorage, storage::Clock};
use brokeboy_core::{
    Result,
    schema::{Dialect, migration_sql},
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
struct DemoClock(AtomicI64);
impl Clock for DemoClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:")
        .await
        .expect("demo database");
    for statement in migration_sql(Dialect::Sqlite) {
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .execute(&pool)
            .await
            .expect("explicit demo migration");
    }
    let clock = Arc::new(DemoClock(AtomicI64::new(1_800_000_000_000)));
    let billing = Billing::from_storage(
        Arc::new(SqlStorage::owned(pool)),
        BillingOptions {
            clock: clock.clone(),
            ..Default::default()
        },
    );
    billing
        .customers()
        .create(json!({"id":"customer","idempotencyKey":"create"}))
        .await?;
    // In production this grant comes from verified payment or an opening-balance import.
    billing.credits().grant(json!({"customerId":"customer","feature":"wallet","amount":"5","idempotencyKey":"demo-funding"})).await?;
    let request=billing.reservations().create(json!({"customerId":"customer","feature":"wallet","amount":"0.03","expiresAt":clock.now()+3_600_000,"onExpiry":"settle_estimate","idempotencyKey":"request-1"})).await?;
    let settlement = json!({"customerId":"customer","reservationId":request.id,"amount":"0.025","idempotencyKey":"request-1-close"});
    billing.reservations().settle(settlement.clone()).await?;
    billing.reservations().settle(settlement).await?; // Identical receipt, no second debit.
    billing.reservations().create(json!({"customerId":"customer","feature":"wallet","amount":"0.03","expiresAt":clock.now()+3_600_000,"onExpiry":"settle_estimate","idempotencyKey":"abandoned-request"})).await?;
    clock.0.fetch_add(3_600_001, Ordering::SeqCst);
    billing
        .maintenance()
        .run(json!({"customerId":"customer","limit":100}))
        .await?;
    let balance = billing
        .credits()
        .balance(json!({"customerId":"customer","feature":"wallet"}))
        .await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&balance).expect("serializable balance")
    );
    billing.close().await
}
