use super::*;
use brokeboy_core::decimal::SCALE;
fn base_item(sub: &Value) -> Result<Value> {
    arr(&sub["items"], "data")?
        .iter()
        .find(|i| opt(&i["price"]["recurring"], "usage_type") != Some("metered"))
        .cloned()
        .ok_or_else(|| BillingError::new("subscription_item_missing"))
}
impl Stripe {
    async fn schedule_for(&self, sub: &Value, key: &str) -> Result<Value> {
        if let Some(id) = resource_id(&sub["schedule"]) {
            self.get(&path("subscription_schedules", id)?, json!({}))
                .await
        } else {
            self.post(
                "subscription_schedules",
                json!({"from_subscription":sub["id"]}),
                &format!("{key}:create"),
            )
            .await
        }
    }
    fn current_phase(&self, sub: &Value, schedule: &Value) -> Result<Value> {
        require(
            schedule["current_phase"].is_object(),
            "schedule_phase_missing",
        )?;
        let mut items = Vec::new();
        for i in arr(&sub["items"], "data")? {
            let mut item = json!({"price":i["price"]["id"]});
            if opt(&i["price"]["recurring"], "usage_type") != Some("metered") {
                item["quantity"] = i.get("quantity").cloned().unwrap_or(json!(1));
            }
            items.push(item);
        }
        Ok(
            json!({"start_date":schedule["current_phase"]["start_date"],"end_date":schedule["current_phase"]["end_date"],"items":items,"metadata":sub["metadata"]}),
        )
    }
    pub(super) async fn execute_subscription(
        &self,
        kind: &str,
        command: &PaymentCommand,
        customer: &str,
    ) -> Result<Value> {
        let p = &command.input;
        let key = &command.id;
        let plan = p.get("plan");
        if kind == "subscription_import" {
            require(
                opt(&command.customer, "stripeCustomerId").is_some(),
                "customer_mapping_required",
            )?;
            let plan = plan.ok_or_else(|| BillingError::new("plan_required"))?;
            let sub = self
                .get(
                    &path("subscriptions", s(p, "stripeSubscriptionId")?)?,
                    json!({}),
                )
                .await?;
            require(
                resource_id(&sub["customer"]) == Some(customer),
                "subscription_not_found",
            )?;
            self.post(&path("subscriptions",s(&sub,"id")?)?,json!({"metadata":self.metadata(s(&command.customer,"id")?,Some(plan),opt(p,"entityId"))?}),key).await?;
            let event = ProviderEvent {
                id: format!("import:{key}"),
                kind: "subscription.updated".into(),
                customer_id: s(&command.customer, "id")?.into(),
                data: json!({}),
                extra: Default::default(),
            };
            let event = self.subscription_event(event, s(&sub, "id")?).await?;
            return Ok(json!({"providerEvent":event}));
        }
        if !matches!(
            kind,
            "preview"
                | "subscription_update"
                | "subscription_cancel"
                | "subscription_pause"
                | "subscription_resume"
                | "subscription_schedule"
        ) {
            return Err(BillingError::new("unsupported_payment_operation"));
        }
        let sub = self
            .owned_subscription(customer, s(p, "subscriptionId")?)
            .await?;
        let id = s(&sub, "id")?;
        match kind {
            "preview" => {
                let plan = plan.ok_or_else(|| BillingError::new("plan_required"))?;
                let item = base_item(&sub)?;
                let price = self
                    .price_for(plan, false, command.resources.clone())
                    .await?;
                let invoice=self.post("invoices/create_preview",json!({"customer":customer,"subscription":id,"subscription_details":{"items":[{"id":item["id"],"price":price}],"proration_behavior":"always_invoice"}}),key).await?;
                Ok(json!({"amountDue":invoice["amount_due"],"currency":invoice["currency"]}))
            }
            "subscription_cancel" => {
                let result = if p["immediately"] == true {
                    self.request(
                        reqwest::Method::DELETE,
                        &path("subscriptions", id)?,
                        json!({}),
                        Some(key),
                    )
                    .await?
                } else {
                    self.post(
                        &path("subscriptions", id)?,
                        json!({"cancel_at_period_end":true}),
                        key,
                    )
                    .await?
                };
                Ok(json!({"id":result["id"],"status":result["status"]}))
            }
            "subscription_pause" | "subscription_resume" => {
                let params = if kind == "subscription_pause" {
                    json!({"pause_collection":{"behavior":"void"}})
                } else {
                    json!({"pause_collection":""})
                };
                self.post(&path("subscriptions", id)?, params, key).await?;
                Ok(json!({"id":id}))
            }
            "subscription_update" => {
                let item = base_item(&sub)?;
                let quantity = if let Some(value) = opt(p, "quantity") {
                    let n = nonnegative(value)?;
                    require(
                        n > 0 && n % SCALE == 0 && n / SCALE <= 9_007_199_254_740_991,
                        "invalid_seat_quantity",
                    )?;
                    Some((n / SCALE).to_string())
                } else {
                    None
                };
                let price = if let Some(plan) = plan {
                    self.price_for(plan, false, command.resources.clone())
                        .await?
                } else {
                    s(&item["price"], "id")?.into()
                };
                if opt(p, "effective").unwrap_or("period_end") == "period_end" {
                    let schedule = self.schedule_for(&sub, key).await?;
                    let first = self.current_phase(&sub, &schedule)?;
                    let mut base = json!({"price":price,"quantity":quantity.map(Value::String).unwrap_or_else(||item.get("quantity").cloned().unwrap_or(json!(1)))});
                    let mut items = vec![base.take()];
                    if let Some(plan) = plan {
                        for price in self
                            .meter_prices(plan, command.resources.clone())
                            .await?
                            .as_object()
                            .unwrap()
                            .values()
                        {
                            items.push(json!({"price":price}));
                        }
                    } else {
                        for i in arr(&sub["items"], "data")? {
                            if opt(&i["price"]["recurring"], "usage_type") == Some("metered") {
                                items.push(json!({"price":i["price"]["id"]}));
                            }
                        }
                    }
                    let result=self.post(&path("subscription_schedules",s(&schedule,"id")?)?,json!({"end_behavior":"release","phases":[first,{"items":items,"metadata":self.metadata(s(&command.customer,"id")?,plan,opt(p,"entityId"))?}]}),key).await?;
                    return Ok(json!({"id":result["id"]}));
                }
                let mut base = json!({"id":item["id"]});
                if plan.is_some() {
                    base["price"] = json!(price);
                }
                if let Some(quantity) = quantity {
                    base["quantity"] = json!(quantity);
                }
                let mut items = vec![base];
                if let Some(plan) = plan {
                    for i in arr(&sub["items"], "data")? {
                        if i["id"] != item["id"] {
                            items.push(json!({"id":i["id"],"deleted":true}));
                        }
                    }
                    for price in self
                        .meter_prices(plan, command.resources.clone())
                        .await?
                        .as_object()
                        .unwrap()
                        .values()
                    {
                        items.push(json!({"price":price}));
                    }
                }
                let mut params = json!({"items":items,"proration_behavior":"always_invoice","payment_behavior":"pending_if_incomplete"});
                if let Some(plan) = plan {
                    params["metadata"] =
                        self.metadata(s(&command.customer, "id")?, Some(plan), opt(p, "entityId"))?;
                }
                let updated = self.post(&path("subscriptions", id)?, params, key).await?;
                Ok(json!({"id":updated["id"],"status":updated["status"]}))
            }
            "subscription_schedule" => {
                let phases = arr(p, "phases")?;
                require(!phases.is_empty() && phases.len() <= 10, "invalid_schedule")?;
                let schedule = self.schedule_for(&sub, key).await?;
                let mut built = vec![self.current_phase(&sub, &schedule)?];
                let item = base_item(&sub)?;
                for phase in phases {
                    let iterations = n(phase, "iterations")?;
                    require(
                        iterations > 0 && iterations <= 9_007_199_254_740_991,
                        "invalid_schedule",
                    )?;
                    let plan = &phase["plan"];
                    let mut items = vec![
                        json!({"price":self.price_for(plan,false,command.resources.clone()).await?,"quantity":item.get("quantity").cloned().unwrap_or(json!(1))}),
                    ];
                    for price in self
                        .meter_prices(plan, command.resources.clone())
                        .await?
                        .as_object()
                        .unwrap()
                        .values()
                    {
                        items.push(json!({"price":price}));
                    }
                    built.push(json!({"items":items,"duration":{"interval":opt(plan,"interval").unwrap_or("month"),"interval_count":iterations},"metadata":self.metadata(s(&command.customer,"id")?,Some(plan),opt(&sub["metadata"],"brokeboy_entity"))?}));
                }
                let result = self
                    .post(
                        &path("subscription_schedules", s(&schedule, "id")?)?,
                        json!({"phases":built,"end_behavior":"release"}),
                        key,
                    )
                    .await?;
                Ok(json!({"id":result["id"]}))
            }
            _ => Err(BillingError::new("unsupported_payment_operation")),
        }
    }
}
