use brokeboy_core::{
    compatibility::{canonical_json_v1, hash_v1},
    decimal::Decimal,
    error,
    pricing::{Interval, Rate, add_interval},
};
use serde_json::Value;
use std::str::FromStr;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../../test/fixtures/compatibility/v1.json")).unwrap()
}
fn compare(case: &Value, result: brokeboy_core::Result<Value>) {
    match result {
        Ok(value) => assert_eq!(value, case["result"], "{case}"),
        Err(error) => assert_eq!(error.code, case["error"].as_str().unwrap(), "{case}"),
    }
}
#[test]
fn canonical_json_and_hashes_match_legacy() {
    for case in fixtures()["hashes"].as_array().unwrap() {
        assert_eq!(
            canonical_json_v1(&case["input"]).unwrap(),
            case["canonical"]
        );
        assert_eq!(hash_v1(&case["input"]).unwrap(), case["hash"]);
    }
}
#[test]
fn fixed_point_range_rounding_and_spelling_match_legacy() {
    let fixture = fixtures();
    for case in fixture["decimals"].as_array().unwrap() {
        compare(
            case,
            Decimal::from_str(case["input"].as_str().unwrap()).map(
                |d| serde_json::json!({"scaled":d.scaled().to_string(), "decimal":d.to_string()}),
            ),
        );
    }
    for case in fixture["currencies"].as_array().unwrap() {
        compare(
            case,
            case["amount"]
                .as_str()
                .unwrap()
                .parse::<Decimal>()
                .and_then(|d| d.minor_units(case["currency"].as_str().unwrap()))
                .map(Value::String),
        );
    }
    for case in fixture["multiplication"].as_array().unwrap() {
        compare(
            case,
            case["a"]
                .as_str()
                .unwrap()
                .parse::<Decimal>()
                .and_then(|a| a.checked_mul(case["b"].as_str().unwrap().parse()?))
                .map(|d| Value::String(d.to_string())),
        );
    }
}
#[test]
fn pricing_and_calendars_match_legacy() {
    let fixture = fixtures();
    for case in fixture["pricing"].as_array().unwrap() {
        let rate: Rate = serde_json::from_value(case["rate"].clone()).unwrap();
        let properties = serde_json::from_value(case["properties"].clone()).unwrap();
        compare(
            case,
            rate.rate(
                case["quantity"].as_str().unwrap().parse().unwrap(),
                &properties,
            )
            .map(|d| Value::String(d.to_string())),
        );
    }
    for case in fixture["calendars"].as_array().unwrap() {
        let interval: Interval = serde_json::from_value(case["interval"].clone()).unwrap();
        compare(
            case,
            add_interval(
                case["start"].as_i64().unwrap(),
                interval,
                case["count"].as_u64().unwrap() as u32,
            )
            .map(Value::from),
        );
    }
}
#[test]
fn identifiers_match_legacy() {
    for case in fixtures()["identifiers"].as_array().unwrap() {
        compare(
            case,
            error::identifier(case["input"].as_str().unwrap()).map(|s| Value::String(s.into())),
        );
    }
}
#[test]
fn unknown_stored_fields_survive_roundtrip() {
    let input = serde_json::json!({"id":"x", "state":"active", "data":{"amount":"1.00", "future":{"flag":true}}, "futureRowField":42});
    let row: brokeboy_core::records::Row = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(row).unwrap(), input);
}

#[test]
fn native_schema_matches_each_frozen_dialect() {
    use brokeboy_core::schema::{Dialect, migration_sql};
    let fixture = fixtures();
    for (name, dialect) in [
        ("postgres", Dialect::Postgres),
        ("mysql", Dialect::Mysql),
        ("sqlite", Dialect::Sqlite),
    ] {
        assert_eq!(
            serde_json::to_value(migration_sql(dialect)).unwrap(),
            fixture["schema"][name]
        );
    }
}
