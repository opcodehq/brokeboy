use super::usage::rate;
use super::*;
use crate::ledger::{allocation_entity, register_features};
use brokeboy_core::{
    compatibility::{hash_v1, operation_hash},
    decimal::SCALE,
    error::timestamp,
    pricing::{Interval, add_interval},
};
use std::collections::BTreeSet;
impl Billing {
    pub(crate) async fn write_action(
        &self,
        tx: &mut dyn Transaction,
        method: &str,
        p: &Value,
        key: &str,
    ) -> Result<Value> {
        if let Some(kind) = method.strip_prefix("local.") {
            return self.local_subscription(tx, kind, p, key).await;
        }
        if let Some(kind) = method.strip_prefix("payment.") {
            return self.payment_intent(tx, kind, p, key).await;
        }
        if method.starts_with("workflows.") {
            return self.workflow_action(tx, method, p, key).await;
        }
        if method.starts_with("periods.") {
            return self.period_action(tx, method, p, key).await;
        }
        match method {
            "operations.retry" => {
                let row = tx
                    .get(Table::Work, s(p, "operationId")?)
                    .await?
                    .ok_or_else(|| BillingError::new("operation_not_found"))?;
                require(row.state != "reconciliation", "reconciliation_required")?;
                require(
                    row.state != "processing"
                        || row.data["leaseUntil"].as_i64().unwrap_or(0) <= self.now(),
                    "operation_in_progress",
                )?;
                if row.state != "done" {
                    let mut work = row.data;
                    work["status"] = json!("pending");
                    work["availableAt"] = json!(self.now());
                    put(tx, Table::Work, &row.id, work, "pending").await?;
                }
                Ok(json!({"id":row.id}))
            }
            "operations.resolve" => {
                require(!s(p, "resolution")?.trim().is_empty(), "reason_required")?;
                let row = tx
                    .get(Table::Work, s(p, "operationId")?)
                    .await?
                    .ok_or_else(|| BillingError::new("operation_not_reconcilable"))?;
                require(row.state == "reconciliation", "operation_not_reconcilable")?;
                let mut work = row.data;
                work["status"] = json!("done");
                work["result"]=p.get("result").filter(|v|!v.is_null()).cloned().unwrap_or(json!({"resolution":p["resolution"],"outcome":opt(p,"outcome").unwrap_or("completed")}));
                put(tx, Table::Work, &row.id, work.clone(), "done").await?;
                if opt(p, "outcome") == Some("not_executed") {
                    for mut intent in tx.list(Table::Counters, None).await? {
                        if intent.id.starts_with("checkout:")
                            && opt(&intent.data, "operationId") == Some(row.id.as_str())
                        {
                            intent.data["expiresAt"] = json!(0);
                            put(tx, Table::Counters, &intent.id, intent.data, "active").await?;
                        }
                    }
                    if opt(&work, "kind") == Some("auto_topup") {
                        let counter = s(&work["payload"], "counter")?;
                        if let Some(current) = get(tx, Table::Counters, counter).await?
                            && opt(&current, "pending") == Some(row.id.as_str())
                        {
                            put(
                                tx,
                                Table::Counters,
                                counter,
                                json!({"count":current["count"]}),
                                "active",
                            )
                            .await?;
                            put(tx, Table::Counters, "topup-pending", json!({}), "active").await?;
                        }
                    }
                }
                self.event(tx, s(p, "customerId")?, "operation.resolved", p.clone())
                    .await?;
                Ok(json!({"resolved":true}))
            }
            "customers.create" => {
                let id = s(p, "id")?;
                if let Some(old) = get(tx, Table::Customers, id).await? {
                    return Ok(old);
                }
                let mut c = json!({"id":id,"metadata":p.get("metadata").cloned().unwrap_or(json!({})),"controls":{}});
                copy_optional(&mut c, p, "stripeCustomerId");
                put(tx, Table::Customers, id, c.clone(), "active").await?;
                Ok(c)
            }
            "customers.update" => {
                let id = s(p, "customerId")?;
                let mut c = self.customer(tx, id).await?;
                require(
                    opt(p, "stripeCustomerId").is_none()
                        || opt(&c, "stripeCustomerId").is_none()
                        || p["stripeCustomerId"] == c["stripeCustomerId"],
                    "customer_mapping_conflict",
                )?;
                for field in ["metadata", "stripeCustomerId"] {
                    copy_optional(&mut c, p, field);
                }
                put(tx, Table::Customers, id, c.clone(), "active").await?;
                Ok(c)
            }
            "entities.create" | "entities.update" => {
                let id = identifier(s(p, "id")?)?;
                let old = get(tx, Table::Entities, id).await?;
                require(
                    if method.ends_with("create") {
                        old.is_none()
                    } else {
                        old.is_some()
                    },
                    if method.ends_with("create") {
                        "entity_exists"
                    } else {
                        "entity_not_found"
                    },
                )?;
                let e = json!({"id":id,"metadata":p.get("metadata").cloned().unwrap_or(json!({}))});
                put(tx, Table::Entities, id, e.clone(), "active").await?;
                Ok(e)
            }
            "credits.grant" => {
                positive(s(p, "amount")?)?;
                let priority = p["priority"].as_i64().unwrap_or(0);
                require(
                    p.get("priority").is_none()
                        || p["priority"].as_i64().is_some_and(|v| {
                            (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&v)
                        }),
                    "invalid_priority",
                )?;
                identifier(s(p, "feature")?)?;
                if p.get("expiresAt").is_some() {
                    require(
                        timestamp(n(p, "expiresAt")?)? > self.now(),
                        "invalid_expiry",
                    )?;
                }
                let id = hash_v1(&json!({"key":key,"feature":p["feature"]}))?;
                let mut g = json!({"id":id,"feature":p["feature"],"amount":p["amount"],"priority":priority,"origin":opt(p,"origin").unwrap_or("manual"),"sourceId":opt(p,"sourceId").unwrap_or(key),"createdAt":self.now()});
                copy_optional(&mut g, p, "entityId");
                copy_optional(&mut g, p, "expiresAt");
                self.0.ledger.grant(tx, g.clone()).await?;
                self.event(tx, s(p, "customerId")?, "credits.granted", g.clone())
                    .await?;
                Ok(g)
            }
            "credits.adjust" => {
                require(!s(p, "reason")?.trim().is_empty(), "reason_required")?;
                let g = get(tx, Table::Grants, s(p, "grantId")?)
                    .await?
                    .ok_or_else(|| BillingError::new("grant_not_found"))?;
                let value = amount(p, "amount")?;
                let position = self.0.ledger.position(tx, s(&g, "id")?).await?;
                require(
                    amount(&position, "spent")? + value >= 0
                        && amount(&position, "spent")? + amount(&position, "held")? + value
                            <= amount(&g, "amount")?,
                    "invalid_adjustment",
                )?;
                self.0
                    .ledger
                    .movement(tx, s(&g, "id")?, value, key, s(p, "reason")?, None)
                    .await?;
                self.event(
                    tx,
                    s(p, "customerId")?,
                    "credits.adjusted",
                    json!({"grantId":g["id"],"amount":p["amount"],"reason":p["reason"]}),
                )
                .await?;
                self.0
                    .ledger
                    .balance(tx, s(&g, "feature")?, opt(&g, "entityId"))
                    .await
            }
            "subscriptions.attach" => {
                let plan = &p["plan"];
                let entity = opt(p, "entityId");
                let subs = self.subscriptions_in(tx, entity).await?;
                if let Some(old) = subs.iter().find(|s| {
                    (opt(&s["plan"], "kind") != Some("one_time")
                        && s["plan"]["addOn"] != true
                        && plan["addOn"] != true
                        && opt(&s["plan"], "group").unwrap_or("base")
                            == opt(plan, "group").unwrap_or("base"))
                        || s["plan"]["id"] == plan["id"]
                }) {
                    require(old["plan"]["id"] == plan["id"], "subscription_exists")?;
                    return Ok(old.clone());
                }
                let mut identity = json!({"plan":plan["id"]});
                if let Some(e) = entity {
                    identity["entity"] = json!(e);
                }
                let id = hash_v1(&identity)?;
                let interval = if opt(plan, "interval") == Some("year") {
                    Interval::Year
                } else {
                    Interval::Month
                };
                let mut sub = json!({"id":id,"plan":plan,"status":"active","periodStart":self.now(),"periodEnd":add_interval(self.now(),interval,1)?,"paidThrough":9_007_199_254_740_991_i64,"quantity":opt(p,"quantity").unwrap_or("1")});
                copy_optional(&mut sub, p, "entityId");
                positive(s(&sub, "quantity")?)?;
                register_features(tx, plan).await?;
                put(tx, Table::Subscriptions, &id, sub.clone(), "active").await?;
                self.0.ledger.materialize(tx).await?;
                Ok(sub)
            }
            "usage.consume" | "usage.record" => self.consume(tx, p, key).await,
            "usage.batch" => {
                let events = arr(p, "events")?;
                require(
                    !events.is_empty() && events.len() <= 100,
                    "invalid_batch_size",
                )?;
                let mut seen = BTreeSet::new();
                for e in events {
                    let k = s(e, "idempotencyKey")?;
                    require(k != key && seen.insert(k), "duplicate_batch_key")?;
                }
                let mut receipts = Vec::new();
                for e in events {
                    let mut e = e.clone();
                    e["customerId"] = p["customerId"].clone();
                    let digest = operation_hash("usage.consume", &e)?;
                    let k = identifier(s(&e, "idempotencyKey")?)?;
                    if let Some(old) = get(tx, Table::Operations, k).await? {
                        require(
                            opt(&old, "hash") == Some(digest.as_str()),
                            "idempotency_conflict",
                        )?;
                        receipts.push(old["result"].clone());
                        continue;
                    }
                    if let Some(entity) = opt(&e, "entityId") {
                        require(
                            get(tx, Table::Entities, identifier(entity)?)
                                .await?
                                .is_some(),
                            "entity_not_found",
                        )?;
                    }
                    let receipt = self.consume(tx, &e, k).await?;
                    put(
                        tx,
                        Table::Operations,
                        k,
                        json!({"hash":digest,"result":receipt,"createdAt":self.now()}),
                        "active",
                    )
                    .await?;
                    receipts.push(receipt);
                }
                Ok(json!({"receipts":receipts}))
            }
            "usage.correct" => {
                require(!s(p, "reason")?.trim().is_empty(), "reason_required")?;
                let row = tx
                    .get(Table::Usage, s(p, "usageId")?)
                    .await?
                    .ok_or_else(|| BillingError::new("usage_not_found"))?;
                require(row.state != "reversed", "already_corrected")?;
                let old = row.data;
                if opt(&old, "currency").is_some() && amount(&old, "charged")? != 0 {
                    let id = self.id();
                    self.enqueue(
                        tx,
                        &id,
                        "adjustment",
                        json!({"usage":old,"reason":p["reason"]}),
                    )
                    .await?;
                    let mut w = get(tx, Table::Work, &id).await?.unwrap();
                    w["status"] = json!("reconciliation");
                    put(tx, Table::Work, &id, w, "reconciliation").await?;
                    return Ok(json!({"status":"reconciliation","operationId":id}));
                }
                for a in arr(&old, "allocations")? {
                    self.0
                        .ledger
                        .movement(
                            tx,
                            s(a, "grantId")?,
                            -amount(a, "amount")?,
                            key,
                            s(p, "reason")?,
                            Some(s(&old, "id")?),
                        )
                        .await?;
                }
                let mut c = old.clone();
                let id = self.id();
                c["id"] = json!(id);
                c["quantity"] = json!(d(-amount(&old, "quantity")?)?);
                c["charged"] = json!(d(-amount(&old, "charged")?)?);
                c["reverses"] = old["id"].clone();
                c["createdAt"] = json!(self.now());
                let mut allocations = Vec::new();
                for a in arr(&old, "allocations")? {
                    let mut a = a.clone();
                    a["amount"] = json!(d(-amount(&a, "amount")?)?);
                    allocations.push(a);
                }
                c["allocations"] = json!(allocations);
                put(tx, Table::Usage, &id, c.clone(), "active").await?;
                put(tx, Table::Usage, s(&old, "id")?, old.clone(), "reversed").await?;
                self.event(tx, s(p, "customerId")?, "usage.corrected", c.clone())
                    .await?;
                Ok(json!({"status":"corrected","usage":c}))
            }
            "reservations.create" => {
                self.0.ledger.materialize(tx).await?;
                positive(s(p, "amount")?)?;
                let mapped = self.item(tx, s(p, "feature")?, opt(p, "entityId")).await?;
                let i = mapped
                    .as_ref()
                    .map(|(i, _)| i)
                    .cloned()
                    .unwrap_or(json!({}));
                require(i["overage"] != true, "reservation_overage_unsupported")?;
                let target = opt(&i, "pool").unwrap_or(s(p, "feature")?);
                let value = if i.get("pool").is_some() && i.get("rate").is_some() {
                    d(rate(
                        &i["rate"],
                        s(p, "amount")?,
                        p.get("properties").unwrap_or(&json!({})),
                    )?)?
                } else {
                    s(p, "amount")?.into()
                };
                let mut input = json!({"feature":target,"amount":value,"expiresAt":p["expiresAt"].as_i64().unwrap_or(self.now()+15*60000)});
                copy_optional(&mut input, p, "entityId");
                copy_optional(&mut input, &i, "poolScope");
                if let Some(policy) = p.get("onExpiry") {
                    require(
                        policy == "release" || policy == "settle_estimate",
                        "invalid_expiry_policy",
                    )?;
                    input["onExpiry"] = policy.clone();
                }
                self.0.ledger.reserve(tx, input, key).await
            }
            "reservations.increase" => {
                self.0.ledger.materialize(tx).await?;
                let r = tx
                    .get(Table::Reservations, s(p, "reservationId")?)
                    .await?
                    .ok_or_else(|| BillingError::new("reservation_not_held"))?;
                require(r.state == "held", "reservation_not_held")?;
                self.0
                    .ledger
                    .increase_reservation(tx, &r.data, s(p, "amount")?, key)
                    .await
            }
            "reservations.release" => {
                self.0.ledger.materialize(tx).await?;
                let r = tx
                    .get(Table::Reservations, s(p, "reservationId")?)
                    .await?
                    .ok_or_else(|| BillingError::new("reservation_not_found"))?;
                if r.state != "held" {
                    return Ok(r.data);
                }
                self.0
                    .ledger
                    .finish_reservation(tx, &r.data, "released")
                    .await
            }
            "reservations.settle" => {
                self.0.ledger.materialize(tx).await?;
                let row = tx
                    .get(Table::Reservations, s(p, "reservationId")?)
                    .await?
                    .ok_or_else(|| BillingError::new("reservation_not_found"))?;
                nonnegative(s(p, "amount")?)?;
                let r = row.data;
                if row.state != "held"
                    || !self.0.ledger.reservation_funded(tx, &r).await?
                    || amount(p, "amount")? > amount(&r, "amount")?
                {
                    let id = self.id();
                    self.enqueue(
                        tx,
                        &id,
                        "reservation_adjustment",
                        json!({"reservationId":r["id"],"amount":p["amount"]}),
                    )
                    .await?;
                    let mut w = get(tx, Table::Work, &id).await?.unwrap();
                    w["status"] = json!("reconciliation");
                    put(tx, Table::Work, &id, w, "reconciliation").await?;
                    return Ok(json!({"status":"reconciliation","operationId":id}));
                }
                let usage = self
                    .0
                    .ledger
                    .settle_reservation(tx, &r, s(p, "amount")?, key, json!({}))
                    .await?;
                let mut next = r.clone();
                next["status"] = json!("settled");
                let e = allocation_entity(&r, opt(&r, "entityId"));
                self.after_usage(tx, s(p, "customerId")?, s(&r, "feature")?, e.as_deref())
                    .await?;
                Ok(json!({"status":"settled","reservation":next,"usage":usage}))
            }
            "controls.update" => {
                let c = &p["controls"];
                if let Some(limits) = c["overageLimits"].as_object() {
                    for v in limits.values() {
                        nonnegative(
                            v.as_str()
                                .ok_or_else(|| BillingError::new("invalid_decimal"))?,
                        )?;
                    }
                }
                if let Some(alerts) = c["alerts"].as_array() {
                    for a in alerts {
                        nonnegative(s(a, "remaining")?)?;
                    }
                }
                if let Some(t) = c.get("autoTopUp") {
                    nonnegative(s(t, "below")?)?;
                    require(
                        t["maximumPurchases"].as_i64().is_some_and(|v| v > 0),
                        "invalid_topup_limit",
                    )?;
                }
                let id = s(p, "customerId")?;
                let mut customer = self.customer(tx, id).await?;
                customer["controls"] = c.clone();
                put(tx, Table::Customers, id, customer, "active").await?;
                if let Some(t) = c.get("autoTopUp") {
                    self.after_usage(tx, id, s(t, "feature")?, None).await?;
                }
                Ok(c.clone())
            }
            "usage.setQuantity" => self.set_quantity(tx, p, key).await,
            "licenses.assign" | "licenses.release" => self.license(tx, method, p, key).await,
            _ => Err(BillingError::message(
                "unknown_method",
                &format!("Unknown native billing method: {method}"),
            )),
        }
    }
    async fn set_quantity(&self, tx: &mut dyn Transaction, p: &Value, key: &str) -> Result<Value> {
        self.0.ledger.materialize(tx).await?;
        let value = nonnegative(s(p, "amount")?)?;
        let feature = s(p, "feature")?;
        let entity = opt(p, "entityId");
        if let Some(capacity) = self.quantity_capacity(tx, feature, entity).await? {
            let assignments = if entity.is_some() {
                0
            } else {
                list(tx, Table::Licenses, Some("active"))
                    .await?
                    .iter()
                    .filter(|l| opt(l, "feature") == Some(feature))
                    .count() as i128
                    * SCALE
            };
            require(value + assignments <= capacity, "quantity_limit_exceeded")?;
        }
        let mut identity = json!({"feature":feature});
        if let Some(e) = entity {
            identity["entity"] = json!(e);
        }
        let id = hash_v1(&identity)?;
        let counter = format!("quantity:{id}");
        let previous = get(tx, Table::Counters, &counter)
            .await?
            .unwrap_or(json!({"amount":"0","allocations":[]}));
        let mut allocations = arr(&previous, "allocations")?.to_vec();
        let delta = value - amount(&previous, "amount")?;
        if delta > 0 {
            allocations.extend(
                self.0
                    .ledger
                    .allocate(tx, feature, delta, entity, false, key)
                    .await?,
            );
        } else {
            let mut left = -delta;
            for a in allocations.iter_mut().rev() {
                let give = amount(a, "amount")?.min(left);
                if give > 0 {
                    self.0
                        .ledger
                        .movement(tx, s(a, "grantId")?, -give, key, "quantity_release", None)
                        .await?;
                    a["amount"] = json!(d(amount(a, "amount")? - give)?);
                    left -= give;
                }
            }
            let mut remaining = Vec::new();
            for a in allocations {
                if amount(&a, "amount")? > 0 {
                    remaining.push(a);
                }
            }
            allocations = remaining;
        }
        put(
            tx,
            Table::Counters,
            &counter,
            json!({"amount":p["amount"],"allocations":allocations}),
            "active",
        )
        .await?;
        Ok(json!({"amount":p["amount"]}))
    }
    async fn license(
        &self,
        tx: &mut dyn Transaction,
        method: &str,
        p: &Value,
        key: &str,
    ) -> Result<Value> {
        if method == "licenses.release" {
            let r = tx
                .get(Table::Licenses, s(p, "licenseId")?)
                .await?
                .ok_or_else(|| BillingError::new("license_not_found"))?;
            require(r.state == "active", "license_not_found")?;
            for a in arr(&r.data, "allocations")? {
                self.0
                    .ledger
                    .movement(
                        tx,
                        s(a, "grantId")?,
                        -amount(a, "amount")?,
                        key,
                        "license_release",
                        None,
                    )
                    .await?;
            }
            put(tx, Table::Licenses, &r.id, r.data, "released").await?;
            return Ok(json!({"released":true}));
        }
        let id = hash_v1(&json!({"feature":p["feature"],"entity":p["entityId"]}))?;
        require(
            tx.get(Table::Licenses, &id)
                .await?
                .is_none_or(|r| r.state != "active"),
            "license_already_assigned",
        )?;
        self.0.ledger.materialize(tx).await?;
        let feature = s(p, "feature")?;
        if let Some(capacity) = self.quantity_capacity(tx, feature, None).await? {
            require(
                self.occupied(tx, feature, None).await? + SCALE <= capacity,
                "quantity_limit_exceeded",
            )?;
        }
        let allocations = self
            .0
            .ledger
            .allocate(tx, feature, SCALE, None, false, key)
            .await?;
        put(
            tx,
            Table::Licenses,
            &id,
            json!({"id":id,"entityId":p["entityId"],"feature":feature,"allocations":allocations}),
            "active",
        )
        .await?;
        Ok(json!({"id":id}))
    }
}
