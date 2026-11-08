//! The shared ledger. All methods execute inside the caller's customer transaction.
use crate::{
    storage::{Clock, Identifiers, Transaction},
    wire::*,
};
use brokeboy_core::{
    Result,
    compatibility::{canonical_json_v1, hash_v1},
    decimal::SCALE,
    pricing::{Interval, add_interval},
    records::Table,
};
use serde_json::{Value, json};
use std::sync::Arc;

pub struct Ledger {
    pub clock: Arc<dyn Clock>,
    pub identifiers: Arc<dyn Identifiers>,
}
pub fn entitled_through(sub: &Value) -> Result<i64> {
    if opt(sub, "status") == Some("past_due") {
        Ok(sub.get("graceThrough").and_then(Value::as_i64).unwrap_or(0))
    } else {
        n(sub, "paidThrough")
    }
}
pub fn is_entitled(sub: &Value, now: i64) -> Result<bool> {
    Ok((matches!(opt(sub, "status"), Some("active" | "trialing"))
        || (opt(sub, "status") == Some("past_due")
            && sub
                .get("graceThrough")
                .and_then(Value::as_i64)
                .is_some_and(|v| v != 0)))
        && entitled_through(sub)? > now)
}
pub(crate) fn allocation_entity(item: &Value, entity: Option<&str>) -> Option<String> {
    if opt(item, "poolScope") == Some("customer") {
        None
    } else {
        entity.map(str::to_owned)
    }
}
pub async fn register_features(tx: &mut dyn Transaction, plan: &Value) -> Result<()> {
    for item in arr(plan, "items")? {
        if let Some(kind) = opt(item, "kind") {
            let key = format!("feature-kind:{}", s(item, "feature")?);
            if let Some(old) = get(tx, Table::Counters, &key).await? {
                require(opt(&old, "kind") == Some(kind), "feature_kind_conflict")?;
            } else {
                put(tx, Table::Counters, &key, json!({"kind":kind}), "active").await?;
            }
        }
    }
    Ok(())
}
fn interval(value: &str) -> Interval {
    if value == "year" {
        Interval::Year
    } else {
        Interval::Month
    }
}

impl Ledger {
    pub async fn position(&self, tx: &mut dyn Transaction, grant: &str) -> Result<Value> {
        Ok(get(tx, Table::Counters, &format!("grant:{grant}"))
            .await?
            .unwrap_or_else(empty_position))
    }
    pub async fn adjust_position(
        &self,
        tx: &mut dyn Transaction,
        grant: &str,
        spent: i128,
        held: i128,
    ) -> Result<()> {
        let previous = self.position(tx, grant).await?;
        let spent = amount(&previous, "spent")? + spent;
        let held = amount(&previous, "held")? + held;
        require(spent >= 0 && held >= 0, "ledger_invariant")?;
        put(
            tx,
            Table::Counters,
            &format!("grant:{grant}"),
            json!({"spent":d(spent)?,"held":d(held)?}),
            "active",
        )
        .await
    }
    pub async fn movement(
        &self,
        tx: &mut dyn Transaction,
        grant: &str,
        amount: i128,
        operation: &str,
        reason: &str,
        reverses: Option<&str>,
    ) -> Result<()> {
        let id = self.identifiers.next();
        let mut movement = json!({"id":id,"grantId":grant,"amount":d(amount)?,"operationId":operation,"createdAt":self.clock.now(),"reason":reason});
        if let Some(reverses) = reverses {
            movement["reverses"] = json!(reverses);
        }
        put(tx, Table::Movements, &id, movement, "active").await?;
        self.adjust_position(tx, grant, amount, 0).await
    }
    pub async fn grant(&self, tx: &mut dyn Transaction, grant: Value) -> Result<Value> {
        let id = s(&grant, "id")?.to_owned();
        if let Some(previous) = get(tx, Table::Grants, &id).await? {
            let mut a = previous.clone();
            a["createdAt"] = json!(0);
            let mut b = grant.clone();
            b["createdAt"] = json!(0);
            require(
                canonical_json_v1(&a)? == canonical_json_v1(&b)?,
                "grant_conflict",
            )?;
            return Ok(previous);
        }
        nonnegative(s(&grant, "amount")?)?;
        put(tx, Table::Grants, &id, grant.clone(), "active").await?;
        Ok(grant)
    }
    async fn grant_period(
        &self,
        tx: &mut dyn Transaction,
        sub: &Value,
        item: &Value,
        start: i64,
        end: i64,
    ) -> Result<()> {
        let phase = match opt(sub, "status") {
            Some("trialing") => "trial",
            Some("past_due") => "grace",
            _ => "paid",
        };
        let id=hash_v1(&json!({"subscription":sub["id"],"feature":item["feature"],"start":if opt(item,"reset")==Some("never"){0}else{start},"version":sub["plan"]["version"],"phase":phase,"quantity":sub["quantity"]}))?[..48].to_owned();
        if get(tx, Table::Grants, &id).await?.is_some() {
            return Ok(());
        }
        let feature = s(item, "feature")?;
        let included = match phase {
            "trial" => sub["plan"]["trialIncluded"]
                .get(feature)
                .and_then(Value::as_str)
                .unwrap_or("0"),
            "grace" => sub["plan"]["graceIncluded"]
                .get(feature)
                .and_then(Value::as_str)
                .unwrap_or("0"),
            _ => opt(item, "included").unwrap_or("0"),
        };
        let included = u(included)? * amount(sub, "quantity")? / SCALE;
        let target = opt(item, "pool").unwrap_or(feature);
        let offset = if sub.get("provisioningOffset").is_some()
            && start < n(&sub["provisioningOffset"], "until")?
        {
            u(sub["provisioningOffset"]["granted"]
                .get(target)
                .and_then(Value::as_str)
                .unwrap_or("0"))?
        } else {
            0
        };
        let once = opt(&sub["plan"], "kind") == Some("one_time");
        let mut grant = json!({"id":id,"feature":target,"amount":d((included-offset).max(0))?,"priority":0,"origin":if once{"purchase"}else{"subscription"},"sourceId":sub.get("purchaseId").unwrap_or(&sub["id"]),"createdAt":start});
        if let Some(entity) = allocation_entity(item, opt(sub, "entityId")) {
            grant["entityId"] = json!(entity);
        }
        if opt(item, "reset") != Some("never") && !once {
            grant["expiresAt"] = json!(end);
        }
        self.grant(tx, grant).await?;
        Ok(())
    }
    pub async fn materialize(&self, tx: &mut dyn Transaction) -> Result<()> {
        let now = self.clock.now();
        for mut sub in list(tx, Table::Subscriptions, Some("active")).await? {
            let id = s(&sub, "id")?.to_owned();
            if sub["cancelAtPeriodEnd"] == true && n(&sub, "periodEnd")? <= now {
                sub["status"] = json!("ended");
                sub["paidThrough"] = json!(n(&sub, "paidThrough")?.min(n(&sub, "periodEnd")?));
                put(tx, Table::Subscriptions, &id, sub, "ended").await?;
                continue;
            }
            if let Some(phases) = sub.get("scheduledPlans").and_then(Value::as_array) {
                let mut due = None;
                for phase in phases {
                    if n(phase, "start")? <= now {
                        due = Some(phase.clone());
                    }
                }
                if let Some(due) = due {
                    register_features(tx, &due["plan"]).await?;
                    let remaining: Vec<Value> = phases
                        .iter()
                        .filter(|p| p["start"].as_i64().is_some_and(|v| v > now))
                        .cloned()
                        .collect();
                    sub["plan"] = due["plan"].clone();
                    sub["periodStart"] = due["start"].clone();
                    sub["periodEnd"] = due["end"].clone();
                    sub["scheduledPlans"] = json!(remaining);
                    sub.as_object_mut().unwrap().remove("provisioningOffset");
                    put(tx, Table::Subscriptions, &id, sub.clone(), "active").await?;
                }
            }
            if !is_entitled(&sub, now)? {
                continue;
            }
            for item in arr(&sub["plan"], "items")? {
                if item.get("included").is_none() {
                    continue;
                }
                let reset = opt(item, "reset")
                    .or_else(|| opt(&sub["plan"], "interval"))
                    .unwrap_or("month");
                let origin = n(&sub, "periodStart")?;
                let through = entitled_through(&sub)?;
                let elapsed = brokeboy_core::pricing::elapsed_intervals(
                    origin,
                    now.min(through - 1),
                    interval(reset),
                )?;
                let rollover = item["rollover"]["periods"].as_i64().unwrap_or(0);
                let mut index = if reset == "never" {
                    0
                } else {
                    (elapsed - rollover - 1).max(0)
                };
                let mut start = if index == 0 {
                    origin
                } else {
                    add_interval(origin, interval(reset), index as u32)?
                };
                while start <= now && start < through && index < 1200 {
                    let once = opt(&sub["plan"], "kind") == Some("one_time");
                    let end = if reset == "never" || once {
                        9_007_199_254_740_991
                    } else {
                        add_interval(origin, interval(reset), (index + 1) as u32)?
                    };
                    self.grant_period(tx, &sub, item, start, end.min(through))
                        .await?;
                    if end > now || reset == "never" || once {
                        break;
                    }
                    start = end;
                    index += 1;
                }
            }
        }
        for r in list(tx, Table::Reservations, Some("held")).await? {
            if n(&r, "expiresAt")? <= now {
                if opt(&r, "onExpiry") == Some("settle_estimate") {
                    let mut check = r.clone();
                    check["expiresAt"] = json!(now + 1);
                    if self.reservation_funded(tx, &check).await? {
                        self.settle_allocations(
                            tx,
                            &r,
                            s(&r, "amount")?,
                            &format!("abandoned:{}", s(&r, "id")?),
                            json!({"estimated":true,"reason":"abandoned"}),
                        )
                        .await?;
                    } else {
                        self.finish_reservation(tx, &r, "reconciliation").await?;
                        let id = format!("abandoned:{}", s(&r, "id")?);
                        put(tx,Table::Work,&id,json!({"id":id,"kind":"reservation_adjustment","payload":{"reservationId":r["id"],"amount":r["amount"],"reason":"abandoned_unfunded"},"status":"reconciliation","attempts":0,"availableAt":now,"createdAt":now}),"reconciliation").await?;
                    }
                } else {
                    self.finish_reservation(tx, &r, "expired").await?;
                }
            }
        }
        for grant in list(tx, Table::Grants, Some("active")).await? {
            let Some(expiry) = grant.get("expiresAt").and_then(Value::as_i64) else {
                continue;
            };
            if expiry > now {
                continue;
            }
            let sub = get(tx, Table::Subscriptions, s(&grant, "sourceId")?).await?;
            let feature = s(&grant, "feature")?;
            let item = sub
                .as_ref()
                .and_then(|s| s["plan"]["items"].as_array())
                .and_then(|items| {
                    items
                        .iter()
                        .find(|i| opt(i, "pool").or_else(|| opt(i, "feature")) == Some(feature))
                })
                .cloned();
            let p = self.position(tx, s(&grant, "id")?).await?;
            let left = amount(&grant, "amount")? - amount(&p, "spent")? - amount(&p, "held")?;
            if let (Some(sub), Some(item)) = (sub, item)
                && item.get("rollover").is_some()
                && opt(&grant, "origin") == Some("subscription")
                && left > 0
                && n(&sub, "paidThrough")? > expiry
            {
                let mut outstanding = 0;
                for rolled in list(tx, Table::Grants, Some("active")).await? {
                    if opt(&rolled, "origin") == Some("rollover")
                        && rolled["feature"] == grant["feature"]
                        && rolled.get("entityId") == grant.get("entityId")
                        && rolled["expiresAt"].as_i64().unwrap_or(0) > now
                    {
                        let p = self.position(tx, s(&rolled, "id")?).await?;
                        outstanding +=
                            amount(&rolled, "amount")? - amount(&p, "spent")? - amount(&p, "held")?;
                    }
                }
                let cap = (amount(&item["rollover"], "maximum")? - outstanding).max(0);
                let end = add_interval(
                    expiry,
                    interval(opt(&item, "reset").unwrap_or("month")),
                    n(&item["rollover"], "periods")? as u32,
                )?;
                if end > now && cap > 0 {
                    let mut rolled = grant.clone();
                    rolled["id"] = json!(format!("roll:{}", s(&grant, "id")?));
                    rolled["amount"] = json!(d(left.min(cap))?);
                    rolled["createdAt"] = json!(expiry);
                    rolled["expiresAt"] = json!(end);
                    rolled["origin"] = json!("rollover");
                    self.grant(tx, rolled).await?;
                }
            }
            put(
                tx,
                Table::Grants,
                s(&grant, "id")?,
                grant.clone(),
                "expired",
            )
            .await?;
        }
        Ok(())
    }
    pub async fn usable_grants(
        &self,
        tx: &mut dyn Transaction,
        feature: &str,
        entity: Option<&str>,
    ) -> Result<Vec<Value>> {
        let mut result = Vec::new();
        for grant in list(tx, Table::Grants, Some("active")).await? {
            if opt(&grant, "feature") != Some(feature)
                || opt(&grant, "entityId") != entity
                || grant["expiresAt"]
                    .as_i64()
                    .is_some_and(|v| v <= self.clock.now())
            {
                continue;
            }
            if matches!(opt(&grant, "origin"), Some("subscription" | "rollover")) {
                let source = get(tx, Table::Subscriptions, s(&grant, "sourceId")?).await?;
                if let Some(source) = source {
                    if !is_entitled(&source, self.clock.now())? {
                        continue;
                    }
                } else {
                    continue;
                }
            }
            result.push(grant);
        }
        Ok(result)
    }
    pub async fn balance(
        &self,
        tx: &mut dyn Transaction,
        feature: &str,
        entity: Option<&str>,
    ) -> Result<Value> {
        let (mut granted, mut spent, mut held) = (0, 0, 0);
        for grant in self.usable_grants(tx, feature, entity).await? {
            let p = self.position(tx, s(&grant, "id")?).await?;
            granted += amount(&grant, "amount")?;
            spent += amount(&p, "spent")?;
            held += amount(&p, "held")?;
        }
        Ok(
            json!({"feature":feature,"granted":d(granted)?,"spent":d(spent)?,"reserved":d(held)?,"available":d(granted-spent-held)?}),
        )
    }
    pub async fn allocate(
        &self,
        tx: &mut dyn Transaction,
        feature: &str,
        requested: i128,
        entity: Option<&str>,
        hold: bool,
        operation: &str,
    ) -> Result<Vec<Value>> {
        let mut grants = self.usable_grants(tx, feature, entity).await?;
        let collator = icu_collator::Collator::try_new(Default::default(), Default::default())
            .map_err(|_| brokeboy_core::BillingError::new("collation_unavailable"))?;
        // Validate sort fields first: malformed records must not silently win allocation.
        for grant in &grants {
            n(grant, "priority")?;
            n(grant, "createdAt")?;
            s(grant, "id")?;
        }
        grants.sort_by(|a, b| {
            a["priority"]
                .as_i64()
                .cmp(&b["priority"].as_i64())
                .then_with(|| {
                    a["expiresAt"]
                        .as_i64()
                        .unwrap_or(i64::MAX)
                        .cmp(&b["expiresAt"].as_i64().unwrap_or(i64::MAX))
                })
                .then_with(|| a["createdAt"].as_i64().cmp(&b["createdAt"].as_i64()))
                .then_with(|| {
                    collator.compare(a["id"].as_str().unwrap(), b["id"].as_str().unwrap())
                })
        });
        let mut result = Vec::new();
        let mut remaining = requested;
        for grant in grants {
            let id = s(&grant, "id")?;
            let p = self.position(tx, id).await?;
            let take = (amount(&grant, "amount")? - amount(&p, "spent")? - amount(&p, "held")?)
                .min(remaining);
            if take <= 0 {
                continue;
            }
            if hold {
                self.adjust_position(tx, id, 0, take).await?;
            } else {
                self.movement(tx, id, take, operation, "consume", None)
                    .await?;
            }
            result.push(json!({"grantId":id,"amount":d(take)?}));
            remaining -= take;
            if remaining == 0 {
                break;
            }
        }
        require(remaining == 0, "insufficient_balance")?;
        Ok(result)
    }
    pub async fn reserve(
        &self,
        tx: &mut dyn Transaction,
        input: Value,
        operation: &str,
    ) -> Result<Value> {
        let expiry = brokeboy_core::error::timestamp(n(&input, "expiresAt")?)?;
        require(expiry > self.clock.now(), "invalid_expiry")?;
        let entity = if opt(&input, "poolScope") == Some("customer") {
            None
        } else {
            opt(&input, "entityId")
        };
        let allocations = self
            .allocate(
                tx,
                s(&input, "feature")?,
                nonnegative(s(&input, "amount")?)?,
                entity,
                true,
                operation,
            )
            .await?;
        let mut expiry = expiry;
        for a in &allocations {
            let grant = get(tx, Table::Grants, s(a, "grantId")?)
                .await?
                .ok_or_else(|| brokeboy_core::BillingError::new("grant_not_found"))?;
            expiry = expiry.min(grant["expiresAt"].as_i64().unwrap_or(i64::MAX));
        }
        let id = self.identifiers.next();
        let mut r = input;
        r["id"] = json!(id);
        r["allocations"] = json!(allocations);
        r["expiresAt"] = json!(expiry);
        r["status"] = json!("held");
        put(tx, Table::Reservations, &id, r.clone(), "held").await?;
        Ok(r)
    }
    pub async fn reservation_funded(&self, tx: &mut dyn Transaction, r: &Value) -> Result<bool> {
        if opt(r, "status") != Some("held") || n(r, "expiresAt")? <= self.clock.now() {
            return Ok(false);
        }
        for a in arr(r, "allocations")? {
            let Some(row) = tx.get(Table::Grants, s(a, "grantId")?).await? else {
                return Ok(false);
            };
            let grant = row.data;
            if row.state != "active"
                || grant["expiresAt"]
                    .as_i64()
                    .is_some_and(|v| v <= self.clock.now())
            {
                return Ok(false);
            }
            if matches!(opt(&grant, "origin"), Some("subscription" | "rollover")) {
                let Some(source) = get(tx, Table::Subscriptions, s(&grant, "sourceId")?).await?
                else {
                    return Ok(false);
                };
                if !is_entitled(&source, self.clock.now())? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
    pub async fn increase_reservation(
        &self,
        tx: &mut dyn Transaction,
        r: &Value,
        extra: &str,
        operation: &str,
    ) -> Result<Value> {
        require(
            self.reservation_funded(tx, r).await?,
            "reservation_not_held",
        )?;
        let entity = if opt(r, "poolScope") == Some("customer") {
            None
        } else {
            opt(r, "entityId")
        };
        let allocations = self
            .allocate(
                tx,
                s(r, "feature")?,
                positive(extra)?,
                entity,
                true,
                operation,
            )
            .await?;
        let mut end = n(r, "expiresAt")?;
        for a in &allocations {
            let g = get(tx, Table::Grants, s(a, "grantId")?)
                .await?
                .ok_or_else(|| brokeboy_core::BillingError::new("grant_not_found"))?;
            end = end.min(g["expiresAt"].as_i64().unwrap_or(i64::MAX));
        }
        let mut next = r.clone();
        next["amount"] = json!(d(amount(r, "amount")? + u(extra)?)?);
        next["expiresAt"] = json!(end);
        next["allocations"]
            .as_array_mut()
            .ok_or_else(|| brokeboy_core::BillingError::new("invalid_record"))?
            .extend(allocations);
        put(tx, Table::Reservations, s(r, "id")?, next.clone(), "held").await?;
        Ok(next)
    }
    pub async fn settle_reservation(
        &self,
        tx: &mut dyn Transaction,
        r: &Value,
        actual: &str,
        operation: &str,
        properties: Value,
    ) -> Result<Value> {
        require(
            self.reservation_funded(tx, r).await?,
            "reservation_not_held",
        )?;
        self.settle_allocations(tx, r, actual, operation, properties)
            .await
    }
    async fn settle_allocations(
        &self,
        tx: &mut dyn Transaction,
        r: &Value,
        actual: &str,
        operation: &str,
        properties: Value,
    ) -> Result<Value> {
        let mut left = nonnegative(actual)?;
        require(left <= amount(r, "amount")?, "reservation_exceeded")?;
        let mut used = Vec::new();
        for a in arr(r, "allocations")? {
            let take = amount(a, "amount")?.min(left);
            let grant = s(a, "grantId")?;
            self.adjust_position(tx, grant, 0, -amount(a, "amount")?)
                .await?;
            if take > 0 {
                self.movement(tx, grant, take, operation, "settle", None)
                    .await?;
                used.push(json!({"grantId":grant,"amount":d(take)?}));
                left -= take;
            }
        }
        let mut settled = r.clone();
        settled["status"] = json!("settled");
        put(tx, Table::Reservations, s(r, "id")?, settled, "settled").await?;
        let id = self.identifiers.next();
        let mut properties = properties;
        properties["reservationId"] = r["id"].clone();
        let mut usage = json!({"id":id,"feature":r["feature"],"quantity":actual,"charged":actual,"allocations":used,"createdAt":self.clock.now(),"properties":properties});
        copy_optional(&mut usage, r, "entityId");
        put(tx, Table::Usage, &id, usage.clone(), "active").await?;
        Ok(usage)
    }
    pub async fn finish_reservation(
        &self,
        tx: &mut dyn Transaction,
        r: &Value,
        status: &str,
    ) -> Result<Value> {
        for a in arr(r, "allocations")? {
            self.adjust_position(tx, s(a, "grantId")?, 0, -amount(a, "amount")?)
                .await?;
        }
        let mut next = r.clone();
        next["status"] = json!(status);
        put(tx, Table::Reservations, s(r, "id")?, next.clone(), status).await?;
        Ok(next)
    }
    pub async fn reconcile(&self, tx: &mut dyn Transaction) -> Result<Value> {
        let movements = list(tx, Table::Movements, None).await?;
        let reservations = list(tx, Table::Reservations, Some("held")).await?;
        let mut mismatches = Vec::new();
        for g in list(tx, Table::Grants, None).await? {
            let id = s(&g, "id")?;
            let mut spent = 0;
            let mut held = 0;
            for m in &movements {
                if opt(m, "grantId") == Some(id) {
                    spent += amount(m, "amount")?;
                }
            }
            for r in &reservations {
                for a in arr(r, "allocations")? {
                    if opt(a, "grantId") == Some(id) {
                        held += amount(a, "amount")?;
                    }
                }
            }
            let p = self.position(tx, id).await?;
            if amount(&p, "spent")? != spent
                || amount(&p, "held")? != held
                || spent < 0
                || held < 0
                || spent + held > amount(&g, "amount")?
            {
                mismatches.push(
                    json!({"grantId":id,"expected":{"spent":d(spent)?,"held":d(held)?},"actual":p}),
                );
            }
        }
        Ok(json!({"consistent":mismatches.is_empty(),"mismatches":mismatches}))
    }
}
