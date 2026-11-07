//! Catalog validation and normalization preserve the 0.1 version identities.
use crate::wire::*;
use brokeboy_core::{Result, error::identifier, pricing::Rate};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn normalize_plan(plan: &Value, features: &[Value]) -> Result<Value> {
    let mut result = plan.clone();
    let mut items = Vec::new();
    for item in arr(plan, "items")? {
        let mut item = item.clone();
        if let Some(kind) = features
            .iter()
            .find(|f| f["id"] == item["feature"])
            .and_then(|f| opt(f, "kind"))
        {
            item["kind"] = json!(kind);
            if kind == "quantity" {
                item["reset"] = json!("never");
            }
        }
        items.push(item);
    }
    result["items"] = json!(items);
    Ok(result)
}
pub fn validate_catalog(catalog: &Value) -> Result<()> {
    require(
        catalog["features"].is_array() && catalog["plans"].is_array(),
        "invalid_catalog",
    )?;
    let mut features = BTreeMap::new();
    for feature in arr(catalog, "features")? {
        let id = identifier(s(feature, "id")?)?;
        require(features.insert(id, feature).is_none(), "duplicate_feature")?;
    }
    let mut plans = BTreeSet::new();
    for plan in arr(catalog, "plans")? {
        require(plans.insert(identifier(s(plan, "id")?)?), "duplicate_plan")?;
    }
    for feature in features.values() {
        require(
            matches!(
                opt(feature, "kind"),
                Some("boolean" | "consumable" | "quantity")
            ),
            "invalid_feature",
        )?;
    }
    for plan in arr(catalog, "plans")? {
        require(
            opt(plan, "name").is_some_and(|v| !v.is_empty()),
            "invalid_plan",
        )?;
        if let Some(amount) = plan.get("amount") {
            nonnegative(
                amount
                    .as_str()
                    .ok_or_else(|| brokeboy_core::BillingError::new("invalid_decimal"))?,
            )?;
        }
        if plan.get("graceDays").is_some() {
            require(
                plan["graceDays"]
                    .as_i64()
                    .is_some_and(|v| (1..=30).contains(&v)),
                "invalid_grace_period",
            )?;
        }
        for key in ["trialIncluded", "graceIncluded"] {
            if let Some(values) = plan.get(key).and_then(Value::as_object) {
                for (feature, value) in values {
                    require(features.contains_key(feature.as_str()), "unknown_feature")?;
                    nonnegative(
                        value
                            .as_str()
                            .ok_or_else(|| brokeboy_core::BillingError::new("invalid_decimal"))?,
                    )?;
                }
            }
        }
        if let Some(currency) = opt(plan, "currency") {
            require(
                currency.len() == 3 && currency.bytes().all(|b| b.is_ascii_lowercase()),
                "invalid_currency",
            )?;
        }
        if plan.get("trialDays").is_some() {
            require(
                plan["trialDays"]
                    .as_i64()
                    .is_some_and(|v| v > 0 && v <= 9_007_199_254_740_991),
                "invalid_trial",
            )?;
        }
        let mut seen = BTreeSet::new();
        for item in arr(plan, "items")? {
            require(seen.insert(s(item, "feature")?), "duplicate_plan_feature")?;
        }
        for item in arr(plan, "items")? {
            let feature = s(item, "feature")?;
            require(features.contains_key(feature), "unknown_feature")?;
            let kind = opt(features[feature], "kind");
            if opt(item, "pool").is_some() {
                require(
                    item.get("included").is_none(),
                    "pool_allowance_belongs_to_pool",
                )?;
            }
            if kind == Some("boolean") {
                require(
                    ["included", "rate", "pool"]
                        .iter()
                        .all(|k| item.get(k).is_none()),
                    "boolean_cannot_be_metered",
                )?;
            } else {
                require(item.get("enabled").is_none(), "enabled_requires_boolean")?;
            }
            if let Some(pool) = opt(item, "pool") {
                require(
                    features
                        .get(pool)
                        .is_some_and(|v| opt(v, "kind") == Some("consumable")),
                    "invalid_pool",
                )?;
            }
            if let Some(included) = item.get("included") {
                nonnegative(
                    included
                        .as_str()
                        .ok_or_else(|| brokeboy_core::BillingError::new("invalid_decimal"))?,
                )?;
            }
            if kind == Some("quantity") {
                require(
                    matches!(opt(item, "reset"), None | Some("never")),
                    "quantity_cannot_reset",
                )?;
            }
            if let Some(rollover) = item.get("rollover") {
                nonnegative(s(rollover, "maximum")?)?;
                require(
                    rollover["periods"]
                        .as_i64()
                        .is_some_and(|v| (1..=120).contains(&v)),
                    "invalid_rollover",
                )?;
            }
            if item["overage"] == true {
                require(
                    item.get("rate").is_some() && item.get("pool").is_none(),
                    "invalid_overage",
                )?;
            }
            if let Some(rate) = item.get("rate") {
                require(
                    ["amount", "tiers", "dimensions"]
                        .iter()
                        .filter(|key| rate.get(**key).is_some())
                        .count()
                        == 1,
                    "invalid_rate",
                )?;
                let rate: Rate = serde_json::from_value(rate.clone())
                    .map_err(|_| brokeboy_core::BillingError::new("invalid_rate"))?;
                rate.validate()?;
            }
        }
    }
    serde_json::from_value::<brokeboy_core::models::Catalog>(catalog.clone())
        .map_err(|_| brokeboy_core::BillingError::new("invalid_catalog"))?;
    Ok(())
}
