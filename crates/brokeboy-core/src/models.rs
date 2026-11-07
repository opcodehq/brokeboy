//! Wire models preserve decimal spelling. Arithmetic uses `decimal::Decimal`.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
pub type Metadata = BTreeMap<String, String>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
pub struct DatabaseConnection {
    pub driver: crate::schema::Dialect,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub max_connections: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub acquire_timeout_ms: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
pub struct StripeConnection {
    pub secret_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub webhook_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub api_base: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
pub struct OpenConfig {
    pub database: DatabaseConnection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub environment: Option<Environment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub stripe: Option<StripeConnection>,
}
macro_rules! enumeration{
    ($name:ident{$first:ident$(,$variant:ident)*$(,)?})=>{
        #[derive(Debug,Clone,Copy,Default,PartialEq,Eq,Serialize,Deserialize)]
        #[serde(rename_all="snake_case")]
        #[cfg_attr(feature="typescript",derive(ts_rs::TS))]
        pub enum $name{#[default]$first,$($variant),*}
    }
}
macro_rules! model{
    ($name:ident {required{$($(#[$field_meta:meta])* $field:ident:$ty:ty),*$(,)?} optional{$($(#[$optional_meta:meta])* $optional:ident:$optional_ty:ty),*$(,)?}})=>{
        #[derive(Debug,Clone,Default,PartialEq,Serialize,Deserialize)]
        #[serde(rename_all="camelCase")]
        #[cfg_attr(feature="typescript",derive(ts_rs::TS))]
        pub struct $name{
            $($(#[$field_meta])* pub $field:$ty,)*
            $($(#[$optional_meta])* #[serde(default,skip_serializing_if="Option::is_none")]
            #[cfg_attr(feature="typescript",ts(optional))]
            pub $optional:Option<$optional_ty>,)*
            #[serde(flatten)]
            #[cfg_attr(feature="typescript",ts(skip))]
            pub extra:BTreeMap<String,Value>,
        }
    }
}
enumeration!(Environment { Test, Live });
impl Environment {
    pub fn name(self) -> &'static str {
        match self {
            Self::Test => "test",
            Self::Live => "live",
        }
    }
}
enumeration!(FeatureKind {
    Boolean,
    Consumable,
    Quantity
});
enumeration!(TierMode { Graduated, Volume });
enumeration!(Interval { Month, Year });
enumeration!(Reset { Month, Year, Never });
enumeration!(PoolScope { Customer, Entity });
enumeration!(PlanKind {
    Subscription,
    OneTime,
    Free
});
enumeration!(SubscriptionStatus {
    Pending,
    Active,
    Trialing,
    PastDue,
    Paused,
    Ended
});
enumeration!(GrantOrigin {
    Manual,
    Subscription,
    Purchase,
    Rollover,
    Import
});
enumeration!(ReservationStatus {
    Held,
    Settled,
    Released,
    Expired
});
enumeration!(WorkStatus {
    Pending,
    Processing,
    Done,
    Failed,
    Reconciliation
});
enumeration!(StepStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Reconciliation
});
enumeration!(WorkflowStatus {
    Active,
    Succeeded,
    Failed,
    Cancelled,
    Reconciliation
});
model!(Feature{required{id:String,kind:FeatureKind}optional{}});
model!(Tier{required{up_to:Option<String>,amount:String}optional{flat:String}});
model!(Dimension{required{r#match:Metadata,amount:String}optional{}});
model!(Rate{required{}optional{amount:String,tiers:Vec<Tier>,mode:TierMode,dimensions:Vec<Dimension>}});
model!(Rollover{required{maximum:String,periods:u32}optional{}});
model!(PlanItem{required{feature:String}optional{kind:FeatureKind,included:String,enabled:bool,pool:String,pool_scope:PoolScope,rate:Rate,overage:bool,reset:Reset,rollover:Rollover}});
model!(Plan{required{id:String,name:String,items:Vec<PlanItem>}optional{public:bool,add_on:bool,group:String,currency:String,amount:String,interval:Interval,kind:PlanKind,trial_days:u32,trial_included:BTreeMap<String,String>,grace_days:u32,grace_included:BTreeMap<String,String>,stripe_price_id:String,stripe_meter_price_ids:BTreeMap<String,String>,seat_price_id:String}});
model!(Catalog{required{features:Vec<Feature>,plans:Vec<Plan>}optional{}});
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
pub struct PublishedPlan {
    #[serde(flatten)]
    pub plan: Plan,
    pub version: String,
    pub revision: i64,
}
model!(Alert{required{feature:String,remaining:String}optional{}});
model!(AutoTopUp{required{feature:String,below:String,pack_plan:String,maximum_purchases:u32}optional{}});
model!(Controls{required{}optional{overage_limits:BTreeMap<String,String>,alerts:Vec<Alert>,auto_top_up:AutoTopUp}});
model!(Customer{required{id:String,metadata:Metadata,controls:Controls}optional{stripe_customer_id:String}});
model!(Entity{required{id:String,metadata:Metadata}optional{}});
model!(ProvisioningOffset{required{until:i64,granted:BTreeMap<String,String>}optional{}});
model!(ScheduledPlan{required{plan:PublishedPlan,start:i64,end:i64}optional{}});
model!(Subscription{required{id:String,plan:PublishedPlan,status:SubscriptionStatus,period_start:i64,period_end:i64,paid_through:i64,quantity:String}optional{entity_id:String,grace_through:i64,stripe_subscription_id:String,purchase_id:String,cancel_at_period_end:bool,provisioning_offset:ProvisioningOffset,next_plan:PublishedPlan,scheduled_plans:Vec<ScheduledPlan>}});
model!(Grant{required{id:String,feature:String,amount:String,priority:i64,origin:GrantOrigin,source_id:String,created_at:i64}optional{entity_id:String,expires_at:i64}});
model!(Movement{required{id:String,grant_id:String,amount:String,operation_id:String,created_at:i64,reason:String}optional{reverses:String}});
model!(Allocation{required{grant_id:String,amount:String}optional{}});
model!(Reservation{required{id:String,feature:String,amount:String,allocations:Vec<Allocation>,expires_at:i64,status:ReservationStatus}optional{entity_id:String,pool_scope:PoolScope}});
model!(Usage{required{id:String,feature:String,quantity:String,charged:String,allocations:Vec<Allocation>,created_at:i64,properties:Metadata}optional{entity_id:String,currency:String,plan_version:String,reverses:String}});
model!(Balance{required{feature:String,granted:String,spent:String,reserved:String,available:String}optional{}});
model!(Work{required{id:String,kind:String,#[cfg_attr(feature="typescript",ts(type="Record<string, unknown>"))]payload:BTreeMap<String,Value>,status:WorkStatus,attempts:u32,available_at:i64,created_at:i64}optional{lease_until:i64,lease_owner:String,#[cfg_attr(feature="typescript",ts(type="unknown"))]result:Value,error:String,#[cfg_attr(feature="typescript",ts(type="unknown"))]details:Value}});
model!(ScopeInput{required{customer_id:String}optional{entity_id:String}});
model!(WriteInput{required{customer_id:String,idempotency_key:String}optional{entity_id:String}});
model!(UsageInput{required{customer_id:String,idempotency_key:String,feature:String,amount:String}optional{entity_id:String,properties:Metadata}});
model!(Budget{required{feature:String,amount:String}optional{pool_scope:PoolScope}});
model!(WorkflowStepDefinition{required{id:String,budgets:Vec<Budget>}optional{depends_on:Vec<String>,max_attempts:u32}});
model!(ReservationRef{required{feature:String,reservation_id:String}optional{}});
model!(Lease{required{token:String,worker_id:String,until:i64}optional{}});
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typescript", derive(ts_rs::TS))]
pub struct WorkflowStep {
    #[serde(flatten)]
    pub definition: WorkflowStepDefinition,
    pub status: StepStatus,
    pub attempts: u32,
    pub available_at: i64,
    pub reservations: Vec<ReservationRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub lease: Option<Lease>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub usage_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript", ts(optional))]
    pub reported_actuals: Option<BTreeMap<String, String>>,
}
model!(Workflow{required{id:String,status:WorkflowStatus,revision:i64,created_at:i64,expires_at:i64,steps:Vec<WorkflowStep>}optional{entity_id:String,cancellation_requested:bool}});

#[cfg(feature = "typescript")]
pub fn declarations() -> String {
    use ts_rs::TS;
    let config = ts_rs::Config::default().with_large_int("number");
    let mut result = String::from(
        "// Generated from brokeboy-core::models. Do not edit by hand.\nexport type Decimal = string;\nexport type Metadata = Record<string, string>;\n",
    );
    macro_rules! emit{($($ty:ty),+)=>{$(result.push_str("export ");result.push_str(&<$ty>::decl(&config));result.push('\n');)+}}
    emit!(
        Value,
        crate::schema::Dialect,
        DatabaseConnection,
        StripeConnection,
        OpenConfig,
        Environment,
        FeatureKind,
        TierMode,
        Interval,
        Reset,
        PoolScope,
        PlanKind,
        SubscriptionStatus,
        GrantOrigin,
        ReservationStatus,
        WorkStatus,
        StepStatus,
        WorkflowStatus,
        Feature,
        Tier,
        Dimension,
        Rate,
        Rollover,
        PlanItem,
        Plan,
        Catalog,
        PublishedPlan,
        Alert,
        AutoTopUp,
        Controls,
        Customer,
        Entity,
        ProvisioningOffset,
        ScheduledPlan,
        Subscription,
        Grant,
        Movement,
        Allocation,
        Reservation,
        Usage,
        Balance,
        Work,
        ScopeInput,
        WriteInput,
        UsageInput,
        Budget,
        WorkflowStepDefinition,
        ReservationRef,
        Lease,
        WorkflowStep,
        Workflow
    );
    result
}
