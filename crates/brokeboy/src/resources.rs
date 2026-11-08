use crate::{
    provider::{ResourceFactory, ResourceRegistry},
    storage::{BillingFuture, Clock, Identifiers, Storage},
    wire::*,
};
use brokeboy_core::{BillingError, Result, compatibility::hash_v1, records::Table};
use serde_json::{Value, json};
use std::sync::Arc;

pub struct Resources {
    pub storage: Arc<dyn Storage>,
    pub environment: String,
    pub clock: Arc<dyn Clock>,
    pub identifiers: Arc<dyn Identifiers>,
}
impl Resources {
    pub async fn customer_link(
        &self,
        provider: &str,
        id: &str,
        customer: Option<&str>,
    ) -> Result<Option<String>> {
        let key = format!("provider-customer:{provider}:{id}");
        let id = id.to_owned();
        let desired = customer.map(str::to_owned);
        let result = crate::storage::atomic(self.storage.as_ref(), &self.scope(&key)?, move |tx| {
            Box::pin(async move {
                let old = get(tx, Table::Resources, "mapping").await?;
                if let Some(customer) = desired {
                    if let Some(old) = old {
                        require(
                            opt(&old, "customerId") == Some(customer.as_str())
                                && opt(&old, "id") == Some(id.as_str()),
                            "customer_mapping_conflict",
                        )?;
                        return Ok(json!(customer));
                    }
                    put(
                        tx,
                        Table::Resources,
                        "mapping",
                        json!({"key":key,"id":id,"customerId":customer}),
                        "ready",
                    )
                    .await?;
                    Ok(json!(customer))
                } else {
                    Ok(old
                        .and_then(|v| v.get("customerId").cloned())
                        .unwrap_or(Value::Null))
                }
            })
        })
        .await?;
        Ok(result.as_str().map(str::to_owned))
    }
    fn scope(&self, key: &str) -> Result<String> {
        Ok(format!(
            "{}:r:{}",
            self.environment,
            hash_v1(&json!({"environment":self.environment,"key":key}))?
        ))
    }
    pub async fn inspect(&self, key: &str) -> Result<Value> {
        crate::storage::atomic(self.storage.as_ref(), &self.scope(key)?, |tx| {
            Box::pin(async {
                Ok(get(tx, Table::Resources, "mapping")
                    .await?
                    .unwrap_or(Value::Null))
            })
        })
        .await
    }
    pub async fn resolve(&self, key: String, id: String, reason: String) -> Result<Value> {
        require(
            !reason.trim().is_empty() && reason.chars().count() <= 500,
            "reason_required",
        )?;
        let clock = self.clock.clone();
        crate::storage::atomic(self.storage.as_ref(), &self.scope(&key)?, move |tx| {
            Box::pin(async move {
                let mut old = get(tx, Table::Resources, "mapping")
                    .await?
                    .ok_or_else(|| BillingError::new("resource_not_found"))?;
                require(
                    opt(&old, "id").is_none_or(|v| v == id),
                    "resource_mapping_conflict",
                )?;
                // The caller verifies ownership with the provider before resolving.
                require(
                    opt(&old, "id").is_some() || n(&old, "leaseUntil")? <= clock.now(),
                    "resource_creation_in_progress",
                )?;
                old["key"] = json!(key);
                old["id"] = json!(id);
                old["resolution"] = json!(reason);
                old["leaseUntil"] = json!(0);
                put(tx, Table::Resources, "mapping", old.clone(), "ready").await?;
                Ok(old)
            })
        })
        .await
    }
}
impl ResourceRegistry for Resources {
    fn link_customer(
        &self,
        provider: String,
        id: String,
        customer: String,
    ) -> BillingFuture<'_, ()> {
        Box::pin(async move {
            self.customer_link(&provider, &id, Some(&customer)).await?;
            Ok(())
        })
    }
    fn get_or_create(&self, key: String, create: ResourceFactory) -> BillingFuture<'_, String> {
        Box::pin(async move {
            let digest = hash_v1(&json!({"environment":self.environment,"key":key}))?;
            let scope = self.scope(&key)?;
            let owner = self.identifiers.next();
            for attempt in 0..100 {
                let lease_key = key.clone();
                let lease_owner = owner.clone();
                let clock = self.clock.clone();
                let resource=crate::storage::atomic(self.storage.as_ref(),&scope,move|tx|Box::pin(async move{
                let now=clock.now();let old=get(tx,Table::Resources,"mapping").await?;if old.as_ref().and_then(|v|opt(v,"id")).is_some(){return Ok(old.unwrap());}
                if let Some(old)=&old{require(now-n(old,"startedAt")?<=23*60*60000,"reconciliation_required")?;if n(old,"leaseUntil")?>now{return Ok(Value::Null);}}
                let next=json!({"key":lease_key,"startedAt":old.as_ref().and_then(|v|v["startedAt"].as_i64()).unwrap_or(now),"owner":lease_owner,"leaseUntil":now+120000});put(tx,Table::Resources,"mapping",next.clone(),"creating").await?;Ok(next)
            })).await?;
                if let Some(id) = opt(&resource, "id") {
                    return Ok(id.into());
                }
                if resource.is_null() {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        ((attempt + 1) * 10).min(200),
                    ))
                    .await;
                    continue;
                }
                let outcome = create(format!("bb:resource:{digest}")).await;
                if outcome.as_ref().is_err_and(|e| e.code == "interrupted") {
                    return outcome;
                }
                let save_owner = owner.clone();
                let save_result = outcome.clone();
                crate::storage::atomic(self.storage.as_ref(), &scope, move |tx| {
                    Box::pin(async move {
                        let mut current = get(tx, Table::Resources, "mapping")
                            .await?
                            .ok_or_else(|| BillingError::new("lease_lost"))?;
                        if save_result.is_ok() {
                            require(
                                opt(&current, "owner") == Some(save_owner.as_str()),
                                "lease_lost",
                            )?;
                        } else if opt(&current, "owner") != Some(save_owner.as_str()) {
                            return Ok(Value::Null);
                        }
                        current["leaseUntil"] = json!(0);
                        let state = if let Ok(id) = save_result {
                            current["id"] = json!(id);
                            "ready"
                        } else {
                            "creating"
                        };
                        put(tx, Table::Resources, "mapping", current, state).await?;
                        Ok(Value::Null)
                    })
                })
                .await?;
                return outcome;
            }
            Err(BillingError::new("resource_creation_in_progress"))
        })
    }
}
