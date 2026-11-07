//! Framework-independent HTTP contract with application-supplied authorization.
use crate::{Billing, storage::BillingFuture};
use brokeboy_core::{BillingError, Result, error::identifier};
use http::{Method, Request, Response};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub trait Authorization: Send + Sync {
    fn customer<'a>(&'a self, request: &'a Request<Vec<u8>>) -> BillingFuture<'a, Option<String>>;
    fn admin<'a>(&'a self, _request: &'a Request<Vec<u8>>) -> BillingFuture<'a, Option<String>> {
        Box::pin(async { Ok(None) })
    }
    fn plan<'a>(&'a self, _customer: &'a str, _plan: &'a Value) -> BillingFuture<'a, bool> {
        Box::pin(async { Ok(true) })
    }
}
pub struct Handler {
    pub billing: Billing,
    pub authorization: Arc<dyn Authorization>,
    pub base_path: String,
    /// Explicit site origin is required because many Rust frameworks expose relative URIs.
    pub origin: String,
    pub trusted_origins: BTreeSet<String>,
}
fn failure(code: &str) -> BillingError {
    BillingError::new(code)
}
fn require(ok: bool, code: &str) -> Result<()> {
    if ok { Ok(()) } else { Err(failure(code)) }
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| failure("invalid_input"))
}
fn response(value: Value, status: u16) -> Response<Vec<u8>> {
    let mut response = Response::new(value.to_string().into_bytes());
    *response.status_mut() =
        http::StatusCode::from_u16(status).unwrap_or(http::StatusCode::INTERNAL_SERVER_ERROR);
    let h = response.headers_mut();
    h.insert(
        "content-type",
        http::HeaderValue::from_static("application/json"),
    );
    h.insert("cache-control", http::HeaderValue::from_static("no-store"));
    h.insert(
        "x-content-type-options",
        http::HeaderValue::from_static("nosniff"),
    );
    response
}
fn public_plan(plan: &Value) -> Value {
    let mut output = json!({});
    for key in [
        "id",
        "name",
        "version",
        "currency",
        "amount",
        "interval",
        "kind",
        "trialDays",
    ] {
        if let Some(value) = plan.get(key) {
            output[key] = value.clone();
        }
    }
    output["features"] = json!(
        plan["items"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|item| {
                let mut v = json!({"feature":item["feature"]});
                for k in ["included", "enabled"] {
                    if let Some(x) = item.get(k) {
                        v[k] = x.clone();
                    }
                }
                v
            })
            .collect::<Vec<_>>()
    );
    output
}
fn public_operation(work: Value) -> Value {
    let mut value = json!({"id":work["id"],"status":work["status"]});
    if let Some(error) = work.get("error") {
        value["error"] = error.clone();
    }
    if let Some(result) = work.get("result") {
        let mut public = json!({});
        for k in ["id", "url", "status"] {
            if let Some(v) = result.get(k) {
                public[k] = v.clone();
            }
        }
        value["result"] = public;
    }
    value
}
impl Handler {
    pub fn new(billing: Billing, authorization: Arc<dyn Authorization>, origin: String) -> Self {
        Self {
            billing,
            authorization,
            base_path: "/api/billing".into(),
            origin,
            trusted_origins: BTreeSet::new(),
        }
    }
    pub async fn handle(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        match self.execute(request).await {
            Ok(value) => response(value, 200),
            Err(e) => {
                let status = match e.code.as_str() {
                    "unauthenticated" => 401,
                    "forbidden" | "origin_not_allowed" => 403,
                    "not_found" => 404,
                    "method_not_allowed" => 405,
                    "body_too_large" => 413,
                    "idempotency_conflict" | "catalog_conflict" => 409,
                    "storage_error" | "provider_error" => 500,
                    _ => 400,
                };
                response(
                    json!({"error":{"code":if status==500{"internal_error"}else{e.code.as_str()},"message":if status==500{"internal_error"}else{e.code.as_str()}}}),
                    status,
                )
            }
        }
    }
    fn return_url(&self, value: &str) -> Result<String> {
        let url = url::Url::parse(value).map_err(|_| failure("invalid_url"))?;
        let origin = url.origin().ascii_serialization();
        require(
            (url.scheme() == "https"
                || (url.scheme() == "http"
                    && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))))
                && (origin == self.origin || self.trusted_origins.contains(&origin)),
            "origin_not_allowed",
        )?;
        Ok(url.to_string())
    }
    async fn execute(&self, request: Request<Vec<u8>>) -> Result<Value> {
        let base = self.base_path.trim_end_matches('/');
        let path = request.uri().path();
        require(
            path == base || path.starts_with(&format!("{base}/")),
            "not_found",
        )?;
        let route = &path[base.len()..];
        if route == "/webhook" {
            require(request.method() == Method::POST, "method_not_allowed")?;
            require(request.body().len() <= 8 * 1024 * 1024, "body_too_large")?;
            let headers = request
                .headers()
                .iter()
                .map(|(k, v)| {
                    Ok((
                        k.as_str().into(),
                        v.to_str().map_err(|_| failure("invalid_headers"))?.into(),
                    ))
                })
                .collect::<Result<BTreeMap<_, _>>>()?;
            return self.billing.webhook(headers, request.body().clone()).await;
        }
        let post = request.method() == Method::POST;
        require(
            post || request.method() == Method::GET,
            "method_not_allowed",
        )?;
        if post {
            let origin = request
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| failure("origin_not_allowed"))?;
            require(
                origin == self.origin || self.trusted_origins.contains(origin),
                "origin_not_allowed",
            )?;
        }
        let query: BTreeMap<String, String> =
            url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
                .into_owned()
                .collect();
        let mut body = if post {
            require(
                request
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.split(';').next())
                    == Some("application/json"),
                "invalid_content_type",
            )?;
            require(request.body().len() <= 65536, "body_too_large")?;
            let value: Value =
                serde_json::from_slice(request.body()).map_err(|_| failure("invalid_json"))?;
            require(value.is_object(), "invalid_json")?;
            value
        } else {
            json!({})
        };
        if route.starts_with("/admin/") {
            let actor = self
                .authorization
                .admin(&request)
                .await?
                .ok_or_else(|| failure("forbidden"))?;
            let customer = query
                .get("customerId")
                .ok_or_else(|| failure("invalid_input"))?;
            identifier(customer)?;
            let scope = json!({"customerId":customer});
            return match (post,route){
                (false,"/admin/customer")=>Ok(json!({"customer":self.billing.call("customers.get",scope.clone()).await?,"grants":self.billing.call("credits.list",scope.clone()).await?,"operations":self.billing.call("operations.list",scope.clone()).await?,"ledger":self.billing.call("credits.reconcile",scope.clone()).await?,"workflows":self.billing.call("workflows.page",scope).await?})),
                (false,"/admin/workflows"|"/admin/workflow")=>{let mut p=scope;for key in ["entityId","cursor","workflowId"]{if let Some(v)=query.get(key){p[key]=json!(v);}}self.billing.call(if route.ends_with("/workflow"){"workflows.get"}else{"workflows.page"},p).await},
                (true,"/admin/adjust")=>self.billing.call("credits.adjust",json!({"customerId":customer,"idempotencyKey":field(&body,"idempotencyKey")?,"grantId":field(&body,"grantId")?,"amount":field(&body,"amount")?,"reason":format!("{actor}: {}",field(&body,"reason")?)})).await,
                (true,"/admin/retry")=>self.billing.call("operations.retry",json!({"customerId":customer,"idempotencyKey":field(&body,"idempotencyKey")?,"operationId":field(&body,"operationId")?})).await,
                (true,"/admin/workflow/resolve")=>{require(!field(&body,"reason")?.trim().is_empty(),"reason_required")?;body["customerId"]=json!(customer);body["reason"]=json!(format!("{actor}: {}",field(&body,"reason")?));self.billing.call("workflows.resolve",body).await},
                _=>Err(failure("not_found")),
            };
        }
        let customer = self
            .authorization
            .customer(&request)
            .await?
            .ok_or_else(|| failure("unauthenticated"))?;
        identifier(&customer)?;
        let scope = json!({"customerId":customer});
        if !post {
            return match route {
                "/catalog" => {
                    let catalog = self.billing.call("catalog.export", json!({})).await?;
                    let mut latest: BTreeMap<String, Value> = BTreeMap::new();
                    for plan in catalog["plans"]
                        .as_array()
                        .ok_or_else(|| failure("invalid_catalog"))?
                    {
                        let id = field(plan, "id")?;
                        if latest
                            .get(id)
                            .is_none_or(|old| old["revision"].as_i64() < plan["revision"].as_i64())
                        {
                            latest.insert(id.into(), plan.clone());
                        }
                    }
                    let mut plans = Vec::new();
                    for plan in latest.values() {
                        if plan["public"] != false
                            && self.authorization.plan(&customer, plan).await?
                        {
                            plans.push(public_plan(plan));
                        }
                    }
                    Ok(json!({"plans":plans}))
                }
                "/customer" => {
                    let c = self.billing.call("customers.get", scope).await?;
                    Ok(json!({"id":c["id"],"controls":c["controls"]}))
                }
                "/balance" => {
                    let feature = query
                        .get("feature")
                        .ok_or_else(|| failure("invalid_input"))?;
                    identifier(feature)?;
                    self.billing
                        .call(
                            "credits.balance",
                            json!({"customerId":customer,"feature":feature}),
                        )
                        .await
                }
                "/controls" => self.billing.call("billingControls.get", scope).await,
                "/subscriptions" => {
                    let subs = self.billing.call("subscriptions.list", scope).await?;
                    Ok(
                        json!({"subscriptions":subs.as_array().ok_or_else(||failure("invalid_record"))?.iter().map(|s|{let mut value=json!({"id":s["id"],"status":s["status"],"plan":public_plan(&s["plan"]),"periodEnd":s["periodEnd"],"quantity":s["quantity"]});if let Some(v)=s.get("cancelAtPeriodEnd"){value["cancelAtPeriodEnd"]=v.clone();}value}).collect::<Vec<_>>()}),
                    )
                }
                "/usage" => {
                    let usage = self.billing.call("usage.list", scope).await?;
                    Ok(
                        json!({"usage":usage.as_array().ok_or_else(||failure("invalid_record"))?.iter().map(|u|json!({"id":u["id"],"feature":u["feature"],"quantity":u["quantity"],"createdAt":u["createdAt"]})).collect::<Vec<_>>()}),
                    )
                }
                _ => Err(failure("not_found")),
            };
        }
        let key = identifier(field(&body, "idempotencyKey")?)?;
        match route{
            "/controls"=>{let limits=body["overageLimits"].as_object().ok_or_else(||failure("invalid_input"))?;for(k,v)in limits{identifier(k)?;require(v.is_string(),"invalid_decimal")?;}let mut controls=self.billing.call("billingControls.get",scope).await?;controls["overageLimits"]=body["overageLimits"].clone();self.billing.call("billingControls.update",json!({"customerId":customer,"idempotencyKey":key,"controls":controls})).await}
            "/checkout"=>{let plan=self.billing.call("catalog.get",json!({"id":field(&body,"planId")?})).await?;require(plan["public"]!=false&&self.authorization.plan(&customer,&plan).await?,"forbidden")?;let success=self.return_url(field(&body,"successUrl")?)?;
                if plan["kind"]=="free"&&!plan["items"].as_array().ok_or_else(||failure("invalid_catalog"))?.iter().any(|i|i["overage"]==true){let sub=self.billing.call("subscriptions.attach",json!({"customerId":customer,"idempotencyKey":key,"planId":plan["id"],"version":plan["version"]})).await?;return Ok(json!({"status":"done","result":{"id":sub["id"]}}));}
                let mut p=json!({"customerId":customer,"idempotencyKey":key,"planId":plan["id"],"version":plan["version"],"successUrl":success});if let Some(q)=body["quantity"].as_str(){p["quantity"]=json!(q);}Ok(public_operation(self.billing.call("subscriptions.checkout",p).await?))}
            "/portal"=>Ok(public_operation(self.billing.call("subscriptions.portal",json!({"customerId":customer,"idempotencyKey":key,"returnUrl":self.return_url(field(&body,"returnUrl")?)?})).await?)),
            "/cancel"=>Ok(public_operation(self.billing.call("subscriptions.cancel",json!({"customerId":customer,"idempotencyKey":key,"subscriptionId":field(&body,"subscriptionId")?})).await?)),
            _=>Err(failure("not_found")),
        }
    }
}
