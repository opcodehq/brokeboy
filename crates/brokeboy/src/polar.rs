//! Optional Polar checkout, portal and authoritative subscription notifications.
use crate::{
    engine::SystemClock,
    operations::Environment,
    provider::{PaymentCommand, PaymentProvider, ProviderEvent},
    storage::{BillingFuture, Clock},
    wire::*,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use brokeboy_core::{BillingError, MAX_WEBHOOK_BYTES, Result};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

pub struct PolarOptions {
    pub access_token: String,
    pub webhook_secret: String,
    pub environment: Environment,
    /// Provider product ID -> published application plan ID.
    pub products: BTreeMap<String, String>,
    /// Billing feature -> configured ingestion event name, rated in currency minor units.
    pub meters: BTreeMap<String, String>,
    /// Explicit compatibility for endpoints using literal UTF-8 signing keys.
    pub legacy_literal_secret: bool,
    pub clock: Arc<dyn Clock>,
    /// A loopback-only override for deterministic HTTP tests in test mode.
    pub test_api_base: Option<String>,
}
impl PolarOptions {
    pub fn new(access_token: String, webhook_secret: String) -> Self {
        Self {
            access_token,
            webhook_secret,
            environment: Environment::Test,
            products: BTreeMap::new(),
            meters: BTreeMap::new(),
            legacy_literal_secret: false,
            clock: Arc::new(SystemClock),
            test_api_base: None,
        }
    }
}
pub struct Polar {
    options: PolarOptions,
    client: Mutex<Option<reqwest::Client>>,
    base: String,
}
fn secure_url(value: &str) -> Result<String> {
    let url = url::Url::parse(value).map_err(|_| BillingError::new("invalid_provider_url"))?;
    require(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none(),
        "invalid_provider_url",
    )?;
    Ok(url.into())
}
fn resource(collection: &str, id: &str) -> Result<String> {
    require(
        !id.is_empty()
            && id.len() <= 255
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "invalid_provider_id",
    )?;
    Ok(format!("{collection}/{id}"))
}
impl Polar {
    pub fn new(options: PolarOptions) -> Result<Self> {
        require(
            !options.access_token.trim().is_empty(),
            "invalid_provider_configuration",
        )?;
        let base = if let Some(base) = &options.test_api_base {
            let url = url::Url::parse(base)
                .map_err(|_| BillingError::new("invalid_provider_configuration"))?;
            require(
                matches!(options.environment, Environment::Test)
                    && url.scheme() == "http"
                    && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
                    && url.username().is_empty()
                    && url.password().is_none(),
                "invalid_provider_configuration",
            )?;
            base.trim_end_matches('/').into()
        } else {
            match options.environment {
                Environment::Test => "https://sandbox-api.polar.sh/v1".into(),
                Environment::Live => "https://api.polar.sh/v1".into(),
            }
        };
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| BillingError::new("provider_error"))?;
        Ok(Self {
            options,
            client: Mutex::new(Some(client)),
            base,
        })
    }
    async fn request(
        &self,
        endpoint: &str,
        input: Option<Value>,
        key: Option<&str>,
    ) -> Result<Value> {
        let client = self
            .client
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| BillingError::new("provider_closed"))?;
        let mut request = client
            .request(
                if input.is_some() {
                    reqwest::Method::POST
                } else {
                    reqwest::Method::GET
                },
                format!("{}/{endpoint}", self.base),
            )
            .bearer_auth(&self.options.access_token);
        if let Some(key) = key {
            request = request.header("Idempotency-Key", key);
        }
        if let Some(input) = &input {
            request = request.json(input);
        }
        // POST ambiguity is never retried automatically: reconciliation must recover its resource.
        let error = || {
            BillingError::new(if input.is_some() {
                "reconciliation_required"
            } else {
                "provider_error"
            })
        };
        let mut response = request.send().await.map_err(|_| error())?;
        require(
            response.status().is_success(),
            if input.is_some() {
                "reconciliation_required"
            } else {
                "provider_error"
            },
        )?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| error())? {
            require(
                chunk.len() <= MAX_WEBHOOK_BYTES - bytes.len(),
                "provider_response_too_large",
            )?;
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| error())
    }
    fn verify_notification(
        &self,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> Result<Option<ProviderEvent>> {
        require(body.len() <= MAX_WEBHOOK_BYTES, "body_too_large")?;
        let header = |key: &str| -> Result<&str> {
            headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v.as_str())
                .filter(|v| !v.is_empty() && v.len() <= 8192)
                .ok_or_else(|| BillingError::new("invalid_signature"))
        };
        let id = header("webhook-id")?;
        require(id.len() <= 1024, "invalid_signature")?;
        let timestamp = header("webhook-timestamp")?;
        let at = timestamp
            .parse::<i64>()
            .map_err(|_| BillingError::new("invalid_signature"))?;
        require(
            (i128::from(self.options.clock.now() / 1000) - i128::from(at)).abs() <= 300,
            "invalid_signature",
        )?;
        let key = if self.options.legacy_literal_secret {
            self.options.webhook_secret.as_bytes().to_vec()
        } else {
            STANDARD
                .decode(
                    self.options
                        .webhook_secret
                        .strip_prefix("whsec_")
                        .ok_or_else(|| BillingError::new("invalid_signature"))?,
                )
                .map_err(|_| BillingError::new("invalid_signature"))?
        };
        require(!key.is_empty(), "invalid_signature")?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&key)
            .map_err(|_| BillingError::new("invalid_signature"))?;
        mac.update(format!("{id}.{timestamp}.").as_bytes());
        mac.update(&body);
        require(
            header("webhook-signature")?
                .split_whitespace()
                .filter_map(|v| v.strip_prefix("v1,"))
                .filter_map(|v| STANDARD.decode(v).ok())
                .any(|v| mac.clone().verify_slice(&v).is_ok()),
            "invalid_signature",
        )?;
        let raw: Value = serde_json::from_slice(&body)
            .map_err(|_| BillingError::new("invalid_provider_event"))?;
        let kind = s(&raw, "type")?;
        if !matches!(
            kind,
            "subscription.active"
                | "subscription.created"
                | "subscription.updated"
                | "subscription.canceled"
                | "subscription.past_due"
                | "subscription.revoked"
                | "subscription.uncanceled"
        ) {
            return Ok(None);
        }
        let customer = opt(&raw["data"]["customer"], "external_id")
            .or_else(|| opt(&raw["data"]["metadata"], "brokeboy_customer"))
            .unwrap_or("");
        Ok(Some(ProviderEvent {
            id: id.into(),
            kind: kind.into(),
            customer_id: customer.into(),
            data: json!({"provider":"polar","subscriptionId":raw["data"]["id"]}),
            extra: Default::default(),
        }))
    }
    async fn subscription(&self, event: ProviderEvent) -> Result<ProviderEvent> {
        let id = s(&event.data, "subscriptionId")?;
        let sub = self
            .request(&resource("subscriptions", id)?, None, None)
            .await?;
        require(
            sub["id"] == id
                && opt(&sub["customer"], "external_id") == Some(event.customer_id.as_str()),
            "customer_mapping_conflict",
        )?;
        let product = s(&sub, "product_id")?;
        let plan = self
            .options
            .products
            .get(product)
            .ok_or_else(|| BillingError::new("unmapped_provider_product"))?;
        let date = |field: &str| -> Result<i64> {
            chrono::DateTime::parse_from_rfc3339(s(&sub, field)?)
                .map(|d| d.timestamp_millis())
                .map_err(|_| BillingError::new("invalid_provider_event"))
        };
        let start = date("current_period_start")?;
        let end = date("current_period_end")?;
        require(
            start >= 0 && end > start && end <= 9_007_199_254_740_991,
            "invalid_provider_event",
        )?;
        let status = match opt(&sub, "status") {
            Some("active") => "active",
            Some("trialing") => "trialing",
            Some("past_due") => "past_due",
            Some("incomplete") => "pending",
            Some("canceled" | "unpaid" | "incomplete_expired") => "ended",
            _ => return Err(BillingError::new("unsupported_provider_status")),
        };
        Ok(ProviderEvent {
            id: event.id,
            kind: "subscription.updated".into(),
            customer_id: event.customer_id,
            data: json!({"planId":plan,"providerMeterIds":self.options.meters,"subscription":{"id":id,"provider":"polar","providerSubscriptionId":id,"status":status,"periodStart":start,"periodEnd":end,"paidThrough":if matches!(status,"active"|"trialing"){end}else{0},"quantity":"1","cancelAtPeriodEnd":sub["cancel_at_period_end"]}}),
            extra: Default::default(),
        })
    }
}
impl PaymentProvider for Polar {
    fn provider_id(&self) -> &str {
        "polar"
    }
    fn close(&self) -> BillingFuture<'_, ()> {
        self.client.lock().unwrap_or_else(|e| e.into_inner()).take();
        Box::pin(async { Ok(()) })
    }
    fn execute(&self, command: PaymentCommand) -> BillingFuture<'_, Value> {
        Box::pin(async move {
            let owner = s(&command.customer, "id")?;
            let p = &command.input;
            match command.kind.as_str() {
                "meter" => {
                    require(
                        self.options.clock.now() < n(p, "periodEnd")?,
                        "reconciliation_required",
                    )?;
                    let target = s(p, "total")?
                        .parse::<brokeboy_core::decimal::Decimal>()?
                        .minor_units(s(p, "currency")?)?;
                    let total = target
                        .parse::<i128>()
                        .map_err(|_| BillingError::new("provider_amount_overflow"))?;
                    let previous = opt(p, "previousMinor")
                        .unwrap_or("0")
                        .parse::<i128>()
                        .map_err(|_| BillingError::new("invalid_record"))?;
                    let delta = total
                        .checked_sub(previous)
                        .ok_or_else(|| BillingError::new("provider_amount_overflow"))?;
                    require(
                        delta.unsigned_abs() <= 9_007_199_254_740_991,
                        "provider_amount_overflow",
                    )?;
                    let event = s(p, "priceId")?;
                    require(
                        self.options
                            .meters
                            .get(s(p, "feature")?)
                            .is_some_and(|configured| configured == event),
                        "unmapped_provider_meter",
                    )?;
                    if delta != 0 {
                        let timestamp =
                            chrono::DateTime::from_timestamp_millis(self.options.clock.now())
                                .ok_or_else(|| BillingError::new("invalid_timestamp"))?
                                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                        self.request("events/ingest",Some(json!({"events":[{"name":event,"timestamp":timestamp,"external_id":command.id,"external_customer_id":owner,"metadata":{"units":delta as i64,"currency":p["currency"],"billable":true}}]})),Some(&command.id)).await?;
                    }
                    Ok(json!({"exportedMinor":target}))
                }
                "checkout" => {
                    let plan = s(&p["plan"], "id")?;
                    let product = self
                        .options
                        .products
                        .iter()
                        .find(|(_, v)| v.as_str() == plan)
                        .map(|(k, _)| k)
                        .ok_or_else(|| BillingError::new("unmapped_provider_product"))?;
                    let success = secure_url(s(p, "successUrl")?)?;
                    let session=self.request("checkouts/",Some(json!({"products":[product],"external_customer_id":owner,"success_url":success,"allow_trial":false,"metadata":{"brokeboy_customer":owner,"brokeboy_plan":plan,"brokeboy_version":p["plan"]["version"]}})),Some(&command.id)).await?;
                    Ok(json!({"id":session["id"],"url":secure_url(s(&session,"url")?)?}))
                }
                "portal" => {
                    let session = self
                        .request(
                            "customer-sessions/",
                            Some(json!({"external_customer_id":owner})),
                            Some(&command.id),
                        )
                        .await?;
                    Ok(json!({"url":secure_url(s(&session,"customer_portal_url")?)?}))
                }
                "subscription_import" => {
                    let id = s(p, "providerSubscriptionId")?;
                    let event = self
                        .subscription(ProviderEvent {
                            id: format!("import:{}", command.id),
                            kind: "subscription.updated".into(),
                            customer_id: owner.into(),
                            data: json!({"subscriptionId":id}),
                            extra: Default::default(),
                        })
                        .await?;
                    require(
                        event.data["planId"] == p["plan"]["id"],
                        "customer_mapping_conflict",
                    )?;
                    Ok(json!({"providerEvent":event}))
                }
                _ => Err(BillingError::new("unsupported_payment_operation")),
            }
        })
    }
    fn verify(
        &self,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> BillingFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move { self.verify_notification(headers, body) })
    }
    fn reconcile(&self, event: ProviderEvent) -> BillingFuture<'_, ProviderEvent> {
        Box::pin(async move { self.subscription(event).await })
    }
}
#[cfg(test)]
mod tests;
