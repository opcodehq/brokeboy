use super::*;
use hmac::{Hmac, Mac};
use sha2::Sha256;

fn millis(value: i64) -> Result<i64> {
    let ms = value
        .checked_mul(1000)
        .ok_or_else(|| BillingError::new("invalid_provider_event"))?;
    require(
        (0..=9_007_199_254_740_991).contains(&ms),
        "invalid_provider_event",
    )?;
    Ok(ms)
}
impl Stripe {
    pub(super) async fn verify_event(
        &self,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> Result<Option<ProviderEvent>> {
        let signature = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("stripe-signature"))
            .map(|(_, v)| v)
            .ok_or_else(|| BillingError::new("invalid_signature"))?;
        let mut timestamp = None;
        let mut signatures = Vec::new();
        for part in signature.split(',') {
            if let Some((key, value)) = part.split_once('=') {
                if key == "t" {
                    require(timestamp.is_none(), "invalid_signature")?;
                    timestamp = Some(
                        value
                            .parse::<i64>()
                            .map_err(|_| BillingError::new("invalid_signature"))?,
                    );
                } else if key == "v1" {
                    signatures.push(value);
                }
            }
        }
        let at = timestamp.ok_or_else(|| BillingError::new("invalid_signature"))?;
        require(
            (i128::from(self.0.options.clock.now() / 1000) - i128::from(at)).abs() <= 300,
            "invalid_signature",
        )?;
        require(
            !self.0.options.webhook_secret.is_empty(),
            "invalid_signature",
        )?;
        let mut mac = Hmac::<Sha256>::new_from_slice(self.0.options.webhook_secret.as_bytes())
            .map_err(|_| BillingError::new("invalid_signature"))?;
        mac.update(format!("{at}.").as_bytes());
        mac.update(&body);
        require(
            signatures.iter().any(|v| {
                hex::decode(v)
                    .ok()
                    .is_some_and(|bytes| mac.clone().verify_slice(&bytes).is_ok())
            }),
            "invalid_signature",
        )?;
        let event: Value = serde_json::from_slice(&body)
            .map_err(|_| BillingError::new("invalid_provider_event"))?;
        self.live(&event)?;
        let kind = s(&event, "type")?;
        if !matches!(
            kind,
            "customer.subscription.created"
                | "customer.subscription.updated"
                | "customer.subscription.deleted"
                | "customer.subscription.paused"
                | "customer.subscription.resumed"
                | "invoice.paid"
                | "invoice.payment_failed"
                | "checkout.session.completed"
                | "checkout.session.async_payment_succeeded"
                | "charge.refunded"
                | "charge.dispute.created"
                | "charge.dispute.funds_withdrawn"
                | "charge.dispute.funds_reinstated"
                | "refund.updated"
                | "refund.failed"
        ) {
            return Ok(None);
        }
        let object = &event["data"]["object"];
        let mut customer = resource_id(&object["customer"]).map(str::to_owned);
        let mut meta = object.get("metadata").cloned().unwrap_or(json!({}));
        if (kind.starts_with("charge.dispute.")
            || matches!(kind, "refund.updated" | "refund.failed"))
            && let Some(id) = resource_id(&object["charge"])
        {
            let charge = self.get(&path("charges", id)?, json!({})).await?;
            customer = resource_id(&charge["customer"]).map(str::to_owned);
            meta = charge["metadata"].clone();
        }
        if opt(&meta, "brokeboy_customer").is_none()
            && let Some(customer) = &customer
        {
            let c = self.get(&path("customers", customer)?, json!({})).await?;
            if c["deleted"] != true {
                meta = c["metadata"].clone();
            }
        }
        if let Some(environment) = opt(&meta, "brokeboy_environment") {
            require(
                environment == self.0.options.environment.name(),
                "environment_mismatch",
            )?;
        }
        Ok(Some(ProviderEvent {
            id: s(&event, "id")?.into(),
            kind: kind.into(),
            customer_id: opt(&meta, "brokeboy_customer").unwrap_or("").into(),
            data: json!({"provider":"stripe","providerCustomerId":customer,"stripeEventType":kind,"objectId":object["id"],"object":object}),
            extra: Default::default(),
        }))
    }
    pub(super) async fn subscription_event(
        &self,
        event: ProviderEvent,
        id: &str,
    ) -> Result<ProviderEvent> {
        let sub = self
            .get(
                &path("subscriptions", id)?,
                json!({"expand":["latest_invoice"]}),
            )
            .await?;
        self.live(&sub)?;
        require(opt(&sub, "id") == Some(id), "invalid_provider_event")?;
        let first = arr(&sub["items"], "data")?
            .iter()
            .find(|i| opt(&i["price"]["recurring"], "usage_type") != Some("metered"))
            .ok_or_else(|| BillingError::new("subscription_item_missing"))?;
        let trial = opt(&sub, "status") == Some("trialing");
        let paid = opt(&sub["latest_invoice"], "status") == Some("paid");
        let through = if paid {
            millis(n(first, "current_period_end")?)?
        } else if trial {
            millis(sub["trial_end"].as_i64().unwrap_or(0))?
        } else {
            0
        };
        if let Some(customer) = opt(&sub["metadata"], "brokeboy_customer") {
            require(customer == event.customer_id, "customer_mapping_conflict")?;
        }
        if let Some(environment) = opt(&sub["metadata"], "brokeboy_environment") {
            require(
                environment == self.0.options.environment.name(),
                "environment_mismatch",
            )?;
        }
        require(
            opt(&event.data, "providerCustomerId")
                .is_none_or(|id| resource_id(&sub["customer"]) == Some(id)),
            "customer_mapping_conflict",
        )?;
        let mut meters = json!({});
        for i in arr(&sub["items"], "data")? {
            if let Some(feature) = opt(&i["price"]["metadata"], "brokeboy_feature") {
                meters[feature] = i["price"]["id"].clone();
            }
        }
        let status = if !sub["pause_collection"].is_null() {
            "paused"
        } else {
            match opt(&sub, "status") {
                Some("active") => "active",
                Some("trialing") => "trialing",
                Some("past_due") => "past_due",
                Some("paused") => "paused",
                Some("canceled" | "unpaid" | "incomplete_expired") => "ended",
                _ => "pending",
            }
        };
        let quantity = first
            .get("quantity")
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| v.to_string())
            })
            .unwrap_or_else(|| "1".into());
        let mut subscription = json!({"id":sub["id"],"stripeSubscriptionId":sub["id"],"status":status,"periodStart":millis(n(first,"current_period_start")?)?,"periodEnd":millis(n(first,"current_period_end")?)?,"paidThrough":through,"quantity":quantity,"cancelAtPeriodEnd":sub["cancel_at_period_end"]});
        if let Some(entity) = opt(&sub["metadata"], "brokeboy_entity") {
            subscription["entityId"] = json!(entity);
        }
        let mut data = json!({"meterPriceIds":meters,"pending":!sub["pending_update"].is_null(),"subscription":subscription});
        if let Some(plan) = opt(&first["price"]["metadata"], "brokeboy_plan")
            .or_else(|| opt(&sub["metadata"], "brokeboy_plan"))
        {
            data["planId"] = json!(plan);
        }
        if let Some(version) = opt(&first["price"]["metadata"], "brokeboy_version")
            .or_else(|| opt(&sub["metadata"], "brokeboy_version"))
        {
            data["planVersion"] = json!(version);
        }
        Ok(ProviderEvent {
            id: event.id,
            kind: "subscription.updated".into(),
            customer_id: event.customer_id,
            data,
            extra: Default::default(),
        })
    }
    fn purchase_event(&self, event: &ProviderEvent, resource: &Value) -> Result<ProviderEvent> {
        let meta = &resource["metadata"];
        let mut data = json!({"planId":meta["brokeboy_plan"],"purchaseId":meta.get("brokeboy_purchase").unwrap_or(&resource["id"]),"quantity":opt(meta,"brokeboy_quantity").unwrap_or("1")});
        for (from, to) in [
            ("brokeboy_version", "planVersion"),
            ("brokeboy_entity", "entityId"),
            ("brokeboy_topup_counter", "topupCounter"),
        ] {
            if let Some(value) = meta.get(from) {
                data[to] = value.clone();
            }
        }
        Ok(ProviderEvent {
            id: event.id.clone(),
            kind: "purchase.paid".into(),
            customer_id: event.customer_id.clone(),
            data,
            extra: Default::default(),
        })
    }
    pub(super) async fn reconcile_event(&self, event: ProviderEvent) -> Result<ProviderEvent> {
        let kind = s(&event.data, "stripeEventType")?;
        let object = &event.data["object"];
        if kind.starts_with("customer.subscription.") {
            let id = s(object, "id")?.to_owned();
            return self.subscription_event(event, &id).await;
        }
        if kind.starts_with("invoice.") {
            let invoice = self
                .get(&path("invoices", s(object, "id")?)?, json!({}))
                .await?;
            if let Some(id) =
                resource_id(&invoice["parent"]["subscription_details"]["subscription"])
            {
                return self.subscription_event(event, id).await;
            }
            if opt(&invoice, "status") == Some("paid")
                && opt(&invoice["metadata"], "brokeboy_plan").is_some()
            {
                return self.purchase_event(&event, &invoice);
            }
        }
        if matches!(
            kind,
            "checkout.session.completed" | "checkout.session.async_payment_succeeded"
        ) {
            let session = self
                .get(
                    &path("checkout/sessions", s(object, "id")?)?,
                    json!({"expand":["payment_intent.latest_charge"]}),
                )
                .await?;
            require(
                opt(&event.data, "providerCustomerId")
                    .is_none_or(|id| resource_id(&session["customer"]) == Some(id)),
                "customer_mapping_conflict",
            )?;
            if opt(&session["metadata"], "brokeboy_prepaid_feature").is_some()
                && session["payment_status"] == "paid"
            {
                let intent = &session["payment_intent"];
                let charge = &intent["latest_charge"];
                let cents = n(&session, "amount_total")?;
                require(
                    session["currency"] == "usd"
                        && session["mode"] == "payment"
                        && intent["status"] == "succeeded"
                        && intent["amount_received"] == cents
                        && charge["paid"] == true
                        && charge["captured"] == true
                        && charge["amount_captured"] == cents
                        && charge["currency"] == "usd"
                        && opt(&session["metadata"], "brokeboy_prepaid_cents")
                            == Some(cents.to_string().as_str()),
                    "unverified_payment",
                )?;
                return Ok(ProviderEvent {
                    id: event.id,
                    kind: "prepaid.paid".into(),
                    customer_id: event.customer_id,
                    data: json!({"purchaseId":session["metadata"]["brokeboy_purchase"],"feature":session["metadata"]["brokeboy_prepaid_feature"],"creditCents":cents}),
                    extra: Default::default(),
                });
            }
            if opt(&session, "mode") == Some("subscription")
                && let Some(id) = resource_id(&session["subscription"])
            {
                return self.subscription_event(event, id).await;
            }
            if opt(&session, "payment_status") == Some("paid")
                && opt(&session["metadata"], "brokeboy_plan").is_some()
            {
                return self.purchase_event(&event, &session);
            }
        }
        if kind == "charge.refunded"
            || matches!(kind, "refund.updated" | "refund.failed")
            || kind.starts_with("charge.dispute.")
        {
            let id = if kind == "charge.refunded" {
                s(object, "id")?
            } else {
                resource_id(&object["charge"])
                    .ok_or_else(|| BillingError::new("invalid_provider_event"))?
            };
            let charge = self.get(&path("charges", id)?, json!({})).await?;
            self.live(&charge)?;
            require(
                opt(&event.data, "providerCustomerId")
                    .is_none_or(|id| resource_id(&charge["customer"]) == Some(id)),
                "customer_mapping_conflict",
            )?;
            let mut purchase = None;
            if let Some(id) = resource_id(&charge["payment_intent"]) {
                let pi = self.get(&path("payment_intents", id)?, json!({})).await?;
                purchase = opt(&pi["metadata"], "brokeboy_purchase").map(str::to_owned);
            }
            if purchase.is_none()
                && let Some(id) = resource_id(&charge["invoice"])
            {
                let invoice = self.get(&path("invoices", id)?, json!({})).await?;
                purchase = opt(&invoice["metadata"], "brokeboy_purchase").map(str::to_owned);
            }
            let mut event = event.clone();
            let Some(purchase) = purchase else {
                event.kind = "payment.reconciliation".into();
                event.data["requiresReview"] = json!(true);
                return Ok(event);
            };
            if kind == "charge.dispute.created" {
                event.kind = "payment.reconciliation".into();
                event.data["requiresReview"] = json!(true);
                return Ok(event);
            }
            let mut refunded = 0_i64;
            let mut cursor: Option<String> = None;
            let mut seen = std::collections::BTreeSet::new();
            loop {
                let mut params = json!({"charge":id,"limit":100});
                if let Some(cursor) = &cursor {
                    params["starting_after"] = json!(cursor);
                }
                let page = self.get("refunds", params).await?;
                let refunds = arr(&page, "data")?;
                for refund in refunds {
                    require(
                        resource_id(&refund["charge"]) == Some(id),
                        "invalid_provider_event",
                    )?;
                    require(
                        seen.insert(s(refund, "id")?.to_owned()) && seen.len() <= 10000,
                        "invalid_provider_event",
                    )?;
                    match opt(refund, "status") {
                        Some("succeeded") => {
                            let amount = n(refund, "amount")?;
                            require(amount > 0, "invalid_provider_event")?;
                            refunded = refunded
                                .checked_add(amount)
                                .ok_or_else(|| BillingError::new("amount_overflow"))?;
                        }
                        Some("pending" | "failed" | "canceled" | "requires_action") => {}
                        _ => return Err(BillingError::new("invalid_provider_event")),
                    }
                }
                if page["has_more"] == false {
                    break;
                }
                require(page["has_more"] == true, "invalid_provider_event")?;
                cursor = Some(
                    s(
                        refunds
                            .last()
                            .ok_or_else(|| BillingError::new("invalid_provider_event"))?,
                        "id",
                    )?
                    .into(),
                );
            }
            event.kind = "purchase.adjusted".into();
            event.data["purchaseId"] = json!(purchase);
            event.data["paidMinor"] = charge["amount"].clone();
            event.data["refundedMinor"] = json!(refunded);
            if kind.starts_with("charge.dispute.funds_") {
                event.data["dispute"] = json!({"id":object["id"],"amount":object["amount"],"reinstated":kind=="charge.dispute.funds_reinstated"});
            }
            return Ok(event);
        }
        Ok(event)
    }
    pub(super) async fn verify_mapping(&self, key: &str, id: &str) -> Result<()> {
        let (kind, suffix) = key
            .split_once(':')
            .ok_or_else(|| BillingError::new("unknown_resource_kind"))?;
        if kind == "customer" {
            let c = self.get(&path("customers", id)?, json!({})).await?;
            require(c["deleted"] != true, "resource_mapping_conflict")?;
            self.live(&c)?;
            require(
                opt(&c["metadata"], "brokeboy_environment")
                    == Some(self.0.options.environment.name()),
                "resource_mapping_conflict",
            )?;
            require(
                hash_v1(
                    &json!({"environment":self.0.options.environment.name(),"customer":c["metadata"]["brokeboy_customer"]}),
                )? == suffix,
                "resource_mapping_conflict",
            )?;
            return Ok(());
        }
        if kind == "meter" {
            let meter = self.get(&path("billing/meters", id)?, json!({})).await?;
            self.live(&meter)?;
            return require(
                opt(&meter, "event_name") == Some(suffix),
                "resource_mapping_conflict",
            );
        }
        let collection = match kind {
            "price" | "meter-price" => "prices",
            "product" | "meter-product" => "products",
            _ => return Err(BillingError::new("unknown_resource_kind")),
        };
        let resource = self.get(&path(collection, id)?, json!({})).await?;
        self.live(&resource)?;
        let version = s(&resource["metadata"], "brokeboy_version")?;
        let expected = if matches!(kind, "price" | "product") {
            version.into()
        } else {
            format!(
                "bb_{}_{}",
                version.chars().take(24).collect::<String>(),
                &hash_v1(&resource["metadata"]["brokeboy_feature"])?[..16]
            )
        };
        require(expected == suffix, "resource_mapping_conflict")
    }
}
