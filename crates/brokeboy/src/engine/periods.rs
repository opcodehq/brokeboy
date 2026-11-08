//! Additive period records in the existing durable counter namespace.
use super::*;
use brokeboy_core::{
    error::timestamp,
    periods::{CostPolicy, MAX, PeriodStatus},
};

fn policy(p: &Value) -> Result<CostPolicy> {
    let policy: CostPolicy = serde_json::from_value(p.clone())
        .map_err(|_| BillingError::new("invalid_period_policy"))?;
    policy.validate()?;
    Ok(policy)
}
fn checked(value: i128) -> Result<i64> {
    require(
        (0..=i128::from(MAX)).contains(&value),
        "period_amount_overflow",
    )?;
    Ok(value as i64)
}
impl Billing {
    async fn period_record(&self, tx: &mut dyn Transaction, input: &Value) -> Result<Value> {
        get(
            tx,
            Table::Counters,
            &format!("period:{}", identifier(s(input, "periodId")?)?),
        )
        .await?
        .ok_or_else(|| BillingError::new("period_not_found"))
    }
    async fn live_period_holds(&self, tx: &mut dyn Transaction, period: &str) -> Result<i64> {
        let mut held = 0_i128;
        for row in tx.list(Table::Counters, Some("held")).await? {
            if row.id.starts_with("period-hold:")
                && opt(&row.data, "periodId") == Some(period)
                && n(&row.data, "expiresAt")? > self.now()
            {
                held += i128::from(n(&row.data, "cost")?);
            }
        }
        checked(held)
    }
    pub(crate) async fn period_read(
        &self,
        tx: &mut dyn Transaction,
        method: &str,
        p: &Value,
    ) -> Result<Value> {
        self.customer(tx, s(p, "customerId")?).await?;
        let period = self.period_record(tx, p).await?;
        let held = self.live_period_holds(tx, s(p, "periodId")?).await?;
        if method == "periods.get" {
            let mut result = period;
            result["reserved"] = json!(held);
            return Ok(result);
        }
        let active = n(&period, "start")? <= self.now() && self.now() < n(&period, "end")?;
        let blocked = !active
            || policy(&period)?.held(n(&period, "confirmed")?, n(&period, "charged")?, held)?;
        Ok(json!({"allowed":!blocked,"reserved":held,"periodId":p["periodId"]}))
    }
    pub(crate) async fn period_action(
        &self,
        tx: &mut dyn Transaction,
        method: &str,
        p: &Value,
        key: &str,
    ) -> Result<Value> {
        let id = identifier(s(p, "periodId")?)?;
        let record_key = format!("period:{id}");
        if method == "periods.create" {
            require(
                get(tx, Table::Counters, &record_key).await?.is_none(),
                "period_exists",
            )?;
            policy(p)?;
            let start = timestamp(n(p, "start")?)?;
            let end = timestamp(n(p, "end")?)?;
            require(end > start, "invalid_period")?;
            let currency = s(p, "currency")?;
            require(
                currency.len() == 3 && currency.bytes().all(|b| b.is_ascii_lowercase()),
                "invalid_currency",
            )?;
            for row in tx.list(Table::Counters, Some("period")).await? {
                if row.id.starts_with("period:") {
                    require(
                        end <= n(&row.data, "start")? || start >= n(&row.data, "end")?,
                        "overlapping_period",
                    )?;
                }
            }
            let mut period = p.clone();
            period["confirmed"] = json!(0);
            period["charged"] = json!(0);
            put(tx, Table::Counters, &record_key, period.clone(), "period").await?;
            return Ok(period);
        }
        let mut period = self.period_record(tx, p).await?;
        match method {
            "periods.setStatus" => {
                require(!s(p, "reason")?.trim().is_empty(), "reason_required")?;
                let _: PeriodStatus = serde_json::from_value(p["status"].clone())
                    .map_err(|_| BillingError::new("invalid_period_policy"))?;
                period["status"] = p["status"].clone();
            }
            "periods.reserve" => {
                let cost = n(p, "cost")?;
                require((1..=MAX).contains(&cost), "invalid_period_amount")?;
                let expiry = timestamp(n(p, "expiresAt")?)?;
                require(
                    expiry > self.now() && expiry <= n(&period, "end")?,
                    "invalid_expiry",
                )?;
                require(
                    n(&period, "start")? <= self.now() && self.now() < n(&period, "end")?,
                    "period_inactive",
                )?;
                let live = self.live_period_holds(tx, id).await?;
                let total = checked(i128::from(live) + i128::from(cost))?;
                require(
                    !policy(&period)?.held(
                        n(&period, "confirmed")?,
                        n(&period, "charged")?,
                        total,
                    )?,
                    "billing_hold",
                )?;
                let hold_key = format!("period-hold:{}", identifier(s(p, "reservationId")?)?);
                require(
                    get(tx, Table::Counters, &hold_key).await?.is_none(),
                    "reservation_exists",
                )?;
                let mut hold = p.clone();
                hold["status"] = json!("held");
                put(tx, Table::Counters, &hold_key, hold.clone(), "held").await?;
                return Ok(hold);
            }
            "periods.release" => {
                let hold_key = format!("period-hold:{}", identifier(s(p, "reservationId")?)?);
                let mut hold = get(tx, Table::Counters, &hold_key)
                    .await?
                    .ok_or_else(|| BillingError::new("reservation_not_found"))?;
                require(hold["periodId"] == p["periodId"], "period_mismatch")?;
                if hold["status"] == "settled" {
                    return Err(BillingError::new("reservation_settled"));
                }
                hold["status"] = json!("released");
                put(tx, Table::Counters, &hold_key, hold.clone(), "released").await?;
                return Ok(hold);
            }
            "periods.settle" => {
                let source = identifier(s(p, "sourceId")?)?;
                let receipt_key = format!("period-settlement:{id}:{source}");
                if let Some(old) = get(tx, Table::Counters, &receipt_key).await? {
                    require(
                        old["cost"] == p["cost"] && old["reservationId"] == p["reservationId"],
                        "settlement_conflict",
                    )?;
                    return Ok(old);
                }
                let cost = n(p, "cost")?;
                let delta = policy(&period)?.settlement(
                    n(&period, "confirmed")?,
                    n(&period, "charged")?,
                    cost,
                )?;
                period["confirmed"] = json!(checked(
                    i128::from(n(&period, "confirmed")?) + i128::from(cost)
                )?);
                period["charged"] = json!(checked(
                    i128::from(n(&period, "charged")?) + i128::from(delta)
                )?);
                if let Some(hold_id) = opt(p, "reservationId") {
                    let hold_key = format!("period-hold:{}", identifier(hold_id)?);
                    let mut hold = get(tx, Table::Counters, &hold_key)
                        .await?
                        .ok_or_else(|| BillingError::new("reservation_not_found"))?;
                    require(
                        hold["periodId"] == p["periodId"] && hold["status"] == "held",
                        "reservation_not_held",
                    )?;
                    hold["status"] = json!("settled");
                    put(tx, Table::Counters, &hold_key, hold, "settled").await?;
                }
                let receipt = json!({"periodId":id,"sourceId":source,"cost":cost,"charge":delta,"currency":period["currency"],"reservationId":p.get("reservationId"),"createdAt":self.now(),"operation":key});
                put(
                    tx,
                    Table::Counters,
                    &receipt_key,
                    receipt.clone(),
                    "settled",
                )
                .await?;
                put(tx, Table::Counters, &record_key, period, "period").await?;
                self.event(tx, s(p, "customerId")?, "period.settled", receipt.clone())
                    .await?;
                return Ok(receipt);
            }
            _ => return Err(BillingError::new("unknown_method")),
        }
        put(tx, Table::Counters, &record_key, period.clone(), "period").await?;
        self.event(tx, s(p, "customerId")?, method, p.clone())
            .await?;
        Ok(period)
    }
}
