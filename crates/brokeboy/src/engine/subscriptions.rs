use super::*;
use crate::ledger::register_features;
use brokeboy_core::{
    compatibility::hash_v1,
    decimal::SCALE,
    pricing::{Interval, add_interval},
};
pub(crate) fn interval(plan: &Value) -> Interval {
    if opt(plan, "interval") == Some("year") {
        Interval::Year
    } else {
        Interval::Month
    }
}
fn return_url(value: &str) -> Result<()> {
    let url = url::Url::parse(value).map_err(|_| BillingError::new("invalid_url"))?;
    require(
        url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))),
        "invalid_url",
    )
}
impl Billing {
    pub(crate) async fn subscription_call(
        &self,
        method: &str,
        input: Value,
        request: &RequestGuard,
    ) -> Result<Value> {
        let mut p = input.clone();
        let kind = match method {
            "prepaid.checkout" => {
                identifier(s(&p, "feature")?)?;
                require(
                    (1..=99_999_999).contains(&n(&p, "amountCents")?),
                    "invalid_amount",
                )?;
                return_url(s(&p, "successUrl")?)?;
                if let Some(cancel) = opt(&p, "cancelUrl") {
                    return_url(cancel)?;
                }
                "prepaid_checkout"
            }
            "migration.importStripeBalance" => {
                p["provider"] = json!("stripe");
                identifier(s(&p, "feature")?)?;
                if p["dryRun"] != false {
                    p["dryRun"] = json!(true);
                }
                if p["dryRun"] == false {
                    require(
                        p["externalSpendingDisabled"] == true,
                        "external_spending_must_be_disabled",
                    )?;
                    require(n(&p, "expectedCreditCents")? >= 0, "invalid_amount")?;
                }
                "prepaid_balance_import"
            }
            "subscriptions.checkout" => {
                let plan = self.plan(s(&p, "planId")?, opt(&p, "version")).await?;
                p["plan"] = plan;
                if let Some(q) = opt(&p, "quantity") {
                    require(positive(q)? % SCALE == 0, "invalid_seat_quantity")?;
                }
                return_url(s(&p, "successUrl")?)?;
                if let Some(url) = opt(&p, "cancelUrl") {
                    return_url(url)?;
                }
                "checkout"
            }
            "subscriptions.preview" => {
                p["plan"] = self.plan(s(&p, "planId")?, None).await?;
                "preview"
            }
            "subscriptions.update" | "catalog.migrate" => {
                if let Some(id) = opt(&p, "planId") {
                    p["plan"] = self.plan(id, None).await?;
                }
                "subscription_update"
            }
            "subscriptions.cancel" => "subscription_cancel",
            "subscriptions.pause" => "subscription_pause",
            "subscriptions.resume" => "subscription_resume",
            "subscriptions.schedule" => {
                let mut phases = Vec::new();
                for phase in arr(&p, "phases")? {
                    let mut phase = phase.clone();
                    phase["plan"] = self.plan(s(&phase, "planId")?, None).await?;
                    phases.push(phase);
                }
                p["phases"] = json!(phases);
                "subscription_schedule"
            }
            "subscriptions.portal" => "portal",
            "commerce.invoices" => "invoices",
            "commerce.invoice" => "invoice",
            "commerce.refund" => "refund",
            "commerce.creditNote" => "credit_note",
            "migration.linkSubscription" => {
                p["plan"] = self.plan(s(&p, "planId")?, None).await?;
                "subscription_import"
            }
            _ => return Err(BillingError::new("unknown_method")),
        };
        let hashed_parameters = p.clone();
        if matches!(
            kind,
            "preview"
                | "subscription_update"
                | "subscription_cancel"
                | "subscription_pause"
                | "subscription_resume"
                | "subscription_schedule"
        ) {
            let scope = self.scope(s(&p, "customerId")?)?;
            let id = s(&p, "subscriptionId")?.to_owned();
            let existing = self
                .atomic(&scope, move |tx| {
                    Box::pin(async move {
                        Ok(get(tx, Table::Subscriptions, &id)
                            .await?
                            .unwrap_or(Value::Null))
                    })
                })
                .await?;
            if p.get("provider").is_none() {
                if let Some(provider) = opt(&existing, "provider") {
                    p["provider"] = json!(provider);
                } else if opt(&existing, "stripeSubscriptionId").is_some() {
                    p["provider"] = json!("stripe");
                }
            }
            if !existing.is_null()
                && opt(&existing, "stripeSubscriptionId").is_none()
                && opt(&existing, "providerSubscriptionId").is_none()
            {
                return self
                    .write(
                        &format!("local.{kind}"),
                        &hashed_parameters,
                        p.clone(),
                        request,
                    )
                    .await;
            }
        }
        let saved = self
            .write(
                &format!("payment.{kind}"),
                &hashed_parameters,
                p.clone(),
                request,
            )
            .await?;
        self.run_work(
            &self.scope(s(&input, "customerId")?)?,
            s(&saved, "operationId")?,
        )
        .await?;
        let mut tx = self
            .0
            .storage
            .begin(&self.scope(s(&input, "customerId")?)?)
            .await?;
        let result = get(tx.as_mut(), Table::Work, s(&saved, "operationId")?).await;
        tx.rollback().await?;
        result?.ok_or_else(|| BillingError::new("operation_not_found"))
    }
    pub(crate) async fn payment_intent(
        &self,
        tx: &mut dyn Transaction,
        kind: &str,
        p: &Value,
        key: &str,
    ) -> Result<Value> {
        let id = format!("payment:{key}");
        let mut payload = p.clone();
        let customer = s(p, "customerId")?;
        if kind == "prepaid_checkout" {
            let purchase = self.provider_identity(&self.scope(customer)?, &id)?;
            put(
                tx,
                Table::Counters,
                &format!("prepaid-intent:{purchase}"),
                p.clone(),
                "pending",
            )
            .await?;
        }
        if kind == "checkout" && opt(&p["plan"], "kind") != Some("one_time") {
            let plan = &p["plan"];
            let mut identity = json!({"group":if plan["addOn"]==true{s(plan,"id")?}else{opt(plan,"group").unwrap_or("base")}});
            if let Some(entity) = opt(p, "entityId") {
                identity["entity"] = json!(entity);
            }
            let slot = hash_v1(&identity)?;
            let counter = format!("checkout:{slot}");
            if let Some(old) = get(tx, Table::Counters, &counter).await?
                && n(&old, "expiresAt")? > self.now()
            {
                require(
                    old["version"] == plan["version"]
                        && opt(&old, "quantity") == Some(opt(p, "quantity").unwrap_or("1")),
                    "checkout_in_progress",
                )?;
                return Ok(json!({"operationId":old["operationId"]}));
            }
            let mut intent = json!({"operationId":id,"version":plan["version"],"quantity":opt(p,"quantity").unwrap_or("1"),"expiresAt":self.now()+24*60*60000});
            copy_optional(&mut intent, p, "entityId");
            put(tx, Table::Counters, &counter, intent, "active").await?;
            for sub in self.subscriptions_in(tx, opt(p, "entityId")).await? {
                require(
                    !(opt(&sub["plan"], "kind") != Some("free")
                        && opt(&sub["plan"], "kind") != Some("one_time")
                        && (sub["plan"]["id"] == plan["id"]
                            || (sub["plan"]["addOn"] != true
                                && plan["addOn"] != true
                                && opt(&sub["plan"], "group").unwrap_or("base")
                                    == opt(plan, "group").unwrap_or("base")))),
                    "subscription_exists",
                )?;
            }
        }
        if kind == "checkout" && p["plan"]["trialDays"].as_i64().is_some_and(|v| v > 0) {
            let used = get(tx, Table::Counters, "trial-claimed").await?.is_some();
            payload["trialAllowed"] = json!(!used);
            if !used {
                put(
                    tx,
                    Table::Counters,
                    "trial-claimed",
                    json!({"operationId":id,"createdAt":self.now()}),
                    "active",
                )
                .await?;
            }
        }
        payload["customerId"] = json!(customer);
        self.enqueue(tx, &id, kind, payload).await?;
        Ok(json!({"operationId":id}))
    }
    pub(crate) async fn local_subscription(
        &self,
        tx: &mut dyn Transaction,
        kind: &str,
        p: &Value,
        key: &str,
    ) -> Result<Value> {
        let id = s(p, "subscriptionId")?;
        let mut sub = get(tx, Table::Subscriptions, id)
            .await?
            .ok_or_else(|| BillingError::new("subscription_not_found"))?;
        if let Some(plan) = p.get("plan") {
            register_features(tx, plan).await?;
            require(opt(plan, "kind") == Some("free"), "payment_required")?;
        }
        require(
            opt(&sub["plan"], "kind") == Some("free"),
            "payment_required",
        )?;
        let mut end = n(&sub, "periodEnd")?;
        let start = n(&sub, "periodStart")?;
        let mut count = 1;
        while end <= self.now() && count < 1200 {
            end = add_interval(start, interval(&sub["plan"]), count)?;
            count += 1;
        }
        require(end > self.now(), "period_reconciliation_required")?;
        match kind {
            "preview" => {}
            "subscription_update" => {
                if let Some(quantity) = opt(p, "quantity") {
                    positive(quantity)?;
                    sub["quantity"] = json!(quantity);
                }
                if let Some(plan) = p.get("plan") {
                    if opt(p, "effective") != Some("now") {
                        sub["scheduledPlans"] = json!([{"plan":plan,"start":end,"end":add_interval(end,interval(plan),1)?}]);
                    } else {
                        let mut granted = json!({});
                        let mut until = end;
                        for g in list(tx, Table::Grants, Some("active")).await? {
                            if opt(&g, "sourceId") == Some(id)
                                && opt(&g, "origin") == Some("subscription")
                                && g["expiresAt"].as_i64().unwrap_or(i64::MAX) > self.now()
                            {
                                let f = s(&g, "feature")?;
                                granted[f] =
                                    json!(d(granted[f].as_str().map(u).transpose()?.unwrap_or(0)
                                        + amount(&g, "amount")?)?);
                                until = until.min(g["expiresAt"].as_i64().unwrap_or(i64::MAX));
                            }
                        }
                        sub["provisioningOffset"] = json!({"until":until,"granted":granted});
                        sub["plan"] = plan.clone();
                    }
                }
            }
            "subscription_cancel" => {
                let immediate = p["immediately"] == true;
                sub["cancelAtPeriodEnd"] = json!(!immediate);
                sub["periodEnd"] = json!(end);
                sub["paidThrough"] = json!(if immediate { self.now() } else { end });
                sub["scheduledPlans"] = json!([]);
                if immediate {
                    sub["status"] = json!("ended");
                }
            }
            "subscription_pause" => sub["status"] = json!("paused"),
            "subscription_resume" => {
                sub["status"] = json!("active");
                sub["cancelAtPeriodEnd"] = json!(false);
                sub["paidThrough"] = json!(9_007_199_254_740_991_i64);
            }
            "subscription_schedule" => {
                let phases = arr(p, "phases")?;
                require(!phases.is_empty() && phases.len() <= 10, "invalid_schedule")?;
                let mut start = end;
                let mut schedule = Vec::new();
                for phase in phases {
                    let plan = &phase["plan"];
                    let iterations = phase["iterations"]
                        .as_i64()
                        .filter(|v| (1..=120).contains(v))
                        .ok_or_else(|| BillingError::new("invalid_schedule"))?;
                    require(opt(plan, "kind") == Some("free"), "invalid_schedule")?;
                    let until = add_interval(start, interval(plan), iterations as u32)?;
                    schedule.push(json!({"plan":plan,"start":start,"end":until}));
                    start = until;
                }
                sub["scheduledPlans"] = json!(schedule);
            }
            _ => return Err(BillingError::new("unsupported_subscription_operation")),
        }
        if kind != "preview" {
            let state = if matches!(opt(&sub, "status"), Some("active" | "trialing")) {
                "active"
            } else {
                s(&sub, "status")?
            };
            put(tx, Table::Subscriptions, id, sub.clone(), state).await?;
            self.0.ledger.materialize(tx).await?;
            self.event(tx, s(p, "customerId")?, kind, json!({"subscriptionId":id}))
                .await?;
        }
        let id = format!("local:{key}");
        let result = if kind == "preview" {
            json!({"amountDue":"0","currency":opt(&p["plan"],"currency").unwrap_or("usd"),"effectiveAt":end})
        } else {
            sub
        };
        let work = json!({"id":id,"kind":kind,"payload":p,"status":"done","attempts":1,"availableAt":self.now(),"createdAt":self.now(),"result":result});
        put(tx, Table::Work, &id, work.clone(), "done").await?;
        Ok(work)
    }
}
