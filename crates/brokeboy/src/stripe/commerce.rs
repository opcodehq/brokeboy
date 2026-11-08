use super::*;
use brokeboy_core::decimal::SCALE;
impl Stripe {
    pub(super) async fn execute_command(
        &self,
        command: PaymentCommand,
        customer: String,
    ) -> Result<Value> {
        let p = &command.input;
        let key = &command.id;
        let mut common = json!({"stripeCustomerId":customer});
        let result = match command.kind.as_str() {
            "customer_refresh" => {
                let mut events = Vec::new();
                for subscription in arr(p, "subscriptions")? {
                    let event = ProviderEvent {
                        id: format!("refresh:{key}"),
                        kind: "subscription.updated".into(),
                        customer_id: s(&command.customer, "id")?.into(),
                        data: json!({"providerCustomerId":customer}),
                        extra: Default::default(),
                    };
                    let mut event = self
                        .subscription_event(event, s(subscription, "id")?)
                        .await?;
                    event.id = format!("refresh:{key}:{}", hash_v1(&event.data)?);
                    events.push(event);
                }
                json!({"providerEvents":events})
            }
            "prepaid_checkout" => {
                let cents = n(p, "amountCents")?;
                require((1..=99_999_999).contains(&cents), "invalid_amount")?;
                let mut meta = self.metadata(s(&command.customer, "id")?, None, None)?;
                meta["brokeboy_purchase"] = json!(key);
                meta["brokeboy_prepaid_feature"] = p["feature"].clone();
                meta["brokeboy_prepaid_cents"] = json!(cents.to_string());
                let mut params = json!({"mode":"payment","customer":customer,"success_url":normalized_url(s(p,"successUrl")?)?,"line_items":[{"price_data":{"currency":"usd","unit_amount":cents,"product_data":{"name":"Prepaid credit"}},"quantity":1}],"metadata":meta,"payment_intent_data":{"metadata":meta}});
                if let Some(cancel) = opt(p, "cancelUrl") {
                    params["cancel_url"] = json!(normalized_url(cancel)?);
                }
                checkout_options(p, &mut params)?;
                let session = self.post("checkout/sessions", params, key).await?;
                json!({"id":session["id"],"url":session["url"]})
            }
            "prepaid_balance_import" => self.import_customer_balance(&command, &customer).await?,
            "checkout" => {
                let plan = p
                    .get("plan")
                    .ok_or_else(|| BillingError::new("plan_required"))?;
                let once = opt(plan, "kind") == Some("one_time");
                let price = self
                    .price_for(plan, once, command.resources.clone())
                    .await?;
                let count = nonnegative(opt(p, "quantity").unwrap_or("1"))?;
                require(
                    count > 0 && count % SCALE == 0 && count / SCALE <= 9_007_199_254_740_991,
                    "invalid_seat_quantity",
                )?;
                let mut data =
                    self.metadata(s(&command.customer, "id")?, Some(plan), opt(p, "entityId"))?;
                data["brokeboy_purchase"] = json!(key);
                data["brokeboy_quantity"] = json!(opt(p, "quantity").unwrap_or("1"));
                let mut items = vec![json!({"price":price,"quantity":(count/SCALE).to_string()})];
                if !once {
                    for price in self
                        .meter_prices(plan, command.resources.clone())
                        .await?
                        .as_object()
                        .ok_or_else(|| BillingError::new("invalid_record"))?
                        .values()
                    {
                        items.push(json!({"price":price}));
                    }
                }
                let mut params = json!({"customer":customer,"customer_update":{"name":"auto","address":"auto"},"mode":if once{"payment"}else{"subscription"},"line_items":items,"success_url":normalized_url(s(p,"successUrl")?)?,"metadata":data,"automatic_tax":{"enabled":p["automaticTax"]==true},"billing_address_collection":"auto","tax_id_collection":{"enabled":true}});
                if let Some(cancel) = opt(p, "cancelUrl") {
                    params["cancel_url"] = json!(normalized_url(cancel)?);
                }
                checkout_options(p, &mut params)?;
                if once {
                    params["payment_intent_data"] = json!({"metadata":data});
                    params["invoice_creation"] =
                        json!({"enabled":true,"invoice_data":{"metadata":data}});
                } else {
                    let mut subscription = json!({"metadata":data});
                    if p["trialAllowed"] == true
                        && let Some(days) = plan.get("trialDays")
                    {
                        subscription["trial_period_days"] = days.clone();
                    }
                    params["subscription_data"] = subscription;
                    if arr(plan, "items")?.iter().any(|i| i["overage"] == true) {
                        params["payment_method_collection"] = json!("always");
                    }
                }
                if let Some(discount) = opt(p, "discountId") {
                    params["discounts"] = json!([{"promotion_code":discount}]);
                } else {
                    params["allow_promotion_codes"] = json!(true);
                }
                let session = self.post("checkout/sessions", params, key).await?;
                json!({"id":session["id"],"url":session["url"]})
            }
            "portal" => {
                self.post(
                    "billing_portal/sessions",
                    json!({"customer":customer,"return_url":normalized_url(s(p,"returnUrl")?)?}),
                    key,
                )
                .await?
            }
            "invoices" => {
                let page = self
                    .get("invoices", json!({"customer":customer,"limit":100}))
                    .await?;
                let invoices:Vec<_>=arr(&page,"data")?.iter().map(|i|json!({"id":i["id"],"status":i["status"],"total":i["total"],"currency":i["currency"],"url":i["hosted_invoice_url"]})).collect();
                json!({"invoices":invoices,"hasMore":page["has_more"]})
            }
            "invoice" => {
                let currency = s(p, "currency")?;
                let value = minor(s(p, "amount")?, currency)?;
                require(value != "0", "invalid_amount")?;
                let invoice=self.post("invoices",json!({"customer":customer,"collection_method":"send_invoice","days_until_due":p["daysUntilDue"].as_i64().unwrap_or(30),"metadata":self.metadata(s(&command.customer,"id")?,None,None)?,"auto_advance":false}),&format!("{key}:invoice")).await?;
                let id = s(&invoice, "id")?;
                self.post("invoiceitems",json!({"customer":customer,"invoice":id,"amount":value,"currency":currency,"description":p["description"]}),&format!("{key}:line")).await?;
                let finalized = self
                    .post(
                        &format!("{}/finalize", path("invoices", id)?),
                        json!({}),
                        key,
                    )
                    .await?;
                json!({"id":finalized["id"],"url":finalized["hosted_invoice_url"]})
            }
            "refund" => {
                let payment = self
                    .get(
                        &path("payment_intents", s(p, "paymentIntentId")?)?,
                        json!({}),
                    )
                    .await?;
                require(
                    resource_id(&payment["customer"]) == Some(customer.as_str()),
                    "payment_not_found",
                )?;
                let reason = s(p, "reason")?;
                require(!reason.trim().is_empty(), "reason_required")?;
                let mut meta = self.metadata(s(&command.customer, "id")?, None, None)?;
                meta["brokeboy_reason"] = json!(reason.chars().take(500).collect::<String>());
                let mut params = json!({"payment_intent":payment["id"],"metadata":meta});
                if let Some(value) = opt(p, "amount") {
                    params["amount"] = json!(minor(value, s(&payment, "currency")?)?);
                }
                let result = self.post("refunds", params, key).await?;
                json!({"id":result["id"],"status":result["status"]})
            }
            "credit_note" => {
                let invoice = self
                    .get(&path("invoices", s(p, "invoiceId")?)?, json!({}))
                    .await?;
                require(
                    resource_id(&invoice["customer"]) == Some(customer.as_str()),
                    "invoice_not_found",
                )?;
                let result=self.post("credit_notes",json!({"invoice":p["invoiceId"],"amount":minor(s(p,"amount")?,s(&invoice,"currency")?)?,"memo":p["reason"]}),key).await?;
                json!({"id":result["id"]})
            }
            "auto_topup" => {
                let plan = p
                    .get("plan")
                    .ok_or_else(|| BillingError::new("plan_required"))?;
                require(
                    opt(plan, "kind") == Some("one_time"),
                    "topup_plan_must_be_one_time",
                )?;
                let mut meta = self.metadata(s(&command.customer, "id")?, Some(plan), None)?;
                meta["brokeboy_purchase"] = json!(key);
                meta["brokeboy_topup_counter"] = p["counter"].clone();
                let invoice=self.post("invoices",json!({"customer":customer,"auto_advance":false,"collection_method":"charge_automatically","metadata":meta}),&format!("{key}:invoice")).await?;
                let id = s(&invoice, "id")?;
                let price = self
                    .price_for(plan, true, command.resources.clone())
                    .await?;
                self.post("invoiceitems",json!({"customer":customer,"invoice":id,"pricing":{"price":price},"quantity":1}),&format!("{key}:line")).await?;
                self.post(
                    &format!("{}/finalize", path("invoices", id)?),
                    json!({}),
                    &format!("{key}:finalize"),
                )
                .await?;
                let paid = self
                    .post(&format!("{}/pay", path("invoices", id)?), json!({}), key)
                    .await?;
                json!({"id":paid["id"],"status":paid["status"]})
            }
            "meter" => {
                let sub = self
                    .owned_subscription(&customer, s(p, "subscriptionId")?)
                    .await?;
                let price_id = s(p, "priceId")?;
                require(
                    self.meter_period_open(&sub, p, price_id, &customer).await?,
                    "reconciliation_required",
                )?;
                require(
                    arr(&sub["items"], "data")?
                        .iter()
                        .any(|i| opt(&i["price"], "id") == Some(price_id)),
                    "reconciliation_required",
                )?;
                let price = self.get(&path("prices", price_id)?, json!({})).await?;
                require(
                    opt(&price["recurring"], "usage_type") == Some("metered")
                        && price["unit_amount"] == 1
                        && price["currency"] == p["currency"],
                    "meter_price_must_be_minor_unit",
                )?;
                let meter = self
                    .get(
                        &path("billing/meters", s(&price["recurring"], "meter")?)?,
                        json!({}),
                    )
                    .await?;
                require(
                    self.0.options.clock.now() < n(p, "periodEnd")? + 60 * 60000,
                    "reconciliation_required",
                )?;
                let target = minor(s(p, "total")?, s(p, "currency")?)?;
                let previous = opt(p, "previousMinor")
                    .unwrap_or("0")
                    .parse::<i128>()
                    .map_err(|_| BillingError::new("invalid_record"))?;
                let delta = target
                    .parse::<i128>()
                    .map_err(|_| BillingError::new("provider_amount_overflow"))?
                    - previous;
                if delta == 0 {
                    json!({"exportedMinor":target})
                } else {
                    let mut payload = json!({});
                    payload[s(&meter["customer_mapping"], "event_payload_key")?] = json!(customer);
                    payload[s(&meter["value_settings"], "event_payload_key")?] =
                        json!(delta.to_string());
                    let event=self.post("billing/meter_events",json!({"event_name":meter["event_name"],"identifier":key,"payload":payload,"timestamp":self.0.options.clock.now().min(n(p,"periodEnd")?-1000)/1000}),key).await?;
                    json!({"id":event["identifier"],"exportedMinor":target})
                }
            }
            kind => self.execute_subscription(kind, &command, &customer).await?,
        };
        let object = result
            .as_object()
            .ok_or_else(|| BillingError::new("invalid_provider_result"))?;
        for (k, v) in object {
            common[k] = v.clone();
        }
        Ok(common)
    }
    async fn meter_period_open(
        &self,
        sub: &Value,
        p: &Value,
        price: &str,
        customer: &str,
    ) -> Result<bool> {
        let start = n(p, "periodStart")? / 1000;
        let end = n(p, "periodEnd")? / 1000;
        require(start >= 0 && end > start, "invalid_billing_period")?;
        if self.0.options.clock.now() < n(p, "periodEnd")?
            && !matches!(opt(sub, "status"), Some("canceled" | "incomplete_expired"))
            && arr(&sub["items"], "data")?.iter().any(|item| {
                opt(&item["price"], "id") == Some(price)
                    && item["current_period_start"] == start
                    && item["current_period_end"] == end
            })
        {
            return Ok(true);
        }
        let mut cursor = None;
        let mut seen = std::collections::BTreeSet::new();
        let mut matched = false;
        loop {
            let mut params =
                json!({"subscription":sub["id"],"created":{"gte":end-300},"limit":100});
            if let Some(cursor) = &cursor {
                params["starting_after"] = json!(cursor);
            }
            let page = self.get("invoices", params).await?;
            let invoices = arr(&page, "data")?;
            for invoice in invoices {
                let id = s(invoice, "id")?;
                require(
                    seen.insert(id.to_owned()) && seen.len() <= 10000,
                    "invalid_provider_event",
                )?;
                require(
                    resource_id(&invoice["customer"]) == Some(customer),
                    "customer_mapping_conflict",
                )?;
                let mut line_cursor = None;
                let mut line_ids = std::collections::BTreeSet::new();
                loop {
                    let mut params = json!({"limit":100});
                    if let Some(cursor) = &line_cursor {
                        params["starting_after"] = json!(cursor);
                    }
                    let lines = self
                        .get(&format!("{}/lines", path("invoices", id)?), params)
                        .await?;
                    let data = arr(&lines, "data")?;
                    for line in data {
                        require(
                            line_ids.insert(s(line, "id")?.to_owned()) && line_ids.len() <= 10000,
                            "invalid_provider_event",
                        )?;
                        if resource_id(&line["pricing"]["price_details"]["price"]) == Some(price)
                            && line["period"]["start"] == start
                            && line["period"]["end"] == end
                        {
                            if invoice["status"] != "draft" {
                                return Ok(false);
                            }
                            matched = true;
                        }
                    }
                    if lines["has_more"] == false {
                        break;
                    }
                    require(lines["has_more"] == true, "invalid_provider_event")?;
                    line_cursor = Some(
                        s(
                            data.last()
                                .ok_or_else(|| BillingError::new("invalid_provider_event"))?,
                            "id",
                        )?
                        .to_owned(),
                    );
                }
            }
            if page["has_more"] == false {
                break;
            }
            require(page["has_more"] == true, "invalid_provider_event")?;
            cursor = Some(
                s(
                    invoices
                        .last()
                        .ok_or_else(|| BillingError::new("invalid_provider_event"))?,
                    "id",
                )?
                .to_owned(),
            );
        }
        Ok(matched)
    }
}
pub(super) fn normalized_url(value: &str) -> Result<String> {
    let url = url::Url::parse(value).map_err(|_| BillingError::new("invalid_url"))?;
    require(
        url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))),
        "invalid_url",
    )?;
    Ok(url.to_string())
}
fn checkout_options(input: &Value, params: &mut Value) -> Result<()> {
    if let Some(methods) = input.get("paymentMethodTypes") {
        let methods = methods
            .as_array()
            .ok_or_else(|| BillingError::new("invalid_payment_methods"))?;
        require(
            !methods.is_empty() && methods.len() <= 20,
            "invalid_payment_methods",
        )?;
        for method in methods {
            require(
                method.as_str().is_some_and(|v| {
                    !v.is_empty()
                        && v.len() <= 64
                        && v.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                }),
                "invalid_payment_methods",
            )?;
        }
        params["allowed_payment_method_types"] = json!(methods);
    }
    if let Some(mode) = opt(input, "requestThreeDSecure") {
        require(
            matches!(mode, "automatic" | "any" | "challenge"),
            "invalid_payment_options",
        )?;
        params["payment_method_options"]["card"]["request_three_d_secure"] = json!(mode);
    }
    Ok(())
}
