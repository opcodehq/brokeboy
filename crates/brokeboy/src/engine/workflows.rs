//! Durable DAG execution, held budgets, fenced leases and explicit recovery.
use super::*;
use crate::storage::PageQuery;
use brokeboy_core::error::timestamp;
use std::collections::BTreeSet;

fn index(w: &Value, id: &str) -> Result<usize> {
    arr(w, "steps")?
        .iter()
        .position(|s| opt(s, "id") == Some(id))
        .ok_or_else(|| BillingError::new("workflow_step_not_found"))
}
fn steps(w: &Value) -> Result<Vec<Value>> {
    Ok(arr(w, "steps")?.to_vec())
}
fn actuals(step: &Value, amounts: &Value) -> Result<()> {
    let values = amounts
        .as_object()
        .ok_or_else(|| BillingError::new("workflow_actuals_required"))?;
    let budgets = arr(step, "budgets")?;
    require(
        values.len() == budgets.len()
            && budgets
                .iter()
                .all(|b| opt(b, "feature").is_some_and(|f| values.contains_key(f))),
        "workflow_actuals_required",
    )?;
    for b in budgets {
        nonnegative(
            values[s(b, "feature")?]
                .as_str()
                .ok_or_else(|| BillingError::new("invalid_decimal"))?,
        )?;
    }
    Ok(())
}
fn bounded(p: &Value, key: &str, default: i64, min: i64, max: i64, code: &str) -> Result<i64> {
    let value = match p.get(key) {
        None => default,
        Some(v) => v.as_i64().ok_or_else(|| BillingError::new(code))?,
    };
    require((min..=max).contains(&value), code)?;
    Ok(value)
}
impl Billing {
    async fn workflow_load(&self, tx: &mut dyn Transaction, p: &Value) -> Result<Value> {
        let w = get(tx, Table::Workflows, identifier(s(p, "workflowId")?)?)
            .await?
            .ok_or_else(|| BillingError::new("workflow_not_found"))?;
        require(w.get("entityId") == p.get("entityId"), "workflow_not_found")?;
        Ok(w)
    }
    async fn workflow_save(
        &self,
        tx: &mut dyn Transaction,
        customer: &str,
        mut w: Value,
        kind: &str,
    ) -> Result<Value> {
        w["revision"] = json!(n(&w, "revision")? + 1);
        require(
            serde_json::to_vec(&w)
                .map_err(|_| BillingError::new("invalid_record"))?
                .len()
                <= 524288,
            "workflow_state_too_large",
        )?;
        put(
            tx,
            Table::Workflows,
            s(&w, "id")?,
            w.clone(),
            s(&w, "status")?,
        )
        .await?;
        self.event(
            tx,
            customer,
            kind,
            json!({"workflowId":w["id"],"revision":w["revision"],"status":w["status"]}),
        )
        .await?;
        Ok(w)
    }
    async fn workflow_schedule(
        &self,
        tx: &mut dyn Transaction,
        id: &str,
        at: i64,
        token: Option<&str>,
    ) -> Result<()> {
        let key = format!("workflow:{}", self.id());
        let mut payload = json!({"workflowId":id});
        if let Some(token) = token {
            payload["token"] = json!(token);
        }
        self.enqueue(tx, &key, "workflow_timeout", payload).await?;
        let mut work = get(tx, Table::Work, &key)
            .await?
            .ok_or_else(|| BillingError::new("operation_not_found"))?;
        work["availableAt"] = json!(at);
        put(tx, Table::Work, &key, work, "pending").await
    }
    async fn workflow_release(&self, tx: &mut dyn Transaction, step: &Value) -> Result<()> {
        for r in arr(step, "reservations")? {
            if let Some(row) = tx.get(Table::Reservations, s(r, "reservationId")?).await?
                && row.state == "held"
            {
                self.0
                    .ledger
                    .finish_reservation(tx, &row.data, "released")
                    .await?;
            }
        }
        Ok(())
    }
    async fn workflow_refresh(&self, tx: &mut dyn Transaction, w: &mut Value) -> Result<()> {
        let mut all = steps(w)?;
        let status = if all
            .iter()
            .any(|s| opt(s, "status") == Some("reconciliation"))
        {
            "reconciliation"
        } else if w["cancellationRequested"] == true
            || all.iter().any(|s| opt(s, "status") == Some("failed"))
        {
            for step in &mut all {
                if opt(step, "status") == Some("pending") {
                    self.workflow_release(tx, step).await?;
                    step["status"] = json!("cancelled");
                }
            }
            if all.iter().any(|s| opt(s, "status") == Some("running")) {
                "active"
            } else if w["cancellationRequested"] == true {
                "cancelled"
            } else {
                "failed"
            }
        } else if all.iter().all(|s| opt(s, "status") == Some("succeeded")) {
            "succeeded"
        } else {
            "active"
        };
        w["steps"] = json!(all);
        w["status"] = json!(status);
        Ok(())
    }
    async fn workflow_holds(&self, tx: &mut dyn Transaction, step: &Value) -> Result<bool> {
        for r in arr(step, "reservations")? {
            let Some(row) = tx.get(Table::Reservations, s(r, "reservationId")?).await? else {
                return Ok(false);
            };
            if row.state != "held" || !self.0.ledger.reservation_funded(tx, &row.data).await? {
                return Ok(false);
            }
        }
        Ok(true)
    }
    fn workflow_lease(&self, step: &Value, token: &str) -> Result<()> {
        require(
            opt(step, "status") == Some("running")
                && opt(&step["lease"], "token") == Some(token)
                && step["lease"]["until"]
                    .as_i64()
                    .is_some_and(|v| v > self.now()),
            "workflow_lease_lost",
        )
    }
    async fn workflow_settle(
        &self,
        tx: &mut dyn Transaction,
        p: &Value,
        step: &mut Value,
        amounts: &Value,
        operation: &str,
        fund: bool,
    ) -> Result<bool> {
        actuals(step, amounts)?;
        if let Some(result) = p.get("result") {
            require(
                serde_json::to_vec(result)
                    .map_err(|_| BillingError::new("invalid_workflow_result"))?
                    .len()
                    <= 65536,
                "workflow_result_too_large",
            )?;
        }
        step["reportedActuals"] = amounts.clone();
        let mut uncovered = !self.workflow_holds(tx, step).await?;
        let mut nonzero = false;
        for b in arr(step, "budgets")? {
            let value = nonnegative(s(amounts, s(b, "feature")?)?)?;
            uncovered |= value > amount(b, "amount")?;
            nonzero |= value > 0;
        }
        if uncovered && !fund && nonzero {
            step["status"] = json!("reconciliation");
            step["error"] = json!("workflow_uncovered_actuals");
            return Ok(false);
        }
        if uncovered {
            self.workflow_release(tx, step).await?;
        }
        let mut usages = Vec::new();
        for reference in arr(step, "reservations")? {
            let feature = s(reference, "feature")?;
            let reservation = s(reference, "reservationId")?;
            let r = get(tx, Table::Reservations, reservation)
                .await?
                .ok_or_else(|| BillingError::new("reservation_not_found"))?;
            let value = s(amounts, feature)?;
            let properties = json!({"workflowId":p["workflowId"],"stepId":step["id"]});
            let usage = if uncovered {
                let entity = if opt(&r, "poolScope") == Some("customer") {
                    None
                } else {
                    opt(&r, "entityId")
                };
                let allocations = self
                    .0
                    .ledger
                    .allocate(tx, feature, u(value)?, entity, false, operation)
                    .await?;
                let id = self.id();
                let mut properties = properties;
                properties["reservationId"] = json!(reservation);
                let mut usage = json!({"id":id,"feature":feature,"quantity":value,"charged":value,"allocations":allocations,"createdAt":self.now(),"properties":properties});
                copy_optional(&mut usage, &r, "entityId");
                put(tx, Table::Usage, &id, usage.clone(), "active").await?;
                usage
            } else {
                self.0
                    .ledger
                    .settle_reservation(tx, &r, value, operation, properties)
                    .await?
            };
            usages.push(usage["id"].clone());
            let entity = if opt(&r, "poolScope") == Some("customer") {
                None
            } else {
                opt(&r, "entityId")
            };
            self.after_usage(tx, s(p, "customerId")?, feature, entity)
                .await?;
        }
        step["usageIds"] = json!(usages);
        copy_optional(step, p, "result");
        for key in ["lease", "error", "reportedActuals"] {
            step.as_object_mut().unwrap().remove(key);
        }
        Ok(true)
    }
    pub(crate) async fn workflow_read(
        &self,
        tx: &mut dyn Transaction,
        method: &str,
        p: &Value,
    ) -> Result<Value> {
        if method == "workflows.get" {
            return self.workflow_load(tx, p).await;
        }
        let limit = bounded(p, "limit", 50, 1, 1000, "invalid_limit")? as usize;
        let rows = tx
            .page(
                Table::Workflows,
                PageQuery {
                    after: opt(p, "cursor").map(str::to_owned),
                    limit: limit as u32 + 1,
                    ..Default::default()
                },
            )
            .await?;
        let mut result = json!({"items":rows.iter().take(limit).map(|r|r.data.clone()).filter(|w|w.get("entityId")==p.get("entityId")).collect::<Vec<_>>()});
        if rows.len() > limit {
            result["nextCursor"] = json!(rows[limit - 1].id);
        }
        Ok(result)
    }
    pub(crate) async fn workflow_action(
        &self,
        tx: &mut dyn Transaction,
        method: &str,
        p: &Value,
        operation: &str,
    ) -> Result<Value> {
        let customer = s(p, "customerId")?;
        if method == "workflows.create" {
            let id = identifier(s(p, "workflowId")?)?;
            require(
                get(tx, Table::Workflows, id).await?.is_none(),
                "workflow_exists",
            )?;
            let expiry = timestamp(bounded(
                p,
                "expiresAt",
                self.now() + 15 * 60000,
                self.now() + 1,
                self.now() + 30 * 86400000,
                "invalid_expiry",
            )?)?;
            let definitions = arr(p, "steps")?;
            let mut total = 0;
            for step in definitions {
                total += arr(step, "budgets")?.len();
            }
            require(
                !definitions.is_empty() && definitions.len() <= 32 && total <= 32,
                "workflow_too_large",
            )?;
            let mut ids = BTreeSet::new();
            for step in definitions {
                require(
                    ids.insert(identifier(s(step, "id")?)?),
                    "duplicate_workflow_step",
                )?;
            }
            let mut visited = BTreeSet::new();
            while visited.len() < definitions.len() {
                let before = visited.len();
                for step in definitions {
                    let id = s(step, "id")?;
                    let dependencies = step["dependsOn"].as_array().cloned().unwrap_or_default();
                    if !visited.contains(id)
                        && dependencies
                            .iter()
                            .all(|id| id.as_str().is_some_and(|v| visited.contains(v)))
                    {
                        visited.insert(id);
                    }
                }
                require(visited.len() > before, "invalid_workflow_dependencies")?;
            }
            self.0.ledger.materialize(tx).await?;
            let mut all = Vec::new();
            let mut expires = expiry;
            for definition in definitions {
                let attempts = bounded(
                    definition,
                    "maxAttempts",
                    3,
                    1,
                    100,
                    "invalid_attempt_limit",
                )?;
                let budgets = arr(definition, "budgets")?;
                let mut unique = BTreeSet::new();
                require(budgets.len() <= 8, "invalid_workflow_budgets")?;
                for b in budgets {
                    require(unique.insert(s(b, "feature")?), "invalid_workflow_budgets")?;
                }
                let mut step = definition.clone();
                step["maxAttempts"] = json!(attempts);
                step["status"] = json!("pending");
                step["attempts"] = json!(0);
                step["availableAt"] = json!(self.now());
                let mut reservations = Vec::new();
                for b in budgets {
                    let feature = identifier(s(b, "feature")?)?;
                    positive(s(b, "amount")?)?;
                    let kind = get(tx, Table::Counters, &format!("feature-kind:{feature}")).await?;
                    require(
                        kind.as_ref()
                            .and_then(|v| opt(v, "kind"))
                            .is_none_or(|v| v == "consumable"),
                        "workflow_consumable_required",
                    )?;
                    require(
                        matches!(opt(b, "poolScope"), None | Some("customer" | "entity")),
                        "invalid_pool_scope",
                    )?;
                    let mut input = b.clone();
                    copy_optional(&mut input, p, "entityId");
                    input["expiresAt"] = json!(expiry);
                    let r = self.0.ledger.reserve(tx, input, operation).await?;
                    expires = expires.min(n(&r, "expiresAt")?);
                    reservations.push(json!({"feature":feature,"reservationId":r["id"]}));
                }
                step["reservations"] = json!(reservations);
                all.push(step);
            }
            for step in &all {
                for reference in arr(step, "reservations")? {
                    let id = s(reference, "reservationId")?;
                    let mut r = get(tx, Table::Reservations, id).await?.unwrap();
                    r["expiresAt"] = json!(expires);
                    put(tx, Table::Reservations, id, r, "held").await?;
                }
            }
            let mut w = json!({"id":id,"status":"active","revision":0,"createdAt":self.now(),"expiresAt":expires,"steps":all});
            copy_optional(&mut w, p, "entityId");
            self.workflow_schedule(tx, id, expires, None).await?;
            return self
                .workflow_save(tx, customer, w, "workflow.created")
                .await;
        }
        let mut w = self.workflow_load(tx, p).await?;
        if method == "workflows.claim" {
            identifier(s(p, "workerId")?)?;
            require(
                opt(&w, "status") == Some("active") && w["cancellationRequested"] != true,
                "workflow_not_active",
            )?;
            let mut all = steps(&w)?;
            let mut expired = false;
            for step in &mut all {
                if opt(step, "status") == Some("running")
                    && n(&step["lease"], "until")? <= self.now()
                {
                    step["status"] = json!("reconciliation");
                    step["error"] = json!("workflow_worker_timeout");
                    expired = true;
                }
            }
            if expired {
                w["steps"] = json!(all);
                self.workflow_refresh(tx, &mut w).await?;
                self.workflow_save(tx, customer, w, "workflow.timeout")
                    .await?;
                return Ok(json!({"claimed":false}));
            }
            require(n(&w, "expiresAt")? > self.now(), "workflow_expired")?;
            let ms = bounded(p, "leaseMs", 60000, 1000, 15 * 60000, "invalid_lease")?;
            if all.iter().any(|s| opt(s, "status") == Some("failed")) {
                return Ok(json!({"claimed":false}));
            }
            let selected = all.iter().position(|step| {
                opt(p, "stepId").is_none_or(|id| opt(step, "id") == Some(id))
                    && opt(step, "status") == Some("pending")
                    && step["availableAt"]
                        .as_i64()
                        .is_some_and(|v| v <= self.now())
                    && step["dependsOn"].as_array().is_none_or(|deps| {
                        deps.iter().all(|id| {
                            all.iter()
                                .any(|s| s["id"] == *id && opt(s, "status") == Some("succeeded"))
                        })
                    })
            });
            let Some(selected) = selected else {
                return Ok(json!({"claimed":false}));
            };
            self.0.ledger.materialize(tx).await?;
            let step = &mut all[selected];
            require(
                self.workflow_holds(tx, step).await?,
                "workflow_funding_expired",
            )?;
            step["attempts"] = json!(n(step, "attempts")? + 1);
            step["status"] = json!("running");
            let token = self.id();
            let until = (self.now() + ms).min(n(&w, "expiresAt")?);
            step["lease"] = json!({"token":token,"workerId":p["workerId"],"until":until});
            let result = step.clone();
            self.workflow_schedule(tx, s(&w, "id")?, until, Some(&token))
                .await?;
            w["steps"] = json!(all);
            self.workflow_save(tx, customer, w.clone(), "workflow.claimed")
                .await?;
            return Ok(json!({"claimed":true,"workflowId":w["id"],"step":result}));
        }
        if method == "workflows.cancel" {
            require(!s(p, "reason")?.trim().is_empty(), "reason_required")?;
            require(
                matches!(opt(&w, "status"), Some("active" | "reconciliation")),
                "workflow_terminal",
            )?;
            w["cancellationRequested"] = json!(true);
            let mut all = steps(&w)?;
            for step in &mut all {
                if opt(step, "status") == Some("pending") {
                    self.workflow_release(tx, step).await?;
                    step["status"] = json!("cancelled");
                } else if opt(step, "status") == Some("running") {
                    step["status"] = json!("reconciliation");
                    step["error"] = json!("workflow_cancelled_inflight");
                }
            }
            w["status"] = json!(if all
                .iter()
                .any(|s| opt(s, "status") == Some("reconciliation"))
            {
                "reconciliation"
            } else {
                "cancelled"
            });
            w["steps"] = json!(all);
            self.event(
                tx,
                customer,
                "workflow.cancellation",
                json!({"workflowId":w["id"],"reason":p["reason"]}),
            )
            .await?;
            return self
                .workflow_save(tx, customer, w, "workflow.cancelled")
                .await;
        }
        let i = index(&w, s(p, "stepId")?)?;
        let mut all = steps(&w)?;
        let mut step = all[i].clone();
        let kind;
        match method {
            "workflows.heartbeat" => {
                self.workflow_lease(&step, s(p, "token")?)?;
                let ms = bounded(p, "leaseMs", 60000, 1000, 15 * 60000, "invalid_lease")?;
                require(n(&w, "expiresAt")? > self.now(), "workflow_expired")?;
                let until = (self.now() + ms).min(n(&w, "expiresAt")?);
                step["lease"]["until"] = json!(until);
                self.workflow_schedule(tx, s(&w, "id")?, until, opt(p, "token"))
                    .await?;
                kind = "workflow.heartbeat";
            }
            "workflows.complete" => {
                require(
                    opt(&step["lease"], "token") == opt(p, "token")
                        && opt(p, "token").is_some()
                        && matches!(opt(&step, "status"), Some("running" | "reconciliation")),
                    "workflow_lease_lost",
                )?;
                actuals(&step, &p["actuals"])?;
                self.0.ledger.materialize(tx).await?;
                if opt(&step, "status") == Some("reconciliation")
                    || n(&step["lease"], "until")? <= self.now()
                {
                    step["status"] = json!("reconciliation");
                    if step.get("error").is_none() {
                        step["error"] = json!("workflow_lease_expired");
                    }
                    step["reportedActuals"] = p["actuals"].clone();
                    self.event(
                        tx,
                        customer,
                        "workflow.late_completion",
                        json!({"workflowId":w["id"],"stepId":step["id"],"actuals":p["actuals"]}),
                    )
                    .await?;
                } else if self
                    .workflow_settle(tx, p, &mut step, &p["actuals"], operation, false)
                    .await?
                {
                    step["status"] = json!("succeeded");
                }
                kind = "workflow.completed";
            }
            "workflows.fail" => {
                self.workflow_lease(&step, s(p, "token")?)?;
                identifier(s(p, "code")?)?;
                let delay = bounded(
                    p,
                    "retryAfterMs",
                    (1000_i64.saturating_mul(2_i64.saturating_pow(n(&step, "attempts")? as u32)))
                        .min(3600000),
                    0,
                    86400000,
                    "invalid_retry_delay",
                )?;
                step["error"] = p["code"].clone();
                step.as_object_mut().unwrap().remove("lease");
                if p["retrySafe"] == true && n(&step, "attempts")? < n(&step, "maxAttempts")? {
                    step["status"] = json!("pending");
                    step["availableAt"] = json!(self.now() + delay);
                } else {
                    step["status"] = json!("reconciliation");
                }
                kind = "workflow.failed";
            }
            "workflows.resolve" => {
                require(!s(p, "reason")?.trim().is_empty(), "reason_required")?;
                require(
                    opt(&step, "status") == Some("reconciliation"),
                    "workflow_not_in_reconciliation",
                )?;
                self.0.ledger.materialize(tx).await?;
                if opt(p, "outcome") == Some("retry") {
                    require(
                        w["cancellationRequested"] != true,
                        "workflow_cancel_requested",
                    )?;
                    require(
                        n(&step, "attempts")? < n(&step, "maxAttempts")?,
                        "workflow_attempts_exhausted",
                    )?;
                    require(
                        n(&w, "expiresAt")? > self.now() && self.workflow_holds(tx, &step).await?,
                        "workflow_funding_expired",
                    )?;
                    step["status"] = json!("pending");
                    step["availableAt"] = json!(self.now());
                    step.as_object_mut().unwrap().remove("lease");
                } else {
                    require(
                        matches!(opt(p, "outcome"), Some("succeeded" | "failed")),
                        "invalid_workflow_outcome",
                    )?;
                    require(p.get("actuals").is_some(), "workflow_actuals_required")?;
                    if self
                        .workflow_settle(
                            tx,
                            p,
                            &mut step,
                            &p["actuals"],
                            operation,
                            p["fundUncovered"] == true,
                        )
                        .await?
                    {
                        step["status"] = p["outcome"].clone();
                    }
                }
                self.event(tx,customer,"workflow.resolution",json!({"workflowId":w["id"],"stepId":step["id"],"reason":p["reason"],"outcome":p["outcome"],"status":step["status"]})).await?;
                kind = "workflow.resolved";
            }
            "workflows.increase" => {
                require(!s(p, "reason")?.trim().is_empty(), "reason_required")?;
                require(
                    opt(&w, "status") == Some("active") && w["cancellationRequested"] != true,
                    "workflow_not_active",
                )?;
                require(
                    matches!(opt(&step, "status"), Some("pending" | "running")),
                    "workflow_step_not_active",
                )?;
                if opt(&step, "status") == Some("running") {
                    self.workflow_lease(&step, opt(p, "token").unwrap_or(""))?;
                }
                self.0.ledger.materialize(tx).await?;
                let feature = s(p, "feature")?;
                let budget = arr(&step, "budgets")?
                    .iter()
                    .position(|b| opt(b, "feature") == Some(feature))
                    .ok_or_else(|| BillingError::new("workflow_budget_not_found"))?;
                let reference = arr(&step, "reservations")?
                    .iter()
                    .find(|r| opt(r, "feature") == Some(feature))
                    .ok_or_else(|| BillingError::new("workflow_budget_not_found"))?;
                let r = tx
                    .get(Table::Reservations, s(reference, "reservationId")?)
                    .await?
                    .ok_or_else(|| BillingError::new("reservation_not_held"))?;
                require(r.state == "held", "reservation_not_held")?;
                let increased = self
                    .0
                    .ledger
                    .increase_reservation(tx, &r.data, s(p, "amount")?, operation)
                    .await?;
                step["budgets"][budget]["amount"] = json!(d(amount(
                    &step["budgets"][budget],
                    "amount"
                )? + positive(s(p, "amount")?)?)?);
                if n(&increased, "expiresAt")? < n(&w, "expiresAt")? {
                    let expiry = n(&increased, "expiresAt")?;
                    w["expiresAt"] = json!(expiry);
                    all[i] = step.clone();
                    for entry in &mut all {
                        if entry.get("lease").is_some() {
                            entry["lease"]["until"] =
                                json!(n(&entry["lease"], "until")?.min(expiry));
                        }
                        for r in arr(entry, "reservations")? {
                            if let Some(mut held) =
                                tx.get(Table::Reservations, s(r, "reservationId")?).await?
                                && held.state == "held"
                            {
                                held.data["expiresAt"] = json!(expiry);
                                put(tx, Table::Reservations, &held.id, held.data, "held").await?;
                            }
                        }
                    }
                    step = all[i].clone();
                    self.workflow_schedule(tx, s(&w, "id")?, expiry, None)
                        .await?;
                }
                self.event(tx,customer,"workflow.budget_increased",json!({"workflowId":w["id"],"stepId":step["id"],"feature":feature,"amount":p["amount"],"reason":p["reason"]})).await?;
                kind = "workflow.updated";
            }
            _ => return Err(BillingError::new("unknown_method")),
        }
        all[i] = step;
        w["steps"] = json!(all);
        if !matches!(method, "workflows.heartbeat" | "workflows.increase") {
            self.workflow_refresh(tx, &mut w).await?;
        }
        self.workflow_save(tx, customer, w, kind).await
    }
    pub(crate) async fn workflow_timeout(
        &self,
        tx: &mut dyn Transaction,
        customer: &str,
        id: &str,
        token: Option<&str>,
    ) -> Result<()> {
        let Some(row) = tx.get(Table::Workflows, id).await? else {
            return Ok(());
        };
        if !matches!(row.state.as_str(), "active" | "reconciliation") {
            return Ok(());
        }
        let mut w = row.data;
        let mut all = steps(&w)?;
        let mut changed = false;
        for step in &mut all {
            if opt(step, "status") == Some("running")
                && step.get("lease").is_some()
                && n(&step["lease"], "until")? <= self.now()
                && token.is_none_or(|t| opt(&step["lease"], "token") == Some(t))
            {
                step["status"] = json!("reconciliation");
                step["error"] = json!("workflow_worker_timeout");
                changed = true;
            }
            if n(&w, "expiresAt")? <= self.now() && opt(step, "status") == Some("pending") {
                w["cancellationRequested"] = json!(true);
                self.workflow_release(tx, step).await?;
                step["status"] = json!("cancelled");
                changed = true;
            }
        }
        if changed {
            w["steps"] = json!(all);
            self.workflow_refresh(tx, &mut w).await?;
            if n(&w, "expiresAt")? <= self.now() && opt(&w, "status") == Some("active") {
                w["status"] = json!("cancelled");
            }
            self.workflow_save(tx, customer, w, "workflow.timeout")
                .await?;
        }
        Ok(())
    }
}
