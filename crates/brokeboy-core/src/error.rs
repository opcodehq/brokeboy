use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

/// Serializable errors never contain database connection strings or provider secrets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BillingError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl BillingError {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.into(),
            message: code.into(),
            details: None,
        }
    }

    pub fn message(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
}

impl fmt::Display for BillingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for BillingError {}
pub type Result<T> = std::result::Result<T, BillingError>;

pub fn identifier(value: &str) -> Result<&str> {
    const RESERVED: &[&str] = &[
        "constructor",
        "__defineGetter__",
        "__defineSetter__",
        "hasOwnProperty",
        "__lookupGetter__",
        "__lookupSetter__",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toString",
        "valueOf",
        "__proto__",
        "toLocaleString",
    ];
    if value.is_empty()
        || value.len() > 128
        || RESERVED.contains(&value)
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:@/-".contains(&b))
    {
        return Err(BillingError::new("invalid_identifier"));
    }
    Ok(value)
}

pub fn timestamp(value: i64) -> Result<i64> {
    if !(0..=9_007_199_254_740_991).contains(&value) {
        return Err(BillingError::new("invalid_timestamp"));
    }
    Ok(value)
}
