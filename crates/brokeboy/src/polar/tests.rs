use super::*;
use crate::provider::{ResourceFactory, ResourceRegistry};
use std::io::{Read, Write};
struct Clock;
impl crate::storage::Clock for Clock {
    fn now(&self) -> i64 {
        1_800_000_000_000
    }
}
struct Registry;
impl ResourceRegistry for Registry {
    fn get_or_create(&self, _: String, _: ResourceFactory) -> BillingFuture<'_, String> {
        Box::pin(async { panic!("Polar must not create Stripe resources") })
    }
}
fn options() -> PolarOptions {
    let mut options = PolarOptions::new(
        "fixture-token".into(),
        format!("whsec_{}", STANDARD.encode(b"fixture-secret")),
    );
    options.products.insert("product".into(), "monthly".into());
    options
        .meters
        .insert("wallet".into(), "credit_usage".into());
    options.clock = Arc::new(Clock);
    options
}
fn signed(key: &[u8], body: &[u8]) -> BTreeMap<String, String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(b"event.1800000000.");
    mac.update(body);
    BTreeMap::from([
        ("webhook-id".into(), "event".into()),
        ("webhook-timestamp".into(), "1800000000".into()),
        (
            "webhook-signature".into(),
            format!("v1,{}", STANDARD.encode(mac.finalize().into_bytes())),
        ),
    ])
}
#[tokio::test]
async fn standard_and_explicit_legacy_signatures_bind_raw_bytes_and_time() {
    let body=serde_json::to_vec(&json!({"type":"subscription.updated","data":{"id":"subscription","customer":{"external_id":"app-customer"}}})).unwrap();
    let polar = Polar::new(options()).unwrap();
    let headers = signed(b"fixture-secret", &body);
    let event = polar
        .verify(headers.clone(), body.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.customer_id, "app-customer");
    let mut tampered = body.clone();
    tampered.push(b' ');
    assert_eq!(
        polar
            .verify(headers.clone(), tampered)
            .await
            .unwrap_err()
            .code,
        "invalid_signature"
    );
    let mut expired = headers;
    expired.insert("webhook-timestamp".into(), "1799999000".into());
    assert_eq!(
        polar.verify(expired, body.clone()).await.unwrap_err().code,
        "invalid_signature"
    );
    let mut legacy = options();
    legacy.legacy_literal_secret = true;
    legacy.webhook_secret = "legacy-prefix-secret".into();
    let legacy = Polar::new(legacy).unwrap();
    assert!(
        legacy
            .verify(signed(b"legacy-prefix-secret", &body), body)
            .await
            .unwrap()
            .is_some()
    );
    let mut live = options();
    live.environment = Environment::Live;
    live.test_api_base = Some("http://localhost:9999".into());
    assert!(Polar::new(live).is_err());
}
#[tokio::test]
async fn checkout_portal_and_canonical_subscription_use_native_provider_contracts() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let requests = seen.clone();
    let subscription_status = Arc::new(Mutex::new(String::from("active")));
    let response_status = subscription_status.clone();
    let server = std::thread::spawn(move || {
        for _ in 0..14 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let n = stream.read(&mut buffer).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(offset) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..offset]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= offset + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            assert!(request.contains("Bearer fixture-token"));
            let value = if request.starts_with("POST /v1/checkouts/") {
                assert!(request.contains("\"external_customer_id\":\"owner\""));
                assert!(request.contains("\"products\":[\"product\"]"));
                json!({"id":"checkout","url":"https://checkout.polar.sh/fixture"})
            } else if request.starts_with("POST /v1/customer-sessions/") {
                assert!(request.contains("\"external_customer_id\":\"owner\""));
                json!({"customer_portal_url":"https://polar.sh/portal"})
            } else if request.starts_with("POST /v1/events/ingest") {
                let body: Value =
                    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
                assert_eq!(body["events"][0]["external_id"], "command-meter");
                assert_eq!(body["events"][0]["external_customer_id"], "owner");
                assert_eq!(body["events"][0]["metadata"]["units"], 15);
                json!({"inserted":1})
            } else if request.starts_with("GET /v1/subscriptions/subscription") {
                json!({"id":"subscription","product_id":"product","status":response_status.lock().unwrap().clone(),"current_period_start":"2027-01-01T00:00:00Z","current_period_end":"2027-02-01T00:00:00Z","customer":{"external_id":"owner"},"cancel_at_period_end":false})
            } else {
                panic!("Unexpected fixture request")
            };
            requests.lock().unwrap().push(request);
            let body = value.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        }
    });
    let mut config = options();
    config.test_api_base = Some(format!("http://{address}/v1"));
    let polar = Polar::new(config).unwrap();
    let command = |kind: &str, input: Value| PaymentCommand {
        id: format!("command-{kind}"),
        kind: kind.into(),
        customer: json!({"id":"owner"}),
        input,
        resources: Arc::new(Registry),
    };
    let checkout=polar.execute(command("checkout",json!({"plan":{"id":"monthly","version":"pinned"},"successUrl":"https://app.test/success"}))).await.unwrap();
    assert_eq!(checkout["id"], "checkout");
    assert_eq!(
        polar.execute(command("portal", json!({}))).await.unwrap()["url"],
        "https://polar.sh/portal"
    );
    let event = ProviderEvent {
        id: "notification".into(),
        kind: "subscription.updated".into(),
        customer_id: "owner".into(),
        data: json!({"subscriptionId":"subscription"}),
        extra: Default::default(),
    };
    let canonical = polar.reconcile(event.clone()).await.unwrap();
    assert_eq!(canonical.data["subscription"]["provider"], "polar");
    assert_eq!(canonical.data["planId"], "monthly");
    assert_eq!(canonical.data["providerMeterIds"]["wallet"], "credit_usage");
    for (provider_status, billing_status) in [
        ("incomplete", "pending"),
        ("incomplete_expired", "ended"),
        ("trialing", "trialing"),
        ("active", "active"),
        ("past_due", "past_due"),
        ("canceled", "ended"),
        ("unpaid", "ended"),
    ] {
        *subscription_status.lock().unwrap() = provider_status.into();
        let canonical = polar.reconcile(event.clone()).await.unwrap();
        let subscription = &canonical.data["subscription"];
        assert_eq!(subscription["status"], billing_status, "{provider_status}");
        assert_eq!(
            subscription["paidThrough"],
            if matches!(billing_status, "active" | "trialing") {
                subscription["periodEnd"].clone()
            } else {
                json!(0)
            },
            "{provider_status}"
        );
    }
    *subscription_status.lock().unwrap() = "future-provider-status".into();
    assert_eq!(
        polar.reconcile(event.clone()).await.unwrap_err().code,
        "unsupported_provider_status"
    );
    let mut foreign = event;
    foreign.customer_id = "someone-else".into();
    assert_eq!(
        polar.reconcile(foreign).await.unwrap_err().code,
        "customer_mapping_conflict"
    );
    for _ in 0..2 {
        let result=polar.execute(command("meter",json!({"feature":"wallet","priceId":"credit_usage","total":"0.25","previousMinor":"10","currency":"usd","periodEnd":1_800_000_100_000_i64}))).await.unwrap();
        assert_eq!(result["exportedMinor"], "25");
    }
    polar.close().await.unwrap();
    server.join().unwrap();
    assert_eq!(seen.lock().unwrap().len(), 14);
}
