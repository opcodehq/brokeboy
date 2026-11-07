//! Native administration with application-owned infrastructure.
use brokeboy::{Billing, BillingOptions, config::OpenConfig};
use brokeboy_core::{
    BillingError, Result,
    compatibility::hash_v1,
    schema::{Dialect, migration_sql},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, Read, Write},
    path::PathBuf,
};
fn error(code: &str) -> BillingError {
    BillingError::new(code)
}
fn read_json(path: &str) -> Result<Value> {
    let input = if path == "-" {
        let mut s = String::new();
        io::stdin()
            .read_to_string(&mut s)
            .map_err(|_| error("input_read_failed"))?;
        s
    } else {
        fs::read_to_string(path).map_err(|_| error("input_read_failed"))?
    };
    serde_json::from_str(&input).map_err(|_| error("invalid_json"))
}
fn flag(args: &mut Vec<String>, name: &str) -> Result<Option<String>> {
    if let Some(i) = args.iter().position(|a| a == name) {
        args.remove(i);
        if i >= args.len() {
            return Err(error("missing_flag_value"));
        }
        Ok(Some(args.remove(i)))
    } else {
        Ok(None)
    }
}
fn resolve_env(value: &mut Value, key: &str, reference: &str, required: bool) -> Result<()> {
    if value.get(key).is_some() {
        return Ok(());
    }
    if let Some(name) = value.get(reference).and_then(Value::as_str) {
        let env = std::env::var(name).map_err(|_| {
            BillingError::message(
                "missing_environment_variable",
                &format!("Configuration requires environment variable {name}."),
            )
        })?;
        value[key] = json!(env);
    } else if required {
        return Err(error("missing_configuration_value"));
    }
    Ok(())
}
fn config(path: &str) -> Result<OpenConfig> {
    let mut v = read_json(path)?;
    if !v["database"].is_object() {
        return Err(error("invalid_billing_configuration"));
    }
    resolve_env(&mut v["database"], "url", "urlEnv", true)?;
    if let Some(stripe) = v.get_mut("stripe").filter(|s| !s.is_null()) {
        resolve_env(stripe, "secretKey", "secretKeyEnv", true)?;
        resolve_env(stripe, "webhookSecret", "webhookSecretEnv", false)?;
    }
    serde_json::from_value(v).map_err(|_| error("invalid_billing_configuration"))
}
fn write_new(path: String, body: &str) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| {
            BillingError::message(
                "output_write_failed",
                "Output file must not already exist; choose a new path.",
            )
        })?
        .write_all(body.as_bytes())
        .map_err(|_| error("output_write_failed"))
}
fn output(v: &Value, path: Option<String>) -> Result<()> {
    let encoded = serde_json::to_string_pretty(v).map_err(|_| error("invalid_output"))? + "\n";
    if let Some(path) = path {
        write_new(path, &encoded)
    } else {
        print!("{encoded}");
        Ok(())
    }
}
async fn run() -> Result<()> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if matches!(
        args.first().map(String::as_str),
        None | Some("--help" | "-h")
    ) {
        println!(
            "brokeboy-native [--config brokeboy.json] COMMAND\n\ninit                            Write connection/catalog templates\nschema DIALECT                  Print explicit SQL migrations\ndoctor                          Check database/schema access\ncatalog diff FILE               Compare a catalog\ncatalog apply FILE              Publish with FILE.expectedRevision\ncatalog export [--out FILE]     Export configuration and its base revision\ncustomer inspect ID             Inspect an application customer\nreconcile ID                    Inspect ledger consistency\noperations retry FILE           Retry a durable operation\noperations resolve FILE         Record an audited resolution\nmigrate export ID [--out FILE]  Export customer history\nmigrate import FILE             Validate/import a snapshot\ncall METHOD FILE                Invoke the native SDK (FILE may be -)\nhash < input.json              Compute canonical_json_v1 hash\n\nStartup never applies migrations or creates payment resources."
        );
        return Ok(());
    }
    if matches!(args.first().map(String::as_str), Some("--version" | "-V")) {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let config_path = flag(&mut args, "--config")?.unwrap_or_else(|| "brokeboy.json".into());
    let out = flag(&mut args, "--out")?;
    if args.first().is_some_and(|a| a == "hash") {
        println!("{}", hash_v1(&read_json("-")?)?);
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "init") {
        let p = PathBuf::from(&config_path);
        let catalog = p.with_file_name("brokeboy.catalog.json");
        if p.exists() || catalog.exists() {
            return Err(error("configuration_already_exists"));
        }
        output(
            &json!({"database":{"driver":"postgres","urlEnv":"DATABASE_URL"},"environment":"test"}),
            Some(config_path),
        )?;
        output(
            &json!({"expectedRevision":0,"catalog":{"features":[],"plans":[]}}),
            Some(catalog.to_string_lossy().into_owned()),
        )?;
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "schema") {
        let dialect: Dialect =
            serde_json::from_value(json!(args.get(1).ok_or_else(|| error("dialect_required"))?))
                .map_err(|_| error("unsupported_dialect"))?;
        let sql = migration_sql(dialect).join(";\n") + ";\n";
        if let Some(path) = out {
            write_new(path, &sql)?;
        } else {
            print!("{sql}");
        }
        return Ok(());
    }
    let billing = Billing::open_config(config(&config_path)?, BillingOptions::default()).await?;
    let result: Result<Value> = async {
        let command = args.first().map(String::as_str).unwrap_or("");
        let sub = args.get(1).map(String::as_str).unwrap_or("");
        let arg = args.get(2).map(String::as_str);
        match (command, sub) {
            ("doctor", _) => {
                billing.call("diagnostics.doctor", json!({})).await.map_err(|_| BillingError::message("doctor_failed", "Database or billing schema is unavailable. Generate and apply migrations explicitly, then retry."))
            }
            ("catalog", "diff") => { let v = read_json(arg.ok_or_else(|| error("input_file_required"))?)?; billing.call("catalog.diff", v.get("catalog").cloned().unwrap_or(v)).await }
            ("catalog", "apply") => { let v = read_json(arg.ok_or_else(|| error("input_file_required"))?)?; if !v["expectedRevision"].is_number() { return Err(error("catalog_base_revision_required")); } billing.call("catalog.publish", v).await }
            ("catalog", "export") => {
                let v = billing.call("catalog.export", json!({})).await?;
                let mut latest = std::collections::BTreeMap::<String, Value>::new();
                for plan in v["plans"].as_array().ok_or_else(|| error("invalid_catalog"))? {
                    let id = plan["id"].as_str().ok_or_else(|| error("invalid_catalog"))?;
                    if latest.get(id).is_none_or(|old| old["revision"].as_i64() < plan["revision"].as_i64()) { latest.insert(id.to_owned(), plan.clone()); }
                }
                let mut plans: Vec<Value> = latest.into_values().collect();
                for plan in &mut plans { let m = plan.as_object_mut().ok_or_else(|| error("invalid_catalog"))?; m.remove("version"); m.remove("revision"); }
                Ok(json!({"expectedRevision":v["revision"],"catalog":{"features":v["features"],"plans":plans}}))
            }
            ("customer", "inspect") => billing.call("customers.get", json!({"customerId":arg.ok_or_else(|| error("customer_required"))?})).await,
            ("reconcile", customer) => billing.call("credits.reconcile", json!({"customerId":customer})).await,
            ("operations", "retry" | "resolve") => billing.call(&format!("operations.{sub}"), read_json(arg.ok_or_else(|| error("input_file_required"))?)?).await,
            ("migrate", "export") => billing.call("migration.export", json!({"customerId":arg.ok_or_else(|| error("customer_required"))?})).await,
            ("migrate", "import") => billing.call("migration.import", read_json(arg.ok_or_else(|| error("input_file_required"))?)?).await,
            ("call", method) => billing.call(method, read_json(arg.unwrap_or("-"))?).await,
            _ => Err(error("unknown_command")),
        }
    }.await;
    let closed = billing.close().await;
    let result = result?;
    closed?;
    output(&result, out)
}
#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("{}: {}", e.code, e.message);
        std::process::exit(1);
    }
}
