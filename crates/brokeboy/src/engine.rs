//! Shared native billing engine. Database mutations use customer-scoped operations.
use crate::{
    ledger::Ledger,
    lifecycle::{Lifecycle, RequestGuard},
    operations::{Environment, Operations, WriteScope},
    storage::{BillingFuture, Clock, EventDelivery, Identifiers, Storage, Transaction},
    wire::*,
};
use brokeboy_core::{BillingError, Result, error::identifier, records::Table};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
mod actions;
mod adjustments;
mod background;
mod catalog;
mod migration;
mod periods;
mod provider_events;
mod reads;
mod subscriptions;
mod topups;
mod usage;
mod workflows;

pub struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or(0)
    }
}
pub struct UuidIdentifiers;
impl Identifiers for UuidIdentifiers {
    fn next(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}
pub struct BillingOptions {
    /// Only close a provider created specifically for this engine.
    pub owns_provider: bool,
    pub provider: Option<Arc<dyn crate::provider::PaymentProvider>>,
    pub environment: Environment,
    pub clock: Arc<dyn Clock>,
    pub identifiers: Arc<dyn Identifiers>,
    pub events: Option<Arc<dyn EventDelivery>>,
}
impl Default for BillingOptions {
    fn default() -> Self {
        Self {
            owns_provider: false,
            provider: None,
            environment: Environment::Test,
            clock: Arc::new(SystemClock),
            identifiers: Arc::new(UuidIdentifiers),
            events: None,
        }
    }
}
pub(crate) struct Inner {
    pub resources: Arc<crate::resources::Resources>,
    pub storage: Arc<dyn Storage>,
    pub options: BillingOptions,
    pub ledger: Ledger,
    pub operations: Operations,
    pub lifecycle: Lifecycle,
}
#[derive(Clone)]
pub struct Billing(pub(crate) Arc<Inner>);

impl Billing {
    pub fn from_storage(storage: Arc<dyn Storage>, options: BillingOptions) -> Self {
        let resources = Arc::new(crate::resources::Resources {
            storage: storage.clone(),
            environment: options.environment.name().into(),
            clock: options.clock.clone(),
            identifiers: options.identifiers.clone(),
        });
        let ledger = Ledger {
            clock: options.clock.clone(),
            identifiers: options.identifiers.clone(),
        };
        let operations =
            Operations::new(storage.clone(), options.clock.clone(), options.environment);
        Self(Arc::new(Inner {
            resources,
            storage,
            options,
            ledger,
            operations,
            lifecycle: Lifecycle::default(),
        }))
    }
    pub fn register_request(&self, id: &str) -> Result<()> {
        self.0.lifecycle.register(id)
    }
    /// Drop a registered transport request that failed decoding before execution.
    pub fn discard_pending_request(&self, id: &str) -> bool {
        self.0.lifecycle.discard_pending(id)
    }
    pub fn cancel_request(&self, id: &str) -> bool {
        self.0.lifecycle.cancel(id)
    }
    pub async fn close(&self) -> Result<()> {
        self.0.lifecycle.shutdown().await;
        let mut error = None;
        if let Some(events) = &self.0.options.events {
            error = events.close().await.err();
        }
        if self.0.options.owns_provider
            && let Some(provider) = &self.0.options.provider
        {
            let outcome = provider.close().await;
            if error.is_none() {
                error = outcome.err();
            }
        }
        let database = self.0.storage.close().await;
        if let Some(error) = error {
            Err(error)
        } else {
            database
        }
    }
    pub(crate) fn now(&self) -> i64 {
        self.0.options.clock.now()
    }
    pub(crate) fn id(&self) -> String {
        self.0.options.identifiers.next()
    }
    pub(crate) fn scope(&self, id: &str) -> Result<String> {
        Ok(format!(
            "{}:c:{}",
            self.0.options.environment.name(),
            identifier(id)?
        ))
    }
    pub(crate) fn catalog_scope(&self) -> String {
        format!("{}:catalog", self.0.options.environment.name())
    }
    pub async fn call(&self, method: &str, input: Value) -> Result<Value> {
        // Transport request IDs do not consume injected financial identifiers.
        let id = uuid::Uuid::new_v4().to_string();
        self.register_request(&id)?;
        self.call_registered(method, input, &id).await
    }
    pub async fn call_registered(&self, method: &str, input: Value, id: &str) -> Result<Value> {
        let request = self.0.lifecycle.start(id)?;
        request.check()?;
        tokio::select! {
            biased;
            _=request.cancelled()=>Err(BillingError::new("interrupted")),
            result=self.dispatch(method,input,&request)=>result,
        }
    }
    pub(crate) async fn atomic<F>(&self, scope: &str, action: F) -> Result<Value>
    where
        F: for<'a> FnOnce(&'a mut dyn Transaction) -> BillingFuture<'a, Value> + Send,
    {
        let mut tx = self.0.storage.begin(scope).await?;
        match action(tx.as_mut()).await {
            Ok(v) => {
                tx.commit().await?;
                Ok(v)
            }
            Err(e) => {
                tx.rollback().await?;
                Err(e)
            }
        }
    }
    async fn dispatch(&self, method: &str, input: Value, request: &RequestGuard) -> Result<Value> {
        if method == "operations.unmatched" {
            return self
                .atomic(&self.catalog_scope(), move |tx| {
                    Box::pin(async move {
                        Ok(json!(tx.list(Table::Inbox, Some("reconciliation")).await?))
                    })
                })
                .await;
        }
        if method == "operations.replayUnmatched" {
            return self.replay_unmatched(input).await;
        }
        if method == "diagnostics.doctor" {
            let mut tx = self.0.storage.begin(&self.catalog_scope()).await?;
            let result = async {
                for table in Table::ALL {
                    tx.page(table, crate::storage::PageQuery { limit: 1, due_before: (table == Table::Work).then_some(0), ..Default::default() }).await?;
                }
                Ok::<_, BillingError>(json!({"ok":true,"tables":Table::ALL.len(),"migrationsAppliedAutomatically":false,"providerResourcesCreated":false}))
            }.await;
            tx.rollback().await?;
            return result;
        }
        if method == "migration.import" {
            return self.migration_import(input, request).await;
        }
        if method == "migration.adoptStripeCustomer" {
            return self.adopt_stripe_customer(input, request).await;
        }
        if method == "migration.inspectStripeSubscription" {
            let plan = self.plan(s(&input, "planId")?, None).await?;
            let provider = self
                .0
                .options
                .provider
                .as_ref()
                .ok_or_else(|| BillingError::new("provider_missing"))?;
            let mut parameters = input.clone();
            parameters["plan"] = plan;
            parameters["provider"] = json!("stripe");
            return provider
                .execute(crate::provider::PaymentCommand {
                    id: brokeboy_core::compatibility::hash_v1(&input)?,
                    kind: "subscription_inspect".into(),
                    customer: json!({"id":s(&input,"customerId")?}),
                    input: parameters,
                    resources: self.0.resources.clone(),
                })
                .await;
        }
        if matches!(method, "periods.get" | "periods.check") {
            let scope = self.scope(s(&input, "customerId")?)?;
            let this = self.clone();
            let method = method.to_owned();
            return self
                .atomic(&scope, move |tx| {
                    Box::pin(async move { this.period_read(tx, &method, &input).await })
                })
                .await;
        }
        if method == "migration.export" {
            let scope = self.scope(s(&input, "customerId")?)?;
            let this = self.clone();
            let id = s(&input, "customerId")?.to_owned();
            return self
                .atomic(&scope, move |tx| {
                    Box::pin(async move { this.migration_export(tx, &id).await })
                })
                .await;
        }
        if method == "operations.retry" {
            let saved = self.write(method, &input, input.clone(), request).await?;
            let scope = self.scope(s(&input, "customerId")?)?;
            self.run_work(&scope, s(&saved, "id")?).await?;
            let id = s(&saved, "id")?.to_owned();
            return self
                .atomic(&scope, move |tx| {
                    Box::pin(async move {
                        get(tx, Table::Work, &id)
                            .await?
                            .ok_or_else(|| BillingError::new("operation_not_found"))
                    })
                })
                .await;
        }
        if method == "operations.reconcile" {
            return self
                .write("operations.resolve", &input, input.clone(), request)
                .await;
        }
        if method == "maintenance.run" {
            return self.maintenance_run(input).await;
        }
        if method == "resources.inspect" {
            return self.0.resources.inspect(s(&input, "key")?).await;
        }
        if method == "resources.reconcile" {
            let provider = self
                .0
                .options
                .provider
                .as_ref()
                .ok_or_else(|| BillingError::new("provider_missing"))?;
            provider
                .verify_resource(s(&input, "key")?.into(), s(&input, "id")?.into())
                .await?;
            return self
                .0
                .resources
                .resolve(
                    s(&input, "key")?.into(),
                    s(&input, "id")?.into(),
                    s(&input, "reason")?.into(),
                )
                .await;
        }
        if matches!(
            method,
            "subscriptions.checkout"
                | "subscriptions.preview"
                | "subscriptions.update"
                | "subscriptions.cancel"
                | "subscriptions.pause"
                | "subscriptions.resume"
                | "subscriptions.schedule"
                | "subscriptions.portal"
                | "commerce.invoices"
                | "commerce.invoice"
                | "commerce.refund"
                | "commerce.creditNote"
                | "catalog.migrate"
                | "migration.linkSubscription"
                | "prepaid.checkout"
                | "migration.importStripeBalance"
        ) {
            return self.subscription_call(method, input, request).await;
        }
        if matches!(method, "workflows.get" | "workflows.page") {
            let scope = self.scope(s(&input, "customerId")?)?;
            let this = self.clone();
            let method = method.to_owned();
            return self
                .atomic(&scope, move |tx| {
                    Box::pin(async move { this.workflow_read(tx, &method, &input).await })
                })
                .await;
        }
        if method.starts_with("catalog.") && method != "catalog.migrate" {
            return self.catalog_call(method, input).await;
        }
        if method == "subscriptions.attach" {
            let plan = self
                .plan(s(&input, "planId")?, opt(&input, "version"))
                .await?;
            require(opt(&plan, "kind") == Some("free"), "payment_required")?;
            let mut parameters = input.clone();
            parameters["plan"] = plan;
            return self.write(method, &input, parameters, request).await;
        }
        if method == "billingControls.update" {
            if let Some(t) = input["controls"].get("autoTopUp") {
                let pack = self.plan(s(t, "packPlan")?, None).await?;
                let mut found = false;
                for i in arr(&pack, "items")? {
                    if opt(i, "pool").or_else(|| opt(i, "feature")) == opt(t, "feature")
                        && optional_amount(i, "included")? > 0
                    {
                        found = true;
                    }
                }
                require(
                    opt(&pack, "kind") == Some("one_time") && found,
                    "invalid_topup_pack",
                )?;
            }
            return self
                .write("controls.update", &input, input.clone(), request)
                .await;
        }
        if matches!(
            method,
            "customers.get"
                | "entities.list"
                | "credits.balance"
                | "credits.list"
                | "credits.reconcile"
                | "entitlements.check"
                | "entitlements.list"
                | "usage.page"
                | "usage.list"
                | "usage.aggregate"
                | "reservations.list"
                | "subscriptions.list"
                | "licenses.list"
                | "billingControls.get"
                | "operations.get"
                | "operations.page"
                | "operations.list"
                | "events.list"
                | "events.page"
        ) {
            let scope = self.scope(s(&input, "customerId")?)?;
            let this = self.clone();
            let method = method.to_owned();
            return self
                .atomic(&scope, move |tx| {
                    Box::pin(async move { this.read_action(tx, &method, &input).await })
                })
                .await;
        }
        self.write(method, &input, input.clone(), request).await
    }
    pub(crate) async fn write(
        &self,
        method: &str,
        raw: &Value,
        parameters: Value,
        request: &RequestGuard,
    ) -> Result<Value> {
        let customer = if method == "customers.create" {
            s(raw, "id")?
        } else {
            s(raw, "customerId")?
        };
        let scope = WriteScope {
            customer_id: customer,
            entity_id: if method == "entities.create" {
                None
            } else {
                opt(raw, "entityId")
            },
            idempotency_key: s(raw, "idempotencyKey")?,
        };
        let this = self.clone();
        let owned_method = method.to_owned();
        self.0
            .operations
            .write(
                scope,
                method,
                raw,
                method == "customers.create",
                Some(request),
                move |tx, key| {
                    Box::pin(
                        async move { this.write_action(tx, &owned_method, &parameters, key).await },
                    )
                },
            )
            .await
    }
    pub(crate) async fn customer(&self, tx: &mut dyn Transaction, id: &str) -> Result<Value> {
        get(tx, Table::Customers, id)
            .await?
            .ok_or_else(|| BillingError::new("customer_not_found"))
    }
    pub(crate) async fn enqueue(
        &self,
        tx: &mut dyn Transaction,
        id: &str,
        kind: &str,
        mut payload: Value,
    ) -> Result<()> {
        if get(tx, Table::Work, id).await?.is_some() {
            return Ok(());
        }
        require(payload.is_object(), "invalid_work_payload")?;
        if !matches!(kind, "event" | "webhook" | "workflow_timeout")
            && payload.get("provider").is_none()
            && let Some(provider) = &self.0.options.provider
        {
            payload["provider"] = json!(
                payload["plan"]["provider"]
                    .as_str()
                    .unwrap_or(provider.provider_id())
            );
        }
        put(tx,Table::Work,id,json!({"id":id,"kind":kind,"payload":payload,"status":"pending","attempts":0,"availableAt":self.now(),"createdAt":self.now()}),"pending").await
    }
    pub(crate) async fn event(
        &self,
        tx: &mut dyn Transaction,
        customer: &str,
        kind: &str,
        data: Value,
    ) -> Result<()> {
        let id = self.id();
        let event =
            json!({"id":id,"type":kind,"customerId":customer,"data":data,"createdAt":self.now()});
        put(tx, Table::Events, &id, event.clone(), "active").await?;
        put(tx, Table::Audit, &id, event.clone(), "active").await?;
        if self.0.options.events.is_some() {
            self.enqueue(tx, &format!("event:{id}"), "event", event)
                .await?;
        }
        Ok(())
    }
}
