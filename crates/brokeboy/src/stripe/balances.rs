//! Remove opening credit at its old source before materializing a local grant.
use super::*;
impl Stripe {
    pub(super) async fn import_customer_balance(
        &self,
        command: &PaymentCommand,
        customer: &str,
    ) -> Result<Value> {
        let p = &command.input;
        let current = self.get(&path("customers", customer)?, json!({})).await?;
        self.live(&current)?;
        require(
            current["id"] == customer && current["deleted"] != true,
            "customer_mapping_conflict",
        )?;
        require(
            current["currency"].is_null() || current["currency"] == "usd",
            "currency_mismatch",
        )?;
        let balance = n(&current, "balance")?;
        require(
            (-9_007_199_254_740_991..=0).contains(&balance),
            "migration_stripe_debit_balance",
        )?;
        if p["dryRun"] != false {
            return Ok(json!({"dryRun":true,"creditCents":-balance,"currency":"usd"}));
        }
        require(
            p["externalSpendingDisabled"] == true,
            "external_spending_must_be_disabled",
        )?;
        let expected = n(p, "expectedCreditCents")?;
        require(
            (0..=9_007_199_254_740_991).contains(&expected),
            "invalid_amount",
        )?;
        let identity = hash_v1(
            &json!({"environment":self.0.options.environment.name(),"customer":customer,"kind":"opening-balance-v1"}),
        )?;
        let mut cursor = None;
        let mut seen = std::collections::BTreeSet::new();
        let mut existing = None;
        loop {
            let mut params = json!({"limit":100});
            if let Some(cursor) = &cursor {
                params["starting_after"] = json!(cursor);
            }
            let page = self
                .get(
                    &format!("{}/balance_transactions", path("customers", customer)?),
                    params,
                )
                .await?;
            let rows = arr(&page, "data")?;
            for transaction in rows {
                require(
                    seen.insert(s(transaction, "id")?.to_owned()) && seen.len() <= 10000,
                    "reconciliation_required",
                )?;
                if opt(&transaction["metadata"], "brokeboy_opening_balance")
                    == Some(identity.as_str())
                {
                    require(existing.is_none(), "reconciliation_required")?;
                    existing = Some(transaction.clone());
                }
            }
            if page["has_more"] == false {
                break;
            }
            require(page["has_more"] == true, "invalid_provider_event")?;
            cursor = Some(
                s(
                    rows.last()
                        .ok_or_else(|| BillingError::new("invalid_provider_event"))?,
                    "id",
                )?
                .to_owned(),
            );
        }
        let transaction = if let Some(existing) = existing {
            existing
        } else {
            require(-balance == expected, "external_balance_changed")?;
            if expected == 0 {
                json!({"amount":0,"ending_balance":0,"currency":"usd","id":format!("empty_{identity}")})
            } else {
                self.post(&format!("{}/balance_transactions",path("customers",customer)?),json!({"amount":expected,"currency":"usd","description":"Opening credit transferred to application ledger","metadata":{"brokeboy_opening_balance":identity}}),&format!("bb:opening:{identity}")).await?
            }
        };
        // An invoice or legacy writer racing the cutover must not create two spendable balances.
        require(
            transaction["amount"] == expected
                && transaction["ending_balance"] == 0
                && transaction["currency"] == "usd",
            "reconciliation_required",
        )?;
        let event = ProviderEvent {
            id: format!("balance-import:{}", command.id),
            kind: "prepaid.imported".into(),
            customer_id: s(&command.customer, "id")?.into(),
            data: json!({"providerCustomerId":customer,"creditCents":expected,"feature":p["feature"],"sourceTransactionId":transaction["id"]}),
            extra: Default::default(),
        };
        Ok(
            json!({"creditCents":expected,"currency":"usd","sourceTransactionId":transaction["id"],"providerEvent":event}),
        )
    }
}
