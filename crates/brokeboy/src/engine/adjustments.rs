//! Cumulative purchase reversals and their append-only ledger compensation.
use super::*;
use brokeboy_core::compatibility::hash_v1;

impl Billing {
    pub(crate) async fn prepaid_event(
        &self,
        tx: &mut dyn Transaction,
        event: &crate::provider::ProviderEvent,
    ) -> Result<()> {
        let data = &event.data;
        let feature = identifier(s(data, "feature")?)?;
        let cents = n(data, "creditCents")?;
        require(
            (0..=9_007_199_254_740_991).contains(&cents),
            "invalid_amount",
        )?;
        let imported = event.kind == "prepaid.imported";
        let source = if imported {
            format!("stripe-opening:{}", s(data, "providerCustomerId")?)
        } else {
            s(data, "purchaseId")?.to_owned()
        };
        if !imported {
            let intent = get(tx, Table::Counters, &format!("prepaid-intent:{source}"))
                .await?
                .ok_or_else(|| BillingError::new("purchase_intent_missing"))?;
            require(
                intent["feature"] == feature && intent["amountCents"] == cents,
                "purchase_conflict",
            )?;
        }
        let marker = format!("prepaid-grant:{}", hash_v1(&json!(source))?);
        if let Some(old) = get(tx, Table::Counters, &marker).await? {
            return require(
                old["creditCents"] == cents && old["feature"] == feature,
                "opening_balance_conflict",
            );
        }
        if cents > 0 {
            let grant = json!({"id":hash_v1(&json!({"prepaid":source}))?,"feature":feature,"amount":d(i128::from(cents)*10_000)?,"priority":0,"origin":if imported{"migration"}else{"purchase"},"sourceId":source,"createdAt":self.now()});
            self.0.ledger.grant(tx, grant).await?;
        }
        let mut record =
            json!({"creditCents":cents,"feature":feature,"sourceId":source,"createdAt":self.now()});
        copy_optional(&mut record, data, "sourceTransactionId");
        put(tx, Table::Counters, &marker, record, "active").await?;
        Ok(())
    }
    pub(crate) async fn purchase_adjustment(
        &self,
        tx: &mut dyn Transaction,
        event: &crate::provider::ProviderEvent,
    ) -> Result<()> {
        let data = &event.data;
        let purchase = s(data, "purchaseId")?;
        let paid = n(data, "paidMinor")?;
        let refunded = n(data, "refundedMinor")?;
        require(
            (1..=9_007_199_254_740_991).contains(&paid) && (0..=paid).contains(&refunded),
            "invalid_payment_adjustment",
        )?;
        let counter = format!("purchase-adjustment:{}", hash_v1(&json!(purchase))?);
        let mut state = get(tx, Table::Counters, &counter)
            .await?
            .unwrap_or(json!({"paidMinor":paid,"disputes":{},"clawed":{}}));
        require(n(&state, "paidMinor")? == paid, "purchase_amount_conflict")?;
        if let Some(dispute) = data.get("dispute") {
            let id = s(dispute, "id")?;
            identifier(id)?;
            let value = n(dispute, "amount")?;
            require(value > 0 && value <= paid, "invalid_dispute_amount")?;
            let old = &state["disputes"][id];
            require(
                old.is_null() || n(old, "amount")? == value,
                "dispute_amount_conflict",
            )?;
            // A terminal reinstatement wins even when delivered before withdrawal.
            let restored = old["reinstated"] == true || dispute["reinstated"] == true;
            state["disputes"][id] = json!({"amount":value,"reinstated":restored});
        }
        let mut disputed = 0_i128;
        for dispute in state["disputes"]
            .as_object()
            .ok_or_else(|| BillingError::new("unsupported_record"))?
            .values()
        {
            if dispute["reinstated"] != true {
                disputed += i128::from(n(dispute, "amount")?);
            }
        }
        let total_reversed = i128::from(refunded) + disputed;
        let reversed = total_reversed.min(i128::from(paid));
        let excess_id = format!("purchase-excess:{}", hash_v1(&json!(purchase))?);
        if total_reversed > i128::from(paid) {
            self.enqueue(
                tx,
                &excess_id,
                "payment_adjustment",
                json!({"purchaseId":purchase}),
            )
            .await?;
            let mut case = get(tx, Table::Work, &excess_id).await?.unwrap();
            case["status"] = json!("reconciliation");
            case["payload"]["uncoveredMinor"] =
                json!((total_reversed - i128::from(paid)).to_string());
            case["payload"]["providerEventId"] = json!(event.id);
            put(tx, Table::Work, &excess_id, case, "reconciliation").await?;
        } else if let Some(mut case) = get(tx, Table::Work, &excess_id).await? {
            case["status"] = json!("done");
            case["result"] = json!({"uncoveredMinor":"0","providerEventId":event.id});
            put(tx, Table::Work, &excess_id, case, "done").await?;
        }
        let mut found = false;
        for mut subscription in list(tx, Table::Subscriptions, None).await? {
            if opt(&subscription, "purchaseId") == Some(purchase) {
                found = true;
                if reversed == i128::from(paid) {
                    subscription["status"] = json!("ended");
                    subscription["financialReversal"] = json!(true);
                    put(
                        tx,
                        Table::Subscriptions,
                        s(&subscription, "id")?,
                        subscription.clone(),
                        "ended",
                    )
                    .await?;
                } else if subscription["financialReversal"] == true {
                    subscription["status"] = json!("active");
                    subscription["financialReversal"] = json!(false);
                    put(
                        tx,
                        Table::Subscriptions,
                        s(&subscription, "id")?,
                        subscription.clone(),
                        "active",
                    )
                    .await?;
                }
            }
        }
        for row in tx.list(Table::Grants, None).await? {
            let grant = &row.data;
            if opt(grant, "sourceId") != Some(purchase) || opt(grant, "origin") != Some("purchase")
            {
                continue;
            }
            found = true;
            let id = s(grant, "id")?;
            // Six-place fixed units, proportional to the authoritative monetary amount.
            let target = amount(grant, "amount")?
                .checked_mul(reversed)
                .ok_or_else(|| BillingError::new("amount_overflow"))?
                / i128::from(paid);
            let previous = state["clawed"][id]
                .as_str()
                .map(u)
                .transpose()?
                .unwrap_or(0);
            let position = self.0.ledger.position(tx, id).await?;
            let available = (amount(grant, "amount")?
                - amount(&position, "spent")?
                - amount(&position, "held")?)
            .max(0);
            let delta = if target >= previous {
                (target - previous).min(available)
            } else {
                target - previous
            };
            if delta != 0 {
                self.0
                    .ledger
                    .movement(tx, id, delta, &event.id, "purchase_adjustment", None)
                    .await?;
            }
            let applied = previous + delta;
            state["clawed"][id] = json!(d(applied)?);
            let shortfall = target - applied;
            let case_id = format!(
                "purchase-shortfall:{}",
                hash_v1(&json!({"purchase":purchase,"grant":id}))?
            );
            if shortfall > 0 {
                self.enqueue(
                    tx,
                    &case_id,
                    "payment_adjustment",
                    json!({"purchaseId":purchase,"grantId":id}),
                )
                .await?;
                let mut case = get(tx, Table::Work, &case_id).await?.unwrap();
                case["status"] = json!("reconciliation");
                case["payload"]["shortfall"] = json!(d(shortfall)?);
                case["payload"]["target"] = json!(d(target)?);
                case["payload"]["providerEventId"] = json!(event.id);
                put(tx, Table::Work, &case_id, case, "reconciliation").await?;
            } else if let Some(mut case) = get(tx, Table::Work, &case_id).await? {
                case["status"] = json!("done");
                case["result"] = json!({"shortfall":"0","providerEventId":event.id});
                put(tx, Table::Work, &case_id, case, "done").await?;
            }
        }
        // Refund can arrive before purchase confirmation. Retry after it is materialized.
        require(found, "purchase_not_materialized")?;
        state["refundedMinor"] = json!(refunded);
        state["updatedAt"] = json!(self.now());
        put(tx, Table::Counters, &counter, state, "active").await?;
        Ok(())
    }
}
