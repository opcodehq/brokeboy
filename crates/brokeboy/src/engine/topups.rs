//! Purchase admission is checked again after queued payment notifications settle.
use super::*;
impl Billing {
    pub(crate) async fn refresh_topup_customer(
        &self,
        scope: &str,
        customer: &str,
        id: &str,
        owner: &str,
        input: &Value,
    ) -> Result<()> {
        let provider = self
            .0
            .options
            .provider
            .as_ref()
            .ok_or_else(|| BillingError::new("provider_missing"))?;
        let processor = opt(input, "provider").unwrap_or(provider.provider_id());
        if !provider.supports_customer_refresh(processor) {
            return Ok(());
        }
        let this = self.clone();
        let customer = customer.to_owned();
        let processor = processor.to_owned();
        let snapshot=self.atomic(scope,move|tx|Box::pin(async move {
            let customer=this.customer(tx,&customer).await?;
            let feature=opt(&customer["controls"]["autoTopUp"],"feature");
            let mut subscriptions=Vec::new();
            for sub in list(tx,Table::Subscriptions,None).await? {
                if opt(&sub,"status")==Some("ended") || opt(&sub,"provider").unwrap_or("stripe")!=processor {continue;}
                if !arr(&sub["plan"],"items")?.iter().any(|item|opt(item,"pool").or_else(||opt(item,"feature"))==feature){continue;}
                if let Some(id)=opt(&sub,"providerSubscriptionId").or_else(||opt(&sub,"stripeSubscriptionId")){subscriptions.push(json!({"id":id}));}
            }
            Ok(json!({"customer":customer,"subscriptions":subscriptions,"provider":processor}))
        })).await?;
        if snapshot["subscriptions"]
            .as_array()
            .is_some_and(Vec::is_empty)
        {
            return Ok(());
        }
        let refreshed=provider.execute(crate::provider::PaymentCommand{id:self.provider_identity(scope,&format!("refresh:{id}"))?,kind:"customer_refresh".into(),customer:snapshot["customer"].clone(),input:json!({"subscriptions":snapshot["subscriptions"],"provider":snapshot["provider"]}),resources:self.0.resources.clone()}).await?;
        for raw in arr(&refreshed, "providerEvents")? {
            let event = serde_json::from_value(raw.clone())
                .map_err(|_| BillingError::new("invalid_provider_event"))?;
            self.apply_provider_event(scope, event, id, owner).await?;
        }
        Ok(())
    }
    pub(crate) async fn topup_ready(
        &self,
        scope: &str,
        customer: &str,
        id: &str,
        owner: &str,
    ) -> Result<bool> {
        let this = self.clone();
        let customer = customer.to_owned();
        let id = id.to_owned();
        let owner = owner.to_owned();
        let decision = self
            .atomic(scope, move |tx| {
                Box::pin(async move {
                    let mut work = get(tx, Table::Work, &id)
                        .await?
                        .ok_or_else(|| BillingError::new("operation_not_found"))?;
                    require(
                        opt(&work, "leaseOwner") == Some(owner.as_str()),
                        "lease_lost",
                    )?;
                    if opt(&work, "providerDecision") == Some("skip") {
                        return Ok(json!(false));
                    }
                    // Preserve ambiguous prior attempts, including jobs authored by the maintenance line.
                    if opt(&work, "providerDecision") == Some("started")
                        || (n(&work, "attempts")? > 1 && work["payload"]["admissionVersion"] != 1)
                    {
                        return Ok(json!(true));
                    }
                    for candidate in list(tx, Table::Work, None).await? {
                        require(
                            !(opt(&candidate, "kind") == Some("webhook")
                                && opt(&candidate, "status") != Some("done")),
                            "provider_sync_pending",
                        )?;
                    }
                    this.0.ledger.materialize(tx).await?;
                    let customer = this.customer(tx, &customer).await?;
                    let controls = &customer["controls"]["autoTopUp"];
                    let needed = if controls.is_object()
                        && controls["packPlan"] == work["payload"]["planId"]
                    {
                        let balance = this.balance_for(tx, s(controls, "feature")?, None).await?;
                        amount(&balance, "available")? < amount(controls, "below")?
                    } else {
                        false
                    };
                    work["providerDecision"] = json!(if needed { "started" } else { "skip" });
                    put(tx, Table::Work, &id, work.clone(), "processing").await?;
                    if !needed {
                        let counter = s(&work["payload"], "counter")?;
                        if let Some(old) = get(tx, Table::Counters, counter).await?
                            && opt(&old, "pending") == Some(id.as_str())
                        {
                            require(n(&old, "count")? > 0, "invalid_record")?;
                            put(
                                tx,
                                Table::Counters,
                                counter,
                                json!({"count":n(&old,"count")?-1}),
                                "active",
                            )
                            .await?;
                        }
                        if get(tx, Table::Counters, "topup-pending")
                            .await?
                            .as_ref()
                            .and_then(|v| opt(v, "operationId"))
                            == Some(id.as_str())
                        {
                            put(tx, Table::Counters, "topup-pending", json!({}), "active").await?;
                        }
                    }
                    Ok(json!(needed))
                })
            })
            .await?;
        Ok(decision == true)
    }
}
