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
    fn link_customer(
        &self,
        _provider: String,
        _id: String,
        _customer: String,
    ) -> BillingFuture<'_, ()> {
        Box::pin(async { Err(BillingError::new("customer_link_registry_required")) })
    }
}
pub struct PaymentCommand {
    pub id: String,
    pub kind: String,
    pub customer: Value,
    pub input: Value,
    pub resources: Arc<dyn ResourceRegistry>,
}
pub trait PaymentProvider: Send + Sync {
    /// Whether this processor can refresh subscriptions before an automatic purchase.
    fn supports_customer_refresh(&self, _provider: &str) -> bool {
        false
    }
    /// Stable adapter identity; this accessor must perform no I/O.
    fn provider_id(&self) -> &str {
        "custom"
    }
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

/// Explicit routing for applications retaining subscriptions with multiple processors.
/// Queued commands carry their selected processor, independent of later default changes.
pub struct Providers {
    default: String,
    providers: BTreeMap<String, Arc<dyn PaymentProvider>>,
}
impl Providers {
    pub fn new(
        default: String,
        providers: Vec<Arc<dyn PaymentProvider>>,
    ) -> Result<Self, BillingError> {
        let mut registered = BTreeMap::new();
        for provider in providers {
            let id = provider.provider_id().to_owned();
            if registered.insert(id, provider).is_some() {
                return Err(BillingError::new("duplicate_payment_provider"));
            }
        }
        if !registered.contains_key(&default) {
            return Err(BillingError::new("provider_missing"));
        }
        Ok(Self {
            default,
            providers: registered,
        })
    }
    fn get(&self, id: &str) -> Result<&Arc<dyn PaymentProvider>, BillingError> {
        self.providers
            .get(id)
            .ok_or_else(|| BillingError::new("provider_missing"))
    }
}
impl PaymentProvider for Providers {
    fn supports_customer_refresh(&self, provider: &str) -> bool {
        self.providers
            .get(provider)
            .is_some_and(|p| p.supports_customer_refresh(provider))
    }
    fn provider_id(&self) -> &str {
        &self.default
    }
    fn close(&self) -> BillingFuture<'_, ()> {
        Box::pin(async move {
            for provider in self.providers.values() {
                provider.close().await?;
            }
            Ok(())
        })
    }
    fn execute(&self, command: PaymentCommand) -> BillingFuture<'_, Value> {
        Box::pin(async move {
            let id = command.input["provider"].as_str().unwrap_or(&self.default);
            self.get(id)?.execute(command).await
        })
    }
    fn verify(
        &self,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> BillingFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move {
            let stripe = headers
                .keys()
                .any(|k| k.eq_ignore_ascii_case("stripe-signature"));
            let polar = headers
                .keys()
                .any(|k| k.eq_ignore_ascii_case("webhook-signature"));
            let id = match (stripe, polar) {
                (true, false) => "stripe",
                (false, true) => "polar",
                _ => return Err(BillingError::new("ambiguous_webhook_provider")),
            };
            let mut event = self.get(id)?.verify(headers, body).await?;
            if let Some(event) = &mut event {
                event.data["provider"] = Value::String(id.into());
            }
            Ok(event)
        })
    }
    fn reconcile(&self, event: ProviderEvent) -> BillingFuture<'_, ProviderEvent> {
        Box::pin(async move {
            let id = event.data["provider"]
                .as_str()
                .ok_or_else(|| BillingError::new("provider_missing"))?;
            self.get(id)?.reconcile(event).await
        })
    }
    fn verify_resource(&self, key: String, id: String) -> BillingFuture<'_, ()> {
        Box::pin(async move { self.get(&self.default)?.verify_resource(key, id).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Named(&'static str);
    impl PaymentProvider for Named {
        fn provider_id(&self) -> &str {
            self.0
        }
        fn execute(&self, _: PaymentCommand) -> BillingFuture<'_, Value> {
            Box::pin(async move { Ok(serde_json::json!({"processor":self.0})) })
        }
        fn verify(
            &self,
            _: BTreeMap<String, String>,
            body: Vec<u8>,
        ) -> BillingFuture<'_, Option<ProviderEvent>> {
            Box::pin(async move { Ok(Some(serde_json::from_slice(&body).unwrap())) })
        }
        fn reconcile(&self, mut event: ProviderEvent) -> BillingFuture<'_, ProviderEvent> {
            Box::pin(async move {
                event.data["canonicalProcessor"] = Value::String(self.0.into());
                Ok(event)
            })
        }
    }
    struct Registry;
    impl ResourceRegistry for Registry {
        fn get_or_create(&self, _: String, _: ResourceFactory) -> BillingFuture<'_, String> {
            Box::pin(async { panic!("fixture creates no resources") })
        }
    }
    #[tokio::test]
    async fn durable_commands_and_notifications_route_to_their_original_processor() {
        let providers = Providers::new(
            "polar".into(),
            vec![Arc::new(Named("stripe")), Arc::new(Named("polar"))],
        )
        .unwrap();
        let command = PaymentCommand {
            id: "durable-command".into(),
            kind: "checkout".into(),
            customer: serde_json::json!({"id":"customer"}),
            input: serde_json::json!({"provider":"stripe"}),
            resources: Arc::new(Registry),
        };
        assert_eq!(
            providers.execute(command).await.unwrap()["processor"],
            "stripe"
        );
        let body=serde_json::to_vec(&serde_json::json!({"id":"event","type":"subscription.updated","customerId":"customer","data":{}})).unwrap();
        let event = providers
            .verify(
                BTreeMap::from([("stripe-signature".into(), "fixture".into())]),
                body.clone(),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.data["provider"], "stripe");
        assert_eq!(
            providers.reconcile(event).await.unwrap().data["canonicalProcessor"],
            "stripe"
        );
        assert_eq!(
            providers
                .verify(
                    BTreeMap::from([
                        ("stripe-signature".into(), "fixture".into()),
                        ("webhook-signature".into(), "fixture".into())
                    ]),
                    body
                )
                .await
                .unwrap_err()
                .code,
            "ambiguous_webhook_provider"
        );
    }
}
