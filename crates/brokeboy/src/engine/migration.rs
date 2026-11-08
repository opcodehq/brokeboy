use super::*;
use crate::ledger::register_features;
use brokeboy_core::{
    compatibility::{canonical_json_v1, hash_v1},
    records::Row,
};
use std::collections::BTreeSet;
const ARCHIVE_TABLES: [Table; 15] = [
    Table::Customers,
    Table::Entities,
    Table::Subscriptions,
    Table::Grants,
    Table::Movements,
    Table::Reservations,
    Table::Usage,
    Table::Operations,
    Table::Inbox,
    Table::Work,
    Table::Events,
    Table::Audit,
    Table::Counters,
    Table::Licenses,
    Table::Workflows,
];
impl Billing {
    pub(crate) async fn adopt_stripe_customer(
        &self,
        input: Value,
        request: &RequestGuard,
    ) -> Result<Value> {
        let customer = identifier(s(&input, "customerId")?)?;
        let stripe = s(&input, "stripeCustomerId")?;
        let mut provider_input = input.clone();
        provider_input["provider"] = json!("stripe");
        let provider = self
            .0
            .options
            .provider
            .as_ref()
            .ok_or_else(|| BillingError::new("provider_missing"))?;
        let result = provider
            .execute(crate::provider::PaymentCommand {
                id: hash_v1(&input)?,
                kind: "customer_import".into(),
                customer: json!({"id":customer}),
                input: provider_input,
                resources: self.0.resources.clone(),
            })
            .await?;
        if input["dryRun"] != false {
            return Ok(
                json!({"dryRun":true,"customerId":customer,"stripeCustomerId":stripe,"verified":result}),
            );
        }
        let id = customer.to_owned();
        let existing = self
            .atomic(&self.scope(customer)?, move |tx| {
                Box::pin(
                    async move { Ok(get(tx, Table::Customers, &id).await?.unwrap_or(Value::Null)) },
                )
            })
            .await?;
        require(
            opt(&existing, "stripeCustomerId").is_none_or(|v| v == stripe),
            "customer_mapping_conflict",
        )?;
        self.0
            .resources
            .customer_link("stripe", stripe, Some(customer))
            .await?;
        let mut parameters = json!({"id":customer,"stripeCustomerId":stripe,"idempotencyKey":format!("adopt:{}",s(&input,"idempotencyKey")?)});
        let created = self
            .write("customers.create", &parameters, parameters.clone(), request)
            .await?;
        if opt(&created, "stripeCustomerId").is_none() {
            parameters["customerId"] = json!(customer);
            parameters["idempotencyKey"] =
                json!(format!("adopt-link:{}", s(&input, "idempotencyKey")?));
            self.write("customers.update", &parameters, parameters.clone(), request)
                .await?;
        }
        let id = customer.to_owned();
        self.atomic(&self.scope(customer)?, move |tx| {
            Box::pin(async move {
                get(tx, Table::Customers, &id)
                    .await?
                    .ok_or_else(|| BillingError::new("customer_not_found"))
            })
        })
        .await
    }
    pub(crate) async fn migration_export(
        &self,
        tx: &mut dyn Transaction,
        customer: &str,
    ) -> Result<Value> {
        let subscriptions = list(tx, Table::Subscriptions, None).await?;
        let grants = tx.list(Table::Grants, None).await?;
        let work = list(tx, Table::Work, None).await?;
        let workflows = tx.list(Table::Workflows, None).await?;
        let usage = tx.list(Table::Usage, None).await?;
        let mut blockers = Vec::new();
        for w in work {
            if opt(&w, "status") != Some("done")
                && !matches!(opt(&w, "kind"), Some("event" | "workflow_timeout"))
            {
                blockers.push(format!("operation:{}", s(&w, "id")?));
            }
        }
        for w in workflows {
            if matches!(w.state.as_str(), "active" | "reconciliation") {
                blockers.push(format!("active_workflow:{}", w.id));
            }
        }
        for row in usage {
            if row.state != "reversed"
                && opt(&row.data, "currency").is_some()
                && amount(&row.data, "charged")? != 0
            {
                let at = n(&row.data, "createdAt")?;
                if subscriptions.iter().any(|s| {
                    s["periodStart"].as_i64().is_some_and(|start| at >= start)
                        && s["periodEnd"].as_i64().is_some_and(|end| at < end)
                }) {
                    blockers.push("open_postpaid_period".into());
                    break;
                }
            }
        }
        let counters = tx.list(Table::Counters, None).await?;
        let policy: Vec<_> = counters
            .iter()
            .filter(|r| {
                r.id == "trial-claimed" || r.id == "topup-pending" || r.id.starts_with("topup:")
            })
            .cloned()
            .collect();
        if get(tx, Table::Counters, "topup-pending")
            .await?
            .as_ref()
            .and_then(|v| opt(v, "operationId"))
            .is_some()
        {
            blockers.push("pending_topup_confirmation".into());
        }
        let mut archive = json!({});
        for table in ARCHIVE_TABLES {
            archive[table.name()] = json!(tx.list(table, None).await?);
        }
        let mut states = json!({});
        let mut positions = Vec::new();
        let mut grant_data = Vec::new();
        for row in grants {
            states[&row.id] = json!(row.state);
            let mut p = self.0.ledger.position(tx, &row.id).await?;
            p["grantId"] = json!(row.id);
            positions.push(p);
            grant_data.push(row.data);
        }
        let quantities: Vec<_> = counters
            .into_iter()
            .filter(|r| r.id.starts_with("quantity:"))
            .map(|r| json!({"id":r.id,"data":r.data}))
            .collect();
        Ok(
            json!({"archive":archive,"grantStates":states,"policyCounters":policy,"format":1,"environment":self.0.options.environment.name(),"customer":self.customer(tx,customer).await?,"entities":list(tx,Table::Entities,None).await?,"grants":grant_data,"positions":positions,"subscriptions":subscriptions,"reservations":list(tx,Table::Reservations,Some("held")).await?,"licenses":list(tx,Table::Licenses,Some("active")).await?,"quantities":quantities,"blockers":blockers}),
        )
    }
    pub(crate) async fn migration_import(
        &self,
        input: Value,
        request: &RequestGuard,
    ) -> Result<Value> {
        let snapshot = &input["snapshot"];
        require(
            snapshot["format"] == 1
                && opt(snapshot, "environment") == Some(self.0.options.environment.name()),
            "invalid_snapshot",
        )?;
        let customer = identifier(s(&snapshot["customer"], "id")?)?;
        let grants = arr(snapshot, "grants")?;
        let positions = arr(snapshot, "positions")?;
        let mut ids = BTreeSet::new();
        for g in grants {
            require(ids.insert(s(g, "id")?), "invalid_snapshot")?;
        }
        require(positions.len() == grants.len(), "invalid_snapshot")?;
        for g in grants {
            nonnegative(s(g, "amount")?)?;
            let p = positions
                .iter()
                .find(|p| p["grantId"] == g["id"])
                .ok_or_else(|| BillingError::new("invalid_snapshot"))?;
            require(
                nonnegative(s(p, "spent")?)? + nonnegative(s(p, "held")?)? <= amount(g, "amount")?,
                "invalid_snapshot",
            )?;
        }
        let mut blockers = snapshot["blockers"].as_array().cloned().unwrap_or_default();
        if !arr(snapshot, "reservations")?.is_empty()
            || positions.iter().any(|p| {
                p["held"]
                    .as_str()
                    .and_then(|v| u(v).ok())
                    .is_some_and(|v| v != 0)
            })
        {
            blockers.push(json!("active_reservations"));
        }
        if input["dryRun"] == true {
            return Ok(
                json!({"customerId":customer,"grants":grants.len(),"dryRun":true,"blockers":blockers}),
            );
        }
        require(blockers.is_empty(), "migration_requires_reconciliation")?;
        let key = format!("import:{}", hash_v1(&json!(s(&input, "idempotencyKey")?))?);
        let this = self.clone();
        let imported = snapshot.clone();
        let original_key = s(&input, "idempotencyKey")?.to_owned();
        self.0
            .operations
            .write(
                WriteScope {
                    customer_id: customer,
                    entity_id: None,
                    idempotency_key: &key,
                },
                "migration.import",
                snapshot,
                true,
                Some(request),
                move |tx, _| {
                    Box::pin(
                        async move { this.import_snapshot(tx, &imported, &original_key).await },
                    )
                },
            )
            .await
    }
    async fn import_snapshot(
        &self,
        tx: &mut dyn Transaction,
        snapshot: &Value,
        key: &str,
    ) -> Result<Value> {
        let customer = s(&snapshot["customer"], "id")?;
        require(
            get(tx, Table::Customers, customer).await?.is_none(),
            "import_customer_exists",
        )?;
        if let Some(archive) = snapshot.get("archive") {
            let rows = arr(archive, "customers")?;
            require(
                rows.len() == 1
                    && opt(&rows[0], "id") == Some(customer)
                    && canonical_json_v1(&rows[0]["data"])?
                        == canonical_json_v1(&snapshot["customer"])?,
                "invalid_snapshot",
            )?;
            for (name, rows) in archive
                .as_object()
                .ok_or_else(|| BillingError::new("invalid_snapshot"))?
            {
                let table = ARCHIVE_TABLES
                    .iter()
                    .find(|t| t.name() == name)
                    .copied()
                    .ok_or_else(|| BillingError::new("invalid_snapshot"))?;
                for raw in rows
                    .as_array()
                    .ok_or_else(|| BillingError::new("invalid_snapshot"))?
                {
                    let row: Row = serde_json::from_value(raw.clone())
                        .map_err(|_| BillingError::new("invalid_snapshot"))?;
                    tx.put(table, row).await?;
                }
            }
        } else {
            put(
                tx,
                Table::Customers,
                customer,
                snapshot["customer"].clone(),
                "active",
            )
            .await?;
            for e in arr(snapshot, "entities")? {
                put(tx, Table::Entities, s(e, "id")?, e.clone(), "active").await?;
            }
            for g in arr(snapshot, "grants")? {
                let id = s(g, "id")?;
                let state = snapshot["grantStates"]
                    .get(id)
                    .and_then(Value::as_str)
                    .unwrap_or("active");
                put(tx, Table::Grants, id, g.clone(), state).await?;
                let p = arr(snapshot, "positions")?
                    .iter()
                    .find(|p| opt(p, "grantId") == Some(id))
                    .ok_or_else(|| BillingError::new("invalid_snapshot"))?;
                if amount(p, "spent")? > 0 {
                    self.0
                        .ledger
                        .movement(
                            tx,
                            id,
                            amount(p, "spent")?,
                            key,
                            "import_opening_balance",
                            None,
                        )
                        .await?;
                }
            }
            if let Some(counters) = snapshot["policyCounters"].as_array() {
                for c in counters {
                    put(
                        tx,
                        Table::Counters,
                        s(c, "id")?,
                        c["data"].clone(),
                        s(c, "state")?,
                    )
                    .await?;
                }
            }
            if let Some(licenses) = snapshot["licenses"].as_array() {
                for l in licenses {
                    put(tx, Table::Licenses, s(l, "id")?, l.clone(), "active").await?;
                }
            }
            if let Some(quantities) = snapshot["quantities"].as_array() {
                for q in quantities {
                    put(
                        tx,
                        Table::Counters,
                        s(q, "id")?,
                        q["data"].clone(),
                        "active",
                    )
                    .await?;
                }
            }
            for sub in arr(snapshot, "subscriptions")? {
                register_features(tx, &sub["plan"]).await?;
                let state = if matches!(opt(sub, "status"), Some("active" | "trialing")) {
                    "active"
                } else {
                    s(sub, "status")?
                };
                put(tx, Table::Subscriptions, s(sub, "id")?, sub.clone(), state).await?;
            }
        }
        require(
            self.0.ledger.reconcile(tx).await?["consistent"] == true,
            "invalid_snapshot_ledger",
        )?;
        Ok(json!({"customerId":customer,"grants":arr(snapshot,"grants")?.len(),"dryRun":false}))
    }
}
