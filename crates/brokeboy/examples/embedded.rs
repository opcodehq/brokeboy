//! Run after applying the explicit SQLite schema, with BROKEBOY_DATABASE_URL set.
//! cargo run -p brokeboy --features sqlite --example embedded
use brokeboy::{
    Billing, BillingOptions,
    core::models::{DatabaseConnection, Environment, OpenConfig},
    core::schema::Dialect,
};
use serde_json::json;
#[tokio::main]
async fn main() -> brokeboy::core::Result<()> {
    let url = std::env::var("BROKEBOY_DATABASE_URL").map_err(|_| {
        brokeboy::core::BillingError::message(
            "configuration_required",
            "Set BROKEBOY_DATABASE_URL to an existing migrated SQLite database.",
        )
    })?;
    let billing = Billing::open_config(
        OpenConfig {
            database: DatabaseConnection {
                driver: Dialect::Sqlite,
                url,
                max_connections: Some(1),
                acquire_timeout_ms: None,
            },
            environment: Some(Environment::Test),
            stripe: None,
        },
        BillingOptions::default(),
    )
    .await?;
    let result = async {
        billing.customers().create(json!({"id":"rust-example","idempotencyKey":"create"})).await?;
        billing.credits().grant(json!({"customerId":"rust-example","feature":"requests","amount":"10","idempotencyKey":"fund"})).await?;
        let receipt = billing.usage().consume(json!({"customerId":"rust-example","feature":"requests","amount":"1.25","idempotencyKey":"request-1"})).await?;
        println!("{}", serde_json::to_string_pretty(&receipt).unwrap());
        Ok(())
    }.await;
    let closed = billing.close().await;
    result.and(closed)
}
