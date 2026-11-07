use crate::storage::Transaction;
use brokeboy_core::{
    BillingError, Result,
    decimal::Decimal,
    records::{Row, Table},
};
use serde_json::{Value, json};

pub(crate) fn require(condition: bool, code: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(BillingError::new(code))
    }
}
pub(crate) fn s<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key).and_then(Value::as_str).ok_or_else(|| {
        BillingError::message("invalid_record", &format!("Expected string field {key}."))
    })
}
pub(crate) fn opt<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}
pub(crate) fn n(v: &Value, key: &str) -> Result<i64> {
    v.get(key).and_then(Value::as_i64).ok_or_else(|| {
        BillingError::message("invalid_record", &format!("Expected integer field {key}."))
    })
}
pub(crate) fn arr<'a>(v: &'a Value, key: &str) -> Result<&'a [Value]> {
    v.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| {
            BillingError::message("invalid_record", &format!("Expected array field {key}."))
        })
}
pub(crate) fn u(value: &str) -> Result<i128> {
    Ok(value.parse::<Decimal>()?.scaled())
}
pub(crate) fn d(value: i128) -> Result<String> {
    Ok(Decimal::from_scaled(value)?.to_string())
}
pub(crate) fn amount(v: &Value, key: &str) -> Result<i128> {
    u(s(v, key)?)
}
pub(crate) fn optional_amount(v: &Value, key: &str) -> Result<i128> {
    u(opt(v, key).unwrap_or("0"))
}
pub(crate) fn nonnegative(value: &str) -> Result<i128> {
    let n = u(value)?;
    require(n >= 0, "invalid_amount")?;
    Ok(n)
}
pub(crate) fn positive(value: &str) -> Result<i128> {
    let n = u(value)?;
    require(n > 0, "invalid_amount")?;
    Ok(n)
}
pub(crate) fn copy_optional(to: &mut Value, from: &Value, key: &str) {
    if let Some(value) = from.get(key) {
        to[key] = value.clone();
    }
}
pub(crate) async fn get(tx: &mut dyn Transaction, table: Table, id: &str) -> Result<Option<Value>> {
    Ok(tx.get(table, id).await?.map(|r| r.data))
}
pub(crate) async fn list(
    tx: &mut dyn Transaction,
    table: Table,
    state: Option<&str>,
) -> Result<Vec<Value>> {
    Ok(tx
        .list(table, state)
        .await?
        .into_iter()
        .map(|r| r.data)
        .collect())
}
pub(crate) async fn put(
    tx: &mut dyn Transaction,
    table: Table,
    id: &str,
    data: Value,
    state: &str,
) -> Result<()> {
    let state = if table == Table::Work && matches!(state, "pending" | "failed") {
        match opt(&data, "kind") {
            Some("meter") => format!("meter_{state}"),
            Some("workflow_timeout") => format!("internal_{state}"),
            _ => state.into(),
        }
    } else {
        state.into()
    };
    tx.put(
        table,
        Row {
            id: id.into(),
            state,
            data,
            extra: Default::default(),
        },
    )
    .await
}
pub(crate) fn empty_position() -> Value {
    json!({"spent":"0","held":"0"})
}
