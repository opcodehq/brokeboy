//! Transactional idempotency shared by the domain operation groups.
use crate::{
    lifecycle::RequestGuard,
    storage::{BillingFuture, Clock, Storage, Transaction},
};
use brokeboy_core::{
    BillingError, Result,
    compatibility::operation_hash,
    error::identifier,
    records::{Row, Table},
};
use serde_json::{Value, json};
use std::sync::Arc;

pub use brokeboy_core::models::Environment;

pub struct WriteScope<'a> {
    pub customer_id: &'a str,
    pub entity_id: Option<&'a str>,
    pub idempotency_key: &'a str,
}

pub struct Operations {
    storage: Arc<dyn Storage>,
    clock: Arc<dyn Clock>,
    environment: Environment,
}
impl Operations {
    pub fn new(storage: Arc<dyn Storage>, clock: Arc<dyn Clock>, environment: Environment) -> Self {
        Self {
            storage,
            clock,
            environment,
        }
    }

    /// Execute a validated domain action under the existing customer lock.
    /// `raw_payload` is the validated wire input, before defaults or decimal
    /// normalization. The action must perform database work only; application
    /// callbacks and payment calls run after this method completes.
    pub async fn write<F>(
        &self,
        scope: WriteScope<'_>,
        method: &str,
        raw_payload: &Value,
        create_customer: bool,
        request: Option<&RequestGuard>,
        action: F,
    ) -> Result<Value>
    where
        F: for<'tx> FnOnce(&'tx mut dyn Transaction, &'tx str) -> BillingFuture<'tx, Value> + Send,
    {
        let digest = operation_hash(method, raw_payload)?;
        identifier(scope.idempotency_key)?;
        identifier(scope.customer_id)?;
        if let Some(request) = request {
            request.check()?;
        }
        let db_scope = format!("{}:c:{}", self.environment.name(), scope.customer_id);
        let mut tx = self.storage.begin(&db_scope).await?;
        let result: Result<Value> = async {
            if let Some(request) = request {
                request.check()?;
            }
            if let Some(previous) = tx.get(Table::Operations, scope.idempotency_key).await? {
                let hash = previous
                    .data
                    .get("hash")
                    .and_then(Value::as_str)
                    .ok_or_else(|| BillingError::new("corrupt_operation"))?;
                if hash != digest {
                    return Err(BillingError::new("idempotency_conflict"));
                }
                return previous
                    .data
                    .get("result")
                    .cloned()
                    .ok_or_else(|| BillingError::new("corrupt_operation"));
            }
            if !create_customer && tx.get(Table::Customers, scope.customer_id).await?.is_none() {
                return Err(BillingError::new("customer_not_found"));
            }
            if let Some(entity_id) = scope.entity_id.filter(|v| !v.is_empty()) {
                identifier(entity_id)?;
                if tx.get(Table::Entities, entity_id).await?.is_none() {
                    return Err(BillingError::new("entity_not_found"));
                }
            }
            let result = action(tx.as_mut(), scope.idempotency_key).await?;
            if let Some(request) = request {
                request.check()?;
            }
            tx.put(
                Table::Operations,
                Row {
                    id: scope.idempotency_key.into(),
                    state: "active".into(),
                    data: json!({"hash":digest, "result":result, "createdAt":self.clock.now()}),
                    extra: Default::default(),
                },
            )
            .await?;
            Ok(result)
        }
        .await;
        match result {
            Ok(value) => {
                if let Some(error) = request.and_then(|r| r.check().err()) {
                    tx.rollback().await?;
                    return Err(error);
                }
                tx.commit().await?;
                Ok(value)
            }
            Err(error) => {
                tx.rollback().await?;
                Err(error)
            }
        }
    }
}
