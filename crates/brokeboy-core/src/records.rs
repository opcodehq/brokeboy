use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Raw stored data is retained, including fields introduced by another SDK.
/// Domain-specific decoding must never overwrite this with a lossy projection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Row {
    pub id: String,
    pub state: String,
    pub data: Value,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Table {
    Resources,
    Customers,
    Entities,
    Catalog,
    Subscriptions,
    Grants,
    Movements,
    Reservations,
    Usage,
    Operations,
    Inbox,
    Work,
    Events,
    Audit,
    Counters,
    Licenses,
    Workflows,
}
impl Table {
    pub const ALL: [Self; 17] = [
        Self::Resources,
        Self::Customers,
        Self::Entities,
        Self::Catalog,
        Self::Subscriptions,
        Self::Grants,
        Self::Movements,
        Self::Reservations,
        Self::Usage,
        Self::Operations,
        Self::Inbox,
        Self::Work,
        Self::Events,
        Self::Audit,
        Self::Counters,
        Self::Licenses,
        Self::Workflows,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Resources => "resources",
            Self::Customers => "customers",
            Self::Entities => "entities",
            Self::Catalog => "catalog",
            Self::Subscriptions => "subscriptions",
            Self::Grants => "grants",
            Self::Movements => "movements",
            Self::Reservations => "reservations",
            Self::Usage => "usage",
            Self::Operations => "operations",
            Self::Inbox => "inbox",
            Self::Work => "work",
            Self::Events => "events",
            Self::Audit => "audit",
            Self::Counters => "counters",
            Self::Licenses => "licenses",
            Self::Workflows => "workflows",
        }
    }
}
