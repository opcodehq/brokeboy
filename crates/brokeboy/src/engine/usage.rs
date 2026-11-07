use super::*;
use crate::ledger::{allocation_entity, is_entitled};
use brokeboy_core::{
    compatibility::{canonical_json_v1, hash_v1},
    decimal::{Decimal, SCALE},
    pricing::Rate,
};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn rate(schedule: &Value, quantity: &str, properties: &Value) -> Result<i128> {
    let schedule: Rate =
        serde_json::from_value(schedule.clone()).map_err(|_| BillingError::new("invalid_rate"))?;
    let properties: BTreeMap<String, String> = serde_json::from_value(properties.clone())
        .map_err(|_| BillingError::new("invalid_properties"))?;
    Ok(schedule
        .rate(quantity.parse::<Decimal>()?, &properties)?
        .scaled())
}
impl Billing {
    pub(crate) async fn subscriptions_in(
        &self,
        tx: &mut dyn Transaction,
        entity: Option<&str>,
    ) -> Result<Vec<Value>> {
        let mut result = Vec::new();
        for sub in list(tx, Table::Subscriptions, Some("active")).await? {
            if opt(&sub, "entityId") == entity && is_entitled(&sub, self.now())? {
                result.push(sub);
            }
        }
        Ok(result)
    }
    pub(crate) async fn item(
        &self,
        tx: &mut dyn Transaction,
        feature: &str,
        entity: Option<&str>,
    ) -> Result<Option<(Value, Value)>> {
        let mut found = Vec::new();
        for sub in self.subscriptions_in(tx, entity).await? {
            for item in arr(&sub["plan"], "items")? {
                if opt(item, "feature") == Some(feature) {
                    found.push((item.clone(), sub.clone()));
                }
            }
        }
        let priced: Vec<_> = found
            .iter()
            .filter(|(i, _)| {
                i.get("rate").is_some() || i["overage"] == true || opt(i, "pool").is_some()
            })
            .collect();
        let mut identities = BTreeSet::new();
        for (i, _) in &priced {
            let mut identity = json!({});
            for key in ["rate", "pool", "poolScope", "overage"] {
                copy_optional(&mut identity, i, key);
            }
            identities.insert(canonical_json_v1(&identity)?);
        }
        require(identities.len() <= 1, "ambiguous_feature_rate")?;
        Ok(priced
            .first()
            .map(|v| (*v).clone())
            .or_else(|| found.iter().find(|(i, _)| i["enabled"] == true).cloned())
            .or_else(|| found.into_iter().next()))
    }
    pub(crate) async fn quantity_capacity(
        &self,
        tx: &mut dyn Transaction,
        feature: &str,
        entity: Option<&str>,
    ) -> Result<Option<i128>> {
        let kind = get(tx, Table::Counters, &format!("feature-kind:{feature}")).await?;
        if kind.as_ref().and_then(|v| opt(v, "kind")) != Some("quantity") {
            return Ok(None);
        }
        let subs = self.subscriptions_in(tx, entity).await?;
        let mut capacity = 0;
        for sub in &subs {
            if let Some(item) = arr(&sub["plan"], "items")?
                .iter()
                .find(|i| opt(i, "feature") == Some(feature))
            {
                capacity += optional_amount(item, "included")? * amount(sub, "quantity")? / SCALE;
            }
        }
        for g in self.0.ledger.usable_grants(tx, feature, entity).await? {
            if opt(&g, "origin") == Some("manual")
                || (opt(&g, "origin") == Some("purchase")
                    && !subs
                        .iter()
                        .any(|s| s.get("purchaseId") == g.get("sourceId")))
            {
                capacity += amount(&g, "amount")?;
            }
        }
        Ok(Some(capacity))
    }
    pub(crate) async fn occupied(
        &self,
        tx: &mut dyn Transaction,
        feature: &str,
        entity: Option<&str>,
    ) -> Result<i128> {
        let mut identity = json!({"feature":feature});
        if let Some(entity) = entity {
            identity["entity"] = json!(entity);
        }
        let id = hash_v1(&identity)?;
        let quantity = get(tx, Table::Counters, &format!("quantity:{id}"))
            .await?
            .unwrap_or(json!({"amount":"0"}));
        let count = if entity.is_some() {
            0
        } else {
            list(tx, Table::Licenses, Some("active"))
                .await?
                .iter()
                .filter(|r| opt(r, "feature") == Some(feature))
                .count() as i128
                * SCALE
        };
        Ok(amount(&quantity, "amount")? + count)
    }
    pub(crate) async fn balance_for(
        &self,
        tx: &mut dyn Transaction,
        feature: &str,
        entity: Option<&str>,
    ) -> Result<Value> {
        if let Some(capacity) = self.quantity_capacity(tx, feature, entity).await? {
            let used = self.occupied(tx, feature, entity).await?;
            Ok(
                json!({"feature":feature,"granted":d(capacity)?,"spent":d(used)?,"reserved":"0","available":d(capacity-used)?}),
            )
        } else {
            self.0.ledger.balance(tx, feature, entity).await
        }
    }
    pub(crate) async fn after_usage(
        &self,
        tx: &mut dyn Transaction,
        customer: &str,
        feature: &str,
        entity: Option<&str>,
    ) -> Result<()> {
        let c = self.customer(tx, customer).await?;
        let b = self.balance_for(tx, feature, entity).await?;
        let now = brokeboy_core::pricing::iso_date(self.now())?;
        if let Some(alerts) = c["controls"]["alerts"].as_array() {
            for alert in alerts {
                if opt(alert, "feature") == Some(feature)
                    && amount(&b, "available")? <= amount(alert, "remaining")?
                {
                    let id = format!("alert:{feature}:{}:{}", s(alert, "remaining")?, now);
                    if get(tx, Table::Counters, &id).await?.is_none() {
                        put(tx, Table::Counters, &id, json!({"sent":true}), "active").await?;
                        self.event(tx, customer, "balance.threshold", b.clone())
                            .await?;
                    }
                }
            }
        }
        if let Some(t) = c["controls"].get("autoTopUp")
            && opt(t, "feature") == Some(feature)
            && amount(&b, "available")? < amount(t, "below")?
        {
            let counter = format!("topup:{}", &now[..7]);
            let previous = get(tx, Table::Counters, &counter)
                .await?
                .unwrap_or(json!({"count":0}));
            let pending = get(tx, Table::Counters, "topup-pending").await?;
            if pending
                .as_ref()
                .and_then(|v| opt(v, "operationId"))
                .is_none()
                && opt(&previous, "pending").is_none()
                && n(&previous, "count")? < n(t, "maximumPurchases")?
            {
                let id = self.id();
                put(
                    tx,
                    Table::Counters,
                    "topup-pending",
                    json!({"operationId":id}),
                    "active",
                )
                .await?;
                put(
                    tx,
                    Table::Counters,
                    &counter,
                    json!({"count":n(&previous,"count")?+1,"pending":id}),
                    "active",
                )
                .await?;
                self.enqueue(
                    tx,
                    &id,
                    "auto_topup",
                    json!({"planId":t["packPlan"],"counter":counter,"customerId":customer}),
                )
                .await?;
            }
        }
        Ok(())
    }
    pub(crate) async fn quote_overage(
        &self,
        tx: &mut dyn Transaction,
        p: &Value,
        mapped: &(Value, Value),
    ) -> Result<Value> {
        let (item, sub) = mapped;
        let quantity = nonnegative(s(p, "amount")?)?;
        let dimensions = if let Some(dimensions) = item["rate"]["dimensions"].as_array() {
            let matches: Vec<_> = dimensions
                .iter()
                .filter(|dim| {
                    dim["match"]
                        .as_object()
                        .is_some_and(|m| m.iter().all(|(k, v)| p["properties"].get(k) == Some(v)))
                })
                .collect();
            require(
                matches.len() == 1,
                if matches.is_empty() {
                    "missing_rate"
                } else {
                    "ambiguous_rate"
                },
            )?;
            matches[0]["match"].clone()
        } else {
            json!({})
        };
        let mut identity = json!({"feature":p["feature"],"sub":sub["id"],"start":sub["periodStart"],"dimension":dimensions,"version":sub["plan"]["version"]});
        copy_optional(&mut identity, p, "entityId");
        let counter = hash_v1(&identity)?;
        let previous = get(tx, Table::Counters, &counter)
            .await?
            .unwrap_or(json!({"quantity":"0","cost":"0"}));
        let mut identity =
            json!({"feature":p["feature"],"sub":sub["id"],"start":sub["periodStart"]});
        copy_optional(&mut identity, p, "entityId");
        let budget = hash_v1(&identity)?;
        let meter = hash_v1(&json!({"budgetKey":budget,"version":sub["plan"]["version"]}))?;
        let version = get(tx, Table::Counters, &format!("meter-version:{meter}"))
            .await?
            .unwrap_or(json!({"total":"0","generation":0}));
        let aggregate = get(tx, Table::Counters, &format!("meter-total:{budget}"))
            .await?
            .unwrap_or(json!({"total":"0","quantity":"0","generation":0}));
        let available = amount(
            &self
                .0
                .ledger
                .balance(tx, s(p, "feature")?, opt(p, "entityId"))
                .await?,
            "available",
        )?;
        let covered = quantity.min(available);
        let next = amount(&previous, "quantity")? + quantity - covered;
        let total = rate(
            &item["rate"],
            &d(next)?,
            p.get("properties").unwrap_or(&json!({})),
        )?;
        let charge = total - amount(&previous, "cost")?;
        let aggregate_total = amount(&aggregate, "total")? + charge;
        let version_total = amount(&version, "total")? + charge;
        let customer = self.customer(tx, s(p, "customerId")?).await?;
        if let Some(limit) = customer["controls"]["overageLimits"]
            .get(s(p, "feature")?)
            .and_then(Value::as_str)
        {
            require(aggregate_total <= u(limit)?, "spend_limit_exceeded")?;
        }
        if charge != 0 {
            require(
                opt(sub, "stripeSubscriptionId").is_some()
                    && sub["plan"]["stripeMeterPriceIds"]
                        .get(s(p, "feature")?)
                        .and_then(Value::as_str)
                        .is_some(),
                "payment_setup_required",
            )?;
        }
        Ok(
            json!({"sub":sub,"counterId":counter,"next":d(next)?,"total":d(total)?,"budgetKey":budget,"meterKey":meter,"versionAggregate":version,"aggregate":aggregate,"aggregateTotal":d(aggregate_total)?,"versionTotal":d(version_total)?,"charge":d(charge)?,"covered":d(covered)?}),
        )
    }
    pub(crate) async fn consume(
        &self,
        tx: &mut dyn Transaction,
        p: &Value,
        key: &str,
    ) -> Result<Value> {
        self.0.ledger.materialize(tx).await?;
        let quantity = positive(s(p, "amount")?)?;
        let feature = s(p, "feature")?;
        let entity = opt(p, "entityId");
        require(
            self.quantity_capacity(tx, feature, entity).await?.is_none(),
            "quantity_requires_assignment",
        )?;
        let mapped = self.item(tx, feature, entity).await?;
        let item = mapped
            .as_ref()
            .map(|(i, _)| i)
            .cloned()
            .unwrap_or(json!({}));
        let target = opt(&item, "pool").unwrap_or(feature);
        let payer = allocation_entity(&item, entity);
        let properties = p.get("properties").cloned().unwrap_or(json!({}));
        let cost = if item.get("pool").is_some() && item.get("rate").is_some() {
            rate(&item["rate"], s(p, "amount")?, &properties)?
        } else {
            quantity
        };
        let funding = if item["overage"] == true {
            mapped.clone()
        } else if item.get("pool").is_some() {
            self.item(tx, target, payer.as_deref()).await?
        } else {
            None
        };
        let mut charge = d(cost)?;
        let mut currency = None;
        let allocations;
        if let Some(funding) = funding.filter(|(i, _)| i["overage"] == true) {
            let mut rated = p.clone();
            rated["feature"] = json!(target);
            rated["amount"] = json!(d(cost)?);
            rated.as_object_mut().unwrap().remove("entityId");
            if let Some(payer) = &payer {
                rated["entityId"] = json!(payer);
            }
            let q = self.quote_overage(tx, &rated, &funding).await?;
            charge = s(&q, "charge")?.into();
            let code = opt(&q["sub"]["plan"], "currency")
                .unwrap_or("usd")
                .to_owned();
            currency = Some(code.clone());
            allocations = if amount(&q, "covered")? > 0 {
                self.0
                    .ledger
                    .allocate(
                        tx,
                        target,
                        amount(&q, "covered")?,
                        payer.as_deref(),
                        false,
                        key,
                    )
                    .await?
            } else {
                Vec::new()
            };
            put(
                tx,
                Table::Counters,
                s(&q, "counterId")?,
                json!({"quantity":q["next"],"cost":q["total"]}),
                "active",
            )
            .await?;
            put(tx,Table::Counters,&format!("meter-total:{}",s(&q,"budgetKey")?),json!({"total":q["aggregateTotal"],"quantity":d(amount(&q["aggregate"],"quantity")?+cost)?,"generation":n(&q["aggregate"],"generation")?+1}),"active").await?;
            put(tx,Table::Counters,&format!("meter-version:{}",s(&q,"meterKey")?),json!({"total":q["versionTotal"],"generation":n(&q["versionAggregate"],"generation")?+1}),"active").await?;
            if u(&charge)? != 0 {
                self.enqueue(tx,&format!("usage:{key}"),"meter",json!({"customerId":p["customerId"],"subscriptionId":q["sub"]["stripeSubscriptionId"],"feature":target,"delta":charge,"total":q["versionTotal"],"meterKey":q["meterKey"],"generation":n(&q["versionAggregate"],"generation")?+1,"currency":code,"periodStart":q["sub"]["periodStart"],"periodEnd":q["sub"]["periodEnd"],"priceId":q["sub"]["plan"]["stripeMeterPriceIds"][target]})).await?;
            }
        } else {
            allocations = self
                .0
                .ledger
                .allocate(tx, target, cost, payer.as_deref(), false, key)
                .await?;
        }
        let id = self.id();
        let mut usage = json!({"id":id,"feature":feature,"quantity":p["amount"],"charged":charge,"allocations":allocations,"createdAt":self.now(),"properties":properties});
        copy_optional(&mut usage, p, "entityId");
        if let Some((_, sub)) = mapped {
            usage["planVersion"] = sub["plan"]["version"].clone();
        }
        if let Some(currency) = currency {
            usage["currency"] = json!(currency);
        }
        put(tx, Table::Usage, &id, usage.clone(), "active").await?;
        self.after_usage(tx, s(p, "customerId")?, target, payer.as_deref())
            .await?;
        Ok(usage)
    }
}
