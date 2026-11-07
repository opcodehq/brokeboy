use super::usage::rate;
use super::*;
use crate::{ledger::allocation_entity, storage::PageQuery};
use brokeboy_core::{compatibility::canonical_json_v1, error::timestamp};
use std::collections::BTreeSet;
impl Billing {
    pub(crate) async fn read_action(
        &self,
        tx: &mut dyn Transaction,
        method: &str,
        p: &Value,
    ) -> Result<Value> {
        let customer = s(p, "customerId")?;
        let entity = opt(p, "entityId");
        match method {
            "customers.get" => self.customer(tx, customer).await,
            "billingControls.get" => Ok(self.customer(tx, customer).await?["controls"].clone()),
            "entities.list" => Ok(json!(list(tx, Table::Entities, None).await?)),
            "subscriptions.list" => Ok(json!(list(tx, Table::Subscriptions, None).await?)),
            "credits.list" => Ok(json!(
                list(tx, Table::Grants, None)
                    .await?
                    .into_iter()
                    .filter(|g| opt(g, "entityId") == entity)
                    .collect::<Vec<_>>()
            )),
            "credits.reconcile" => self.0.ledger.reconcile(tx).await,
            "reservations.list" => Ok(json!(list(tx, Table::Reservations, None).await?)),
            "licenses.list" => Ok(json!(list(tx, Table::Licenses, Some("active")).await?)),
            "credits.balance" | "entitlements.check" => {
                self.customer(tx, customer).await?;
                self.0.ledger.materialize(tx).await?;
                let feature = s(p, "feature")?;
                let mapped = self.item(tx, feature, entity).await?;
                let item = mapped
                    .as_ref()
                    .map(|(i, _)| i)
                    .cloned()
                    .unwrap_or(json!({}));
                let target = opt(&item, "pool").unwrap_or(feature);
                let payer = allocation_entity(&item, entity);
                let balance = self.balance_for(tx, target, payer.as_deref()).await?;
                if method == "credits.balance" {
                    return Ok(balance);
                }
                let required = if item.get("pool").is_some() && item.get("rate").is_some() {
                    rate(&item["rate"], opt(p, "amount").unwrap_or("1"), &json!({}))?
                } else {
                    nonnegative(opt(p, "amount").unwrap_or("1"))?
                };
                let funding = if item["overage"] == true {
                    mapped
                } else if item.get("pool").is_some() {
                    self.item(tx, target, payer.as_deref()).await?
                } else {
                    None
                };
                if let Some(funding) = funding.filter(|(i, _)| i["overage"] == true) {
                    let mut rated = p.clone();
                    rated["feature"] = json!(target);
                    rated["amount"] = json!(d(required)?);
                    rated.as_object_mut().unwrap().remove("entityId");
                    if let Some(payer) = &payer {
                        rated["entityId"] = json!(payer);
                    }
                    return match self.quote_overage(tx, &rated, &funding).await {
                        Ok(_) => Ok(json!({"allowed":true,"balance":balance})),
                        Err(e)
                            if matches!(
                                e.code.as_str(),
                                "spend_limit_exceeded" | "payment_setup_required"
                            ) =>
                        {
                            Ok(json!({"allowed":false,"balance":balance,"reason":e.code}))
                        }
                        Err(e) => Err(e),
                    };
                }
                Ok(
                    json!({"allowed":item["enabled"]==true||amount(&balance,"available")?>=required,"balance":balance}),
                )
            }
            "entitlements.list" => {
                let mut result = Vec::new();
                for sub in self.subscriptions_in(tx, entity).await? {
                    for item in arr(&sub["plan"], "items")? {
                        let mut i = item.clone();
                        i["planVersion"] = sub["plan"]["version"].clone();
                        result.push(i);
                    }
                }
                Ok(json!(result))
            }
            "operations.get" => get(tx, Table::Work, s(p, "operationId")?)
                .await?
                .ok_or_else(|| BillingError::new("operation_not_found")),
            "usage.page" | "usage.list" | "operations.page" | "operations.list" | "events.page"
            | "events.list" | "usage.aggregate" => {
                let table = if method.starts_with("usage.") {
                    Table::Usage
                } else if method.starts_with("operations.") {
                    Table::Work
                } else {
                    Table::Events
                };
                let limit = p["limit"].as_u64().unwrap_or(100);
                require(limit > 0 && limit <= 1000, "invalid_limit")?;
                let rows = tx
                    .page(
                        table,
                        PageQuery {
                            after: opt(p, "cursor").map(str::to_owned),
                            limit: limit as u32 + 1,
                            ..Default::default()
                        },
                    )
                    .await?;
                let mut result = json!({"items":rows.iter().take(limit as usize).map(|r|r.data.clone()).collect::<Vec<_>>()});
                if rows.len() > limit as usize {
                    result["nextCursor"] = json!(rows[limit as usize - 1].id);
                }
                if table == Table::Usage && method != "usage.aggregate" {
                    result["items"] = json!(
                        result["items"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(|u| opt(u, "entityId") == entity)
                            .cloned()
                            .collect::<Vec<_>>()
                    );
                }
                if method == "usage.aggregate" {
                    return self.aggregate_page(p, result);
                }
                if method.ends_with(".list") {
                    Ok(result["items"].clone())
                } else {
                    Ok(result)
                }
            }
            _ => Err(BillingError::new("unknown_method")),
        }
    }
    fn aggregate_page(&self, p: &Value, page: Value) -> Result<Value> {
        let from = timestamp(n(p, "from")?)?;
        let to = timestamp(n(p, "to")?)?;
        require(from < to, "invalid_usage_window")?;
        let group = p["groupBy"].as_array().cloned().unwrap_or_default();
        let mut seen = BTreeSet::new();
        require(group.len() <= 8, "invalid_usage_grouping")?;
        for key in &group {
            let k = key
                .as_str()
                .ok_or_else(|| BillingError::new("invalid_identifier"))?;
            identifier(k)?;
            require(seen.insert(k), "invalid_usage_grouping")?;
        }
        let mut totals: Vec<(String, Value)> = Vec::new();
        for receipt in arr(&page, "items")? {
            let at = n(receipt, "createdAt")?;
            if receipt.get("entityId") != p.get("entityId") || at < from || at >= to {
                continue;
            }
            let mut properties = json!({});
            for key in &group {
                let k = key.as_str().unwrap();
                properties[k] = receipt["properties"].get(k).cloned().unwrap_or(Value::Null);
            }
            let mut identity = json!({"feature":receipt["feature"],"properties":properties});
            copy_optional(&mut identity, receipt, "currency");
            copy_optional(&mut identity, receipt, "planVersion");
            let key = canonical_json_v1(&identity)?;
            if let Some((_, total)) = totals.iter_mut().find(|(k, _)| *k == key) {
                total["quantity"] =
                    json!(d(amount(total, "quantity")? + amount(receipt, "quantity")?)?);
                total["charged"] =
                    json!(d(amount(total, "charged")? + amount(receipt, "charged")?)?);
                total["records"] = json!(n(total, "records")? + 1);
            } else {
                identity["quantity"] = json!(d(amount(receipt, "quantity")?)?);
                identity["charged"] = json!(d(amount(receipt, "charged")?)?);
                identity["records"] = json!(1);
                totals.push((key, identity));
            }
        }
        let mut result = json!({"totals":totals.into_iter().map(|(_,v)|v).collect::<Vec<_>>(),"scanned":arr(&page,"items")?.len(),"complete":page.get("nextCursor").is_none(),"window":{"from":from,"to":to}});
        copy_optional(&mut result, &page, "nextCursor");
        Ok(result)
    }
}
