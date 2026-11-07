//! Payment boundary. Provider I/O is never invoked while a billing transaction is held.
use crate::storage::BillingFuture;
use brokeboy_core::BillingError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub customer_id: String,
    pub data: Value,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
pub type ResourceFactory = Arc<dyn Fn(String) -> BillingFuture<'static, String> + Send + Sync>;
pub trait ResourceRegistry: Send + Sync {
    fn get_or_create(&self, key: String, create: ResourceFactory) -> BillingFuture<'_, String>;
}
pub struct PaymentCommand {
    pub id: String,
    pub kind: String,
    pub customer: Value,
    pub input: Value,
    pub resources: Arc<dyn ResourceRegistry>,
}
pub trait PaymentProvider: Send + Sync {
    fn close(&self) -> BillingFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn execute(&self, command: PaymentCommand) -> BillingFuture<'_, Value>;
    fn verify(
        &self,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> BillingFuture<'_, Option<ProviderEvent>>;
    fn reconcile(&self, event: ProviderEvent) -> BillingFuture<'_, ProviderEvent>;
    fn verify_resource(&self, _key: String, _id: String) -> BillingFuture<'_, ()> {
        Box::pin(async { Err(BillingError::new("resource_verification_unavailable")) })
    }
}
