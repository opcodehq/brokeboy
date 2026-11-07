use crate::{BillingError, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// 0.1 sorted JSON compatibility. Hash raw validated wire inputs, before defaults
/// or typed decimal normalization. In particular, "1.00" must remain "1.00".
pub fn canonical_json_v1(value: &Value) -> Result<String> {
    serde_json_canonicalizer::to_string(value).map_err(|_| BillingError::new("invalid_json"))
}

pub fn hash_v1(value: &Value) -> Result<String> {
    let bytes = Sha256::digest(canonical_json_v1(value)?.as_bytes());
    Ok(format!("{bytes:x}"))
}

pub fn operation_hash(method: &str, raw_payload: &Value) -> Result<String> {
    hash_v1(&serde_json::json!({"method": method, "payload": raw_payload}))
}
