use brokeboy::{
    Billing, BillingOptions,
    config::OpenConfig,
    operations::Environment,
    storage::{BillingFuture, Clock, EventDelivery},
};
use napi::{
    Status,
    bindgen_prelude::{Buffer, Promise},
    threadsafe_function::ThreadsafeFunction,
};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicI64, Ordering},
};

type EventCallback = ThreadsafeFunction<String, Promise<()>, String, Status, false, true>;
struct Events(Mutex<Option<Arc<EventCallback>>>);
impl EventDelivery for Events {
    fn deliver(&self, event: Value) -> BillingFuture<'_, ()> {
        let callback = self.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        Box::pin(async move {
            let callback =
                callback.ok_or_else(|| brokeboy_core::BillingError::new("billing_closed"))?;
            let promise = callback
                .call_async_catch(event.to_string())
                .await
                .map_err(|_| brokeboy_core::BillingError::new("provider_error"))?;
            promise
                .await
                .map_err(|_| brokeboy_core::BillingError::new("provider_error"))
        })
    }
    fn close(&self) -> BillingFuture<'_, ()> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take();
        Box::pin(async { Ok(()) })
    }
}
struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(flatten)]
    connection: OpenConfig,
    test_clock_ms: Option<i64>,
}
#[napi]
pub struct NativeBilling {
    billing: Billing,
    test_clock: Option<Arc<TestClock>>,
}
#[napi]
impl NativeBilling {
    #[napi(factory)]
    pub async fn open(
        configuration: String,
        on_event: Option<EventCallback>,
    ) -> napi::Result<Self> {
        let config: Config = serde_json::from_str(&configuration)
            .map_err(|_| napi::Error::from_reason("invalid_billing_configuration"))?;
        let mut options = BillingOptions {
            environment: config.connection.environment.unwrap_or(Environment::Test),
            ..Default::default()
        };
        let test_clock = if let Some(now) = config.test_clock_ms {
            if !matches!(options.environment, Environment::Test)
                || !(0..=9_007_199_254_740_991).contains(&now)
            {
                return Err(napi::Error::from_reason("invalid_test_clock"));
            }
            let clock = Arc::new(TestClock(AtomicI64::new(now)));
            options.clock = clock.clone();
            Some(clock)
        } else {
            None
        };
        if let Some(callback) = on_event {
            options.events = Some(Arc::new(Events(Mutex::new(Some(Arc::new(callback))))));
        }
        let billing = Billing::open_config(config.connection, options)
            .await
            .map_err(super::native_error)?;
        Ok(Self {
            billing,
            test_clock,
        })
    }
    #[napi]
    pub fn register_request(&self, id: String) -> napi::Result<()> {
        self.billing
            .register_request(&id)
            .map_err(super::native_error)
    }
    #[napi]
    pub fn cancel_request(&self, id: String) -> bool {
        self.billing.cancel_request(&id)
    }
    #[napi]
    pub fn set_test_clock(&self, now: f64) -> napi::Result<()> {
        if !now.is_finite() || now.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&now)
        {
            return Err(napi::Error::from_reason("invalid_timestamp"));
        }
        let clock = self
            .test_clock
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("test_clock_not_configured"))?;
        clock.0.store(now as i64, Ordering::SeqCst);
        Ok(())
    }
    #[napi]
    pub async fn call(
        &self,
        method: String,
        input: String,
        request_id: String,
    ) -> napi::Result<String> {
        let input = serde_json::from_str(&input).map_err(|_| {
            self.billing.discard_pending_request(&request_id);
            napi::Error::from_reason("invalid_json")
        })?;
        let value = self
            .billing
            .call_registered(&method, input, &request_id)
            .await
            .map_err(super::native_error)?;
        serde_json::to_string(&value).map_err(|_| napi::Error::from_reason("invalid_result"))
    }
    #[napi]
    pub async fn webhook(
        &self,
        headers: String,
        body: Buffer,
        request_id: String,
    ) -> napi::Result<String> {
        let headers = serde_json::from_str(&headers).map_err(|_| {
            self.billing.discard_pending_request(&request_id);
            napi::Error::from_reason("invalid_headers")
        })?;
        let value = self
            .billing
            .webhook_registered(headers, body.to_vec(), &request_id)
            .await
            .map_err(super::native_error)?;
        Ok(value.to_string())
    }
    #[napi]
    pub async fn close(&self) -> napi::Result<()> {
        self.billing.close().await.map_err(super::native_error)
    }
}
