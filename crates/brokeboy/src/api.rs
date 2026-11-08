//! Grouped native Rust SDK. Serializable inputs are hashed before normalization.
use crate::Billing;
use brokeboy_core::{BillingError, Result, models::*};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
impl Billing {
    pub async fn invoke<I: Serialize, O: DeserializeOwned>(
        &self,
        method: &str,
        input: I,
    ) -> Result<O> {
        let input = serde_json::to_value(input).map_err(|_| BillingError::new("invalid_input"))?;
        let result = self.call(method, input).await?;
        serde_json::from_value(result).map_err(|_|BillingError::message("unsupported_record","The stored result cannot be decoded by this SDK. Inspect the raw operation before retrying."))
    }
}
macro_rules! group{
    ($name:ident,$accessor:ident,{$($method:ident=>$route:literal:$output:ty),*$(,)?})=>{
        pub struct $name<'a>(&'a Billing);
        impl Billing{pub fn $accessor(&self)->$name<'_>{$name(self)}}
        impl $name<'_>{$(pub async fn $method<I:Serialize>(&self,input:I)->Result<$output>{self.0.invoke($route,input).await})*}
    }
}
group!(CatalogApi,catalog,{validate=>"catalog.validate":(),diff=>"catalog.diff":Value,publish=>"catalog.publish":Value,export=>"catalog.export":Value,get=>"catalog.get":PublishedPlan,custom=>"catalog.custom":Value,migrate=>"catalog.migrate":Work});
group!(Customers,customers,{create=>"customers.create":Customer,get=>"customers.get":Customer,update=>"customers.update":Customer});
group!(Entities,entities,{create=>"entities.create":Entity,list=>"entities.list":Vec<Entity>,update=>"entities.update":Entity});
group!(Credits,credits,{grant=>"credits.grant":Grant,balance=>"credits.balance":Balance,list=>"credits.list":Vec<Grant>,adjust=>"credits.adjust":Balance,reconcile=>"credits.reconcile":Value});
group!(Entitlements,entitlements,{check=>"entitlements.check":Value,list=>"entitlements.list":Vec<Value>});
group!(UsageApi,usage,{consume=>"usage.consume":Usage,record=>"usage.record":Usage,batch=>"usage.batch":Value,page=>"usage.page":Value,list=>"usage.list":Vec<Usage>,aggregate=>"usage.aggregate":Value,correct=>"usage.correct":Value,set_quantity=>"usage.setQuantity":Value});
group!(Reservations,reservations,{create=>"reservations.create":Reservation,increase=>"reservations.increase":Reservation,settle=>"reservations.settle":Value,release=>"reservations.release":Reservation,list=>"reservations.list":Vec<Reservation>});
group!(Subscriptions,subscriptions,{attach=>"subscriptions.attach":Subscription,list=>"subscriptions.list":Vec<Subscription>,checkout=>"subscriptions.checkout":Work,preview=>"subscriptions.preview":Work,update=>"subscriptions.update":Work,cancel=>"subscriptions.cancel":Work,pause=>"subscriptions.pause":Work,resume=>"subscriptions.resume":Work,schedule=>"subscriptions.schedule":Work,portal=>"subscriptions.portal":Work});
group!(Licenses,licenses,{assign=>"licenses.assign":Value,release=>"licenses.release":Value,list=>"licenses.list":Vec<Value>});
group!(BillingControls,billing_controls,{get=>"billingControls.get":Controls,update=>"billingControls.update":Controls});
group!(Commerce,commerce,{invoices=>"commerce.invoices":Work,invoice=>"commerce.invoice":Work,refund=>"commerce.refund":Work,credit_note=>"commerce.creditNote":Work});
group!(OperationsApi,operations,{get=>"operations.get":Work,list=>"operations.list":Vec<Work>,page=>"operations.page":Value,retry=>"operations.retry":Work,resolve=>"operations.resolve":Value,reconcile=>"operations.reconcile":Value,unmatched=>"operations.unmatched":Vec<Value>,replay_unmatched=>"operations.replayUnmatched":Value});
group!(Events,events,{list=>"events.list":Vec<Value>,page=>"events.page":Value});
group!(ResourcesApi,resources,{inspect=>"resources.inspect":Option<Value>,reconcile=>"resources.reconcile":Value});
group!(Migration,migration,{export=>"migration.export":Value,import=>"migration.import":Value,link_subscription=>"migration.linkSubscription":Work,import_stripe_balance=>"migration.importStripeBalance":Work,adopt_stripe_customer=>"migration.adoptStripeCustomer":Value,inspect_stripe_subscription=>"migration.inspectStripeSubscription":Value});
group!(Workflows,workflows,{create=>"workflows.create":Workflow,get=>"workflows.get":Workflow,page=>"workflows.page":Value,claim=>"workflows.claim":Value,heartbeat=>"workflows.heartbeat":Workflow,increase=>"workflows.increase":Workflow,complete=>"workflows.complete":Workflow,fail=>"workflows.fail":Workflow,resolve=>"workflows.resolve":Workflow,cancel=>"workflows.cancel":Workflow});
group!(Maintenance,maintenance,{run=>"maintenance.run":Value});
group!(Prepaid,prepaid,{checkout=>"prepaid.checkout":Work});
group!(Periods,periods,{create=>"periods.create":Value,get=>"periods.get":Value,check=>"periods.check":Value,set_status=>"periods.setStatus":Value,reserve=>"periods.reserve":Value,settle=>"periods.settle":Value,release=>"periods.release":Value});
