//! Targeted Stripe HTTP adapter. No Stripe SDK types leak into Brokeboy's API.
use crate::{
    engine::SystemClock,
    operations::Environment,
    provider::{PaymentCommand, PaymentProvider, ProviderEvent, ResourceRegistry},
    storage::{BillingFuture, Clock},
    wire::*,
};
use brokeboy_core::{BillingError, Result, compatibility::hash_v1, decimal::Decimal};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
mod commerce;
mod events;
mod subscriptions;
pub const API_VERSION: &str = "2026-09-30.endive";
pub struct StripeOptions {
    pub secret_key: String,
    pub webhook_secret: String,
    pub environment: Environment,
    pub api_base: String,
    pub clock: Arc<dyn Clock>,
}
impl StripeOptions {
    pub fn new(secret_key: String, webhook_secret: String) -> Self {
        Self {
            secret_key,
            webhook_secret,
            environment: Environment::Test,
            api_base: "https://api.stripe.com/v1".into(),
            clock: Arc::new(SystemClock),
        }
    }
}
struct Inner {
    client: std::sync::Mutex<Option<reqwest::Client>>,
    options: StripeOptions,
}
#[derive(Clone)]
pub struct Stripe(Arc<Inner>);
fn provider_error() -> BillingError {
    BillingError::message(
        "provider_error",
        "Stripe request failed. Inspect the operation and provider request ID before retrying.",
    )
}
fn path(collection: &str, id: &str) -> Result<String> {
    require(
        !id.is_empty()
            && id.len() <= 255
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
        "invalid_provider_id",
    )?;
    Ok(format!("{collection}/{id}"))
}
fn resource_id(value: &Value) -> Option<&str> {
    value.as_str().or_else(|| opt(value, "id"))
}
fn minor(amount: &str, currency: &str) -> Result<String> {
    let value = amount.parse::<Decimal>()?.minor_units(currency)?;
    let n = value
        .parse::<i128>()
        .map_err(|_| BillingError::new("provider_amount_overflow"))?;
    require(n <= 9_007_199_254_740_991, "provider_amount_overflow")?;
    Ok(value)
}
fn form(prefix: &str, value: &Value, result: &mut Vec<(String, String)>) {
    match value {
        Value::Null => {}
        Value::Object(map) => {
            for (k, v) in map {
                form(
                    &if prefix.is_empty() {
                        k.clone()
                    } else {
                        format!("{prefix}[{k}]")
                    },
                    v,
                    result,
                )
            }
        }
        Value::Array(values) => {
            for (i, v) in values.iter().enumerate() {
                form(&format!("{prefix}[{i}]"), v, result)
            }
        }
        Value::String(v) => result.push((prefix.into(), v.clone())),
        _ => result.push((prefix.into(), value.to_string())),
    }
}
impl Stripe {
    pub fn new(options: StripeOptions) -> Result<Self> {
        require(
            (options.secret_key.starts_with("sk_test_")
                && matches!(options.environment, Environment::Test))
                || (options.secret_key.starts_with("sk_live_")
                    && matches!(options.environment, Environment::Live)),
            "environment_mismatch",
        )?;
        let base = url::Url::parse(&options.api_base)
            .map_err(|_| BillingError::new("invalid_provider_configuration"))?;
        require(
            base.scheme() == "https"
                || (base.scheme() == "http"
                    && matches!(base.host_str(), Some("localhost" | "127.0.0.1"))),
            "invalid_provider_configuration",
        )?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| provider_error())?;
        Ok(Self(Arc::new(Inner {
            client: std::sync::Mutex::new(Some(client)),
            options,
        })))
    }
    async fn request(
        &self,
        method: reqwest::Method,
        endpoint: &str,
        parameters: Value,
        key: Option<&str>,
    ) -> Result<Value> {
        let mut values = Vec::new();
        let client = self
            .0
            .client
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| BillingError::new("provider_closed"))?;
        form("", &parameters, &mut values);
        for attempt in 0..2 {
            let url = format!(
                "{}/{}",
                self.0.options.api_base.trim_end_matches('/'),
                endpoint
            );
            let mut request = client
                .request(method.clone(), url)
                .bearer_auth(&self.0.options.secret_key)
                .header("Stripe-Version", API_VERSION);
            if let Some(key) = key {
                request = request.header("Idempotency-Key", key);
            }
            request = if method == reqwest::Method::GET {
                request.query(&values)
            } else {
                request.form(&values)
            };
            let mut response = match request.send().await {
                Ok(v) => v,
                Err(_) => {
                    if attempt == 0 && key.is_some() {
                        continue;
                    }
                    return Err(provider_error());
                }
            };
            let status = response.status();
            let request_id = response
                .headers()
                .get("request-id")
                .and_then(|v| v.to_str().ok())
                .filter(|v| {
                    v.len() <= 255 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                })
                .map(str::to_owned);
            if !status.is_success() {
                if attempt == 0
                    && key.is_some()
                    && (status.is_server_error() || status.as_u16() == 429)
                {
                    continue;
                }
                let mut error = provider_error();
                error.details = Some(json!({"status":status.as_u16(),"requestId":request_id}));
                return Err(error);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| provider_error())? {
                require(
                    chunk.len() <= 8 * 1024 * 1024 - bytes.len(),
                    "provider_response_too_large",
                )?;
                bytes.extend_from_slice(&chunk);
            }
            return serde_json::from_slice(&bytes).map_err(|_| provider_error());
        }
        Err(provider_error())
    }
    async fn get(&self, endpoint: &str, parameters: Value) -> Result<Value> {
        self.request(reqwest::Method::GET, endpoint, parameters, None)
            .await
    }
    async fn post(&self, endpoint: &str, parameters: Value, key: &str) -> Result<Value> {
        self.request(reqwest::Method::POST, endpoint, parameters, Some(key))
            .await
    }
    fn metadata(
        &self,
        customer: &str,
        plan: Option<&Value>,
        entity: Option<&str>,
    ) -> Result<Value> {
        let mut m = json!({"brokeboy_customer":customer,"brokeboy_environment":self.0.options.environment.name()});
        if let Some(plan) = plan {
            m["brokeboy_plan"] = plan["id"].clone();
            m["brokeboy_version"] = plan["version"].clone();
        }
        if let Some(entity) = entity {
            m["brokeboy_entity"] = json!(entity);
        }
        Ok(m)
    }
    fn live(&self, v: &Value) -> Result<()> {
        require(
            v["livemode"].as_bool()
                == Some(matches!(self.0.options.environment, Environment::Live)),
            "environment_mismatch",
        )
    }
    async fn create_resource(
        &self,
        resources: Arc<dyn ResourceRegistry>,
        key: String,
        endpoint: &str,
        parameters: Value,
    ) -> Result<String> {
        let this = self.clone();
        let endpoint = endpoint.to_owned();
        resources
            .get_or_create(
                key,
                Arc::new(move |key| {
                    let this = this.clone();
                    let endpoint = endpoint.clone();
                    let parameters = parameters.clone();
                    Box::pin(async move {
                        let v = this.post(&endpoint, parameters, &key).await?;
                        Ok(s(&v, "id")?.into())
                    })
                }),
            )
            .await
    }
    async fn customer_for(&self, command: &PaymentCommand) -> Result<String> {
        let id = if let Some(id) = opt(&command.customer, "stripeCustomerId") {
            id.into()
        } else {
            let digest = hash_v1(
                &json!({"environment":self.0.options.environment.name(),"customer":command.customer["id"]}),
            )?;
            self.create_resource(
                command.resources.clone(),
                format!("customer:{digest}"),
                "customers",
                json!({"metadata":self.metadata(s(&command.customer,"id")?,None,None)?}),
            )
            .await?
        };
        let c = self.get(&path("customers", &id)?, json!({})).await?;
        require(c["deleted"] != true, "customer_not_found")?;
        self.live(&c)?;
        if c["metadata"].get("brokeboy_customer").is_some() {
            require(
                c["metadata"]["brokeboy_customer"] == command.customer["id"]
                    && opt(&c["metadata"], "brokeboy_environment")
                        == Some(self.0.options.environment.name()),
                "customer_mapping_conflict",
            )?;
        }
        Ok(id)
    }
    async fn price_for(
        &self,
        plan: &Value,
        once: bool,
        resources: Arc<dyn ResourceRegistry>,
    ) -> Result<String> {
        if let Some(id) = opt(plan, "stripePriceId") {
            return Ok(id.into());
        }
        let version = s(plan, "version")?;
        let product=self.create_resource(resources.clone(),format!("product:{version}"),"products",json!({"name":plan["name"],"metadata":{"brokeboy_plan":plan["id"],"brokeboy_version":version}})).await?;
        let currency = opt(plan, "currency").unwrap_or("usd");
        let amount = minor(opt(plan, "amount").unwrap_or("0"), currency)?;
        let mut params = json!({"product":product,"currency":currency,"unit_amount":amount,"metadata":{"brokeboy_version":version,"brokeboy_plan":plan["id"]}});
        if !once {
            params["recurring"] = json!({"interval":opt(plan,"interval").unwrap_or("month")});
        }
        self.create_resource(resources, format!("price:{version}"), "prices", params)
            .await
    }
    async fn meter_prices(
        &self,
        plan: &Value,
        resources: Arc<dyn ResourceRegistry>,
    ) -> Result<Value> {
        let mut result = plan
            .get("stripeMeterPriceIds")
            .cloned()
            .unwrap_or(json!({}));
        for item in arr(plan, "items")? {
            if item["overage"] != true {
                continue;
            }
            let feature = s(item, "feature")?;
            if result.get(feature).is_some() {
                continue;
            }
            let version = s(plan, "version")?;
            let event = format!(
                "bb_{}_{}",
                version.chars().take(24).collect::<String>(),
                &hash_v1(&json!(feature))?[..16]
            );
            let meter=self.create_resource(resources.clone(),format!("meter:{event}"),"billing/meters",json!({"display_name":format!("{}: {feature}",s(plan,"name")?),"event_name":event,"default_aggregation":{"formula":"sum"},"customer_mapping":{"type":"by_id","event_payload_key":"stripe_customer_id"},"value_settings":{"event_payload_key":"value"}})).await?;
            let product=self.create_resource(resources.clone(),format!("meter-product:{event}"),"products",json!({"name":format!("{}: {feature}",s(plan,"name")?),"metadata":{"brokeboy_version":version,"brokeboy_feature":feature}})).await?;
            result[feature]=json!(self.create_resource(resources.clone(),format!("meter-price:{event}"),"prices",json!({"product":product,"currency":opt(plan,"currency").unwrap_or("usd"),"unit_amount":1,"recurring":{"interval":opt(plan,"interval").unwrap_or("month"),"usage_type":"metered","meter":meter},"metadata":{"brokeboy_version":version,"brokeboy_feature":feature}})).await?);
        }
        Ok(result)
    }
    async fn owned_subscription(&self, customer: &str, id: &str) -> Result<Value> {
        let sub = self.get(&path("subscriptions", id)?, json!({})).await?;
        require(
            resource_id(&sub["customer"]) == Some(customer),
            "subscription_not_found",
        )?;
        require(
            opt(&sub["metadata"], "brokeboy_environment")
                == Some(self.0.options.environment.name()),
            "environment_mismatch",
        )?;
        Ok(sub)
    }
}
impl PaymentProvider for Stripe {
    fn close(&self) -> BillingFuture<'_, ()> {
        self.0
            .client
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        Box::pin(async { Ok(()) })
    }
    fn execute(&self, command: PaymentCommand) -> BillingFuture<'_, Value> {
        Box::pin(async move {
            let customer = self.customer_for(&command).await?;
            self.execute_command(command, customer).await
        })
    }
    fn verify(
        &self,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> BillingFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move { self.verify_event(headers, body).await })
    }
    fn reconcile(&self, event: ProviderEvent) -> BillingFuture<'_, ProviderEvent> {
        Box::pin(async move { self.reconcile_event(event).await })
    }
    fn verify_resource(&self, key: String, id: String) -> BillingFuture<'_, ()> {
        Box::pin(async move { self.verify_mapping(&key, &id).await })
    }
}
