//! Async native billing bindings. Distribution remains gated on release qualification.
use brokeboy::lifecycle::Lifecycle;
use brokeboy::sql::SqlStorage;
use brokeboy::storage::Storage;
use napi_derive::napi;
use std::sync::Arc;
mod billing;

#[napi]
pub fn validate_catalog(input: String) -> napi::Result<()> {
    let value =
        serde_json::from_str(&input).map_err(|_| napi::Error::from_reason("invalid_catalog"))?;
    brokeboy::catalog::validate_catalog(&value).map_err(native_error)
}

#[napi]
pub fn rate_usage(rate: String, quantity: String, properties: String) -> napi::Result<String> {
    let rate: brokeboy_core::pricing::Rate =
        serde_json::from_str(&rate).map_err(|_| napi::Error::from_reason("invalid_rate"))?;
    let properties = serde_json::from_str(&properties)
        .map_err(|_| napi::Error::from_reason("invalid_properties"))?;
    let quantity = quantity.parse().map_err(native_error)?;
    rate.rate(quantity, &properties)
        .map(|v| v.to_string())
        .map_err(native_error)
}
#[napi]
pub fn add_interval(start: f64, interval: String, count: f64) -> napi::Result<f64> {
    if !start.is_finite()
        || start.fract() != 0.0
        || !(0.0..=9_007_199_254_740_991.0).contains(&start)
        || !count.is_finite()
        || count.fract() != 0.0
        || !(0.0..=u32::MAX as f64).contains(&count)
    {
        return Err(napi::Error::from_reason("invalid_timestamp"));
    }
    let interval = serde_json::from_value(serde_json::json!(interval))
        .map_err(|_| napi::Error::from_reason("invalid_interval"))?;
    brokeboy_core::pricing::add_interval(start as i64, interval, count as u32)
        .map(|v| v as f64)
        .map_err(native_error)
}

fn native_error(error: brokeboy_core::BillingError) -> napi::Error {
    napi::Error::from_reason(
        serde_json::to_string(&error).unwrap_or_else(|_| "billing_error".into()),
    )
}

#[napi]
pub fn canonical_hash_v1(raw_json: String) -> napi::Result<String> {
    let value =
        serde_json::from_str(&raw_json).map_err(|_| napi::Error::from_reason("invalid_json"))?;
    brokeboy_core::compatibility::hash_v1(&value).map_err(native_error)
}

#[napi]
pub struct NativeStorageProbe {
    storage: Arc<SqlStorage<sqlx::Sqlite>>,
    lifecycle: Lifecycle,
}

#[napi]
impl NativeStorageProbe {
    /// Opens an existing migrated database. Startup never creates billing tables.
    #[napi(factory)]
    pub async fn open(url: String) -> napi::Result<Self> {
        use std::str::FromStr;
        let options = sqlx::sqlite::SqliteConnectOptions::from_str(&url)
            .map_err(|_| napi::Error::from_reason("invalid_database_configuration"))?
            .create_if_missing(false)
            .busy_timeout(std::time::Duration::from_secs(5));
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .map_err(|_| napi::Error::from_reason("storage_error"))?;
        Ok(Self {
            storage: Arc::new(SqlStorage::owned(pool)),
            lifecycle: Lifecycle::default(),
        })
    }

    #[napi]
    pub fn register_request(&self, id: String) -> napi::Result<()> {
        self.lifecycle.register(&id).map_err(native_error)
    }

    #[napi]
    pub fn cancel_request(&self, id: String) -> bool {
        self.lifecycle.cancel(&id)
    }

    #[napi]
    pub async fn inspect_customer(
        &self,
        scope: String,
        id: String,
        request_id: String,
    ) -> napi::Result<Option<String>> {
        let request = self.lifecycle.start(&request_id).map_err(native_error)?;
        request.check().map_err(native_error)?;
        let mut tx = self.storage.begin(&scope).await.map_err(native_error)?;
        if let Err(error) = request.check() {
            tx.rollback().await.map_err(native_error)?;
            return Err(native_error(error));
        }
        let result = tx.get(brokeboy_core::records::Table::Customers, &id).await;
        tx.rollback().await.map_err(native_error)?;
        request.check().map_err(native_error)?;
        result
            .map(|row| row.map(|r| r.data.to_string()))
            .map_err(native_error)
    }

    #[napi]
    pub async fn close(&self) -> napi::Result<()> {
        self.lifecycle.shutdown().await;
        self.storage.close().await.map_err(native_error)
    }
}
