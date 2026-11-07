#![cfg(all(feature = "sqlite", feature = "http"))]
use brokeboy::{
    Billing, BillingOptions,
    http::{Authorization, Handler},
    sql::SqlStorage,
    storage::BillingFuture,
};
use brokeboy_core::schema::{Dialect, migration_sql};
use http::{Request, Response};
use serde_json::{Value, json};
use std::sync::Arc;
struct Auth;
impl Authorization for Auth {
    fn customer<'a>(&'a self, request: &'a Request<Vec<u8>>) -> BillingFuture<'a, Option<String>> {
        Box::pin(async move {
            Ok(request
                .headers()
                .contains_key("authorization")
                .then(|| "alice".into()))
        })
    }
    fn admin<'a>(&'a self, request: &'a Request<Vec<u8>>) -> BillingFuture<'a, Option<String>> {
        Box::pin(async move {
            Ok((request
                .headers()
                .get("authorization")
                .and_then(|s| s.to_str().ok())
                == Some("admin"))
            .then(|| "operator".into()))
        })
    }
}
fn req(path: &str, body: Option<Value>, auth: &str, origin: &str) -> Request<Vec<u8>> {
    let mut request = Request::builder().uri(format!("/api/billing{path}"));
    if !auth.is_empty() {
        request = request.header("authorization", auth);
    }
    if let Some(body) = body {
        request
            .method("POST")
            .header("origin", origin)
            .header("content-type", "application/json")
            .body(body.to_string().into_bytes())
            .unwrap()
    } else {
        request.body(Vec::new()).unwrap()
    }
}
fn value(response: &Response<Vec<u8>>) -> Value {
    serde_json::from_slice(response.body()).unwrap()
}
#[tokio::test]
async fn http_identity_csrf_visibility_and_admin_audit() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    for sql in migration_sql(Dialect::Sqlite) {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&pool)
            .await
            .unwrap();
    }
    let billing =
        Billing::from_storage(Arc::new(SqlStorage::owned(pool)), BillingOptions::default());
    for id in ["alice", "bob"] {
        billing
            .call(
                "customers.create",
                json!({"id":id,"idempotencyKey":"create","metadata":{"secret":"not-public"}}),
            )
            .await
            .unwrap();
    }
    billing.call("catalog.publish",json!({"expectedRevision":0,"catalog":{"features":[{"id":"credits","kind":"consumable"}],"plans":[{"id":"free","name":"Free","kind":"free","items":[{"feature":"credits","included":"10"}]},{"id":"private","name":"Private","kind":"free","public":false,"items":[]}]}})).await.unwrap();
    let handler = Handler::new(
        billing.clone(),
        Arc::new(Auth),
        "https://app.example".into(),
    );
    assert_eq!(
        handler
            .handle(req("/customer", None, "", ""))
            .await
            .status(),
        401
    );
    let customer = handler
        .handle(req("/customer?customerId=bob", None, "user", ""))
        .await;
    assert_eq!(value(&customer), json!({"id":"alice","controls":{}}));
    let catalog = value(&handler.handle(req("/catalog", None, "user", "")).await);
    assert_eq!(catalog["plans"].as_array().unwrap().len(), 1);
    assert!(catalog["plans"][0].get("items").is_none());
    let checkout = json!({"customerId":"bob","planId":"free","idempotencyKey":"attach","successUrl":"https://app.example/success"});
    assert_eq!(
        handler
            .handle(req(
                "/checkout",
                Some(checkout.clone()),
                "user",
                "https://attacker.example"
            ))
            .await
            .status(),
        403
    );
    assert_eq!(
        handler
            .handle(req(
                "/checkout",
                Some(checkout),
                "user",
                "https://app.example"
            ))
            .await
            .status(),
        200
    );
    assert_eq!(
        billing
            .call("subscriptions.list", json!({"customerId":"bob"}))
            .await
            .unwrap(),
        json!([])
    );
    assert_eq!(
        handler
            .handle(req("/admin/customer?customerId=alice", None, "user", ""))
            .await
            .status(),
        403
    );
    let grant = billing
        .call(
            "credits.grant",
            json!({"customerId":"alice","idempotencyKey":"grant","feature":"credits","amount":"5"}),
        )
        .await
        .unwrap();
    let adjusted=handler.handle(req("/admin/adjust?customerId=alice",Some(json!({"customerId":"bob","idempotencyKey":"adjust","grantId":grant["id"],"amount":"1","reason":"support correction"})),"admin","https://app.example")).await;
    assert_eq!(adjusted.status(), 200, "{}", value(&adjusted));
    let history = billing
        .call("migration.export", json!({"customerId":"alice"}))
        .await
        .unwrap()
        .to_string();
    assert!(history.contains("operator: support correction"));
    assert_eq!(handler.handle(req("/checkout",Some(json!({"planId":"private","idempotencyKey":"private","successUrl":"https://app.example/success"})),"user","https://app.example")).await.status(),403);
    billing.close().await.unwrap();
}
