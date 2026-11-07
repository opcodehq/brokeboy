use super::*;
use crate::{
    provider::{PaymentCommand, ProviderEvent},
    storage::PageQuery,
};
use brokeboy_core::compatibility::hash_v1;
use std::collections::BTreeMap;

impl Billing {
    pub async fn webhook(&self, headers: BTreeMap<String, String>, body: Vec<u8>) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        self.register_request(&id)?;
        self.webhook_registered(headers, body, &id).await
    }
    pub async fn webhook_registered(
        &self,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
        id: &str,
    ) -> Result<Value> {
        let request = self.0.lifecycle.start(id)?;
        request.check()?;
        require(
            body.len() <= brokeboy_core::MAX_WEBHOOK_BYTES,
            "body_too_large",
        )?;
        tokio::select! {biased;_=request.cancelled()=>Err(BillingError::new("interrupted")),result=self.webhook_inner(headers,body)=>result}
    }
    async fn webhook_inner(
        &self,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> Result<Value> {
        let provider = self
            .0
            .options
            .provider
            .as_ref()
            .ok_or_else(|| BillingError::new("provider_missing"))?;
        if let Some(event) = provider.verify(headers, body).await? {
            let scope = self.scope(&event.customer_id)?;
            let this = self.clone();
            self.atomic(&scope, move |tx| {
                Box::pin(async move {
                    if get(tx, Table::Inbox, &event.id).await?.is_some() {
                        return Ok(Value::Null);
                    }
                    this.customer(tx, &event.customer_id).await?;
                    let raw = serde_json::to_value(&event)
                        .map_err(|_| BillingError::new("invalid_provider_event"))?;
                    put(tx, Table::Inbox, &event.id, raw.clone(), "pending").await?;
                    this.enqueue(
                        tx,
                        &format!("webhook:{}", event.id),
                        "webhook",
                        json!({"event":raw}),
                    )
                    .await?;
                    Ok(Value::Null)
                })
            })
            .await?;
        }
        Ok(json!({"accepted":true}))
    }
    pub(crate) fn provider_identity(&self, scope: &str, operation: &str) -> Result<String> {
        hash_v1(
            &json!({"environment":self.0.options.environment.name(),"scope":scope,"operation":operation}),
        )
    }
    pub(crate) async fn run_work(&self, scope: &str, id: &str) -> Result<bool> {
        let token = self.id();
        let this = self.clone();
        let claim_id = id.to_owned();
        let owner = token.clone();
        let work = self
            .atomic(scope, move |tx| {
                Box::pin(async move {
                    let Some(row) = tx.get(Table::Work, &claim_id).await? else {
                        return Ok(Value::Null);
                    };
                    let mut work = row.data;
                    if matches!(row.state.as_str(), "done" | "reconciliation")
                        || n(&work, "availableAt")? > this.now()
                        || (row.state == "processing"
                            && work["leaseUntil"].as_i64().unwrap_or(0) > this.now())
                    {
                        return Ok(Value::Null);
                    }
                    let internal = matches!(opt(&work, "kind"), Some("event" | "workflow_timeout"));
                    if !internal
                        && let Some(lane) = get(tx, Table::Counters, "provider-lane").await?
                    {
                        if n(&lane, "until")? > this.now() {
                            return Ok(Value::Null);
                        }
                        if let Some(previous) = opt(&lane, "operationId")
                            && previous != claim_id
                            && tx
                                .get(Table::Work, previous)
                                .await?
                                .is_some_and(|w| w.state == "processing")
                        {
                            return Ok(Value::Null);
                        }
                    }
                    if opt(&work, "kind") == Some("subscription_update") {
                        for candidate in list(tx, Table::Work, None).await? {
                            if opt(&candidate, "kind") == Some("meter")
                                && candidate["payload"]["subscriptionId"]
                                    == work["payload"]["subscriptionId"]
                                && matches!(
                                    opt(&candidate, "status"),
                                    Some("pending" | "failed" | "processing" | "reconciliation")
                                )
                            {
                                return Ok(Value::Null);
                            }
                        }
                    }
                    if !internal {
                        put(
                            tx,
                            Table::Counters,
                            "provider-lane",
                            json!({"owner":owner,"operationId":claim_id,"until":this.now()+120000}),
                            "active",
                        )
                        .await?;
                    }
                    work["status"] = json!("processing");
                    work["attempts"] = json!(n(&work, "attempts")? + 1);
                    work["leaseOwner"] = json!(owner);
                    work["leaseUntil"] = json!(this.now() + 120000);
                    put(tx, Table::Work, &claim_id, work.clone(), "processing").await?;
                    Ok(work)
                })
            })
            .await?;
        if work.is_null() {
            return Ok(false);
        }
        let customer = scope
            .strip_prefix(&format!("{}:c:", self.0.options.environment.name()))
            .ok_or_else(|| BillingError::new("invalid_scope"))?
            .to_owned();
        let outcome:Result<Value>=async{
            let kind=s(&work,"kind")?;
            let result=if kind=="event"{if let Some(events)=&self.0.options.events{events.deliver(work["payload"].clone()).await?;}json!({"delivered":true})}
            else if kind=="workflow_timeout"{let this=self.clone();let payload=work["payload"].clone();let customer=customer.clone();self.atomic(scope,move|tx|Box::pin(async move{this.0.ledger.materialize(tx).await?;this.workflow_timeout(tx,&customer,s(&payload,"workflowId")?,opt(&payload,"token")).await?;Ok(Value::Null)})).await?;json!({"checked":true})}
            else if kind=="webhook"{let provider=self.0.options.provider.as_ref().ok_or_else(||BillingError::new("provider_missing"))?;let event:ProviderEvent=serde_json::from_value(work["payload"]["event"].clone()).map_err(|_|BillingError::new("invalid_provider_event"))?;let event=provider.reconcile(event).await?;self.apply_provider_event(scope,event).await?;json!({"applied":true})}
            else{
                let provider=self.0.options.provider.as_ref().ok_or_else(||BillingError::new("provider_missing"))?;require(self.now()-n(&work,"createdAt")?<=23*60*60000,"reconciliation_required")?;
                let mut input=work["payload"].clone();if kind=="auto_topup"{input["plan"]=self.plan(s(&input,"planId")?,None).await?;}
                let mut skip=false;if kind=="meter"{let counter=format!("meter-export:{}",s(&input,"meterKey")?);let checkpoint=self.atomic(scope,move|tx|Box::pin(async move{Ok(get(tx,Table::Counters,&counter).await?.unwrap_or(json!({"minor":"0","generation":0})))})).await?;input["previousMinor"]=checkpoint["minor"].clone();skip=n(&input,"generation")?<=n(&checkpoint,"generation")?;}
                if skip{json!({"skipped":true})}else{
                    let this=self.clone();let customer_id=customer.clone();let customer=self.atomic(scope,move|tx|Box::pin(async move{this.customer(tx,&customer_id).await})).await?;
                    provider.execute(PaymentCommand{id:self.provider_identity(scope,s(&work,"id")?)?,kind:kind.into(),customer,input,resources:self.0.resources.clone()}).await?
                }
            };
            if let Some(event)=result.get("providerEvent"){let event:ProviderEvent=serde_json::from_value(event.clone()).map_err(|_|BillingError::new("invalid_provider_event"))?;self.apply_provider_event(scope,event).await?;}
            let this=self.clone();let finish_id=id.to_owned();let owner=token.clone();let finished=work.clone();let output=result.clone();let customer=customer.clone();
            self.atomic(scope,move|tx|Box::pin(async move{
                let mut current=get(tx,Table::Work,&finish_id).await?.ok_or_else(||BillingError::new("operation_not_found"))?;require(opt(&current,"leaseOwner")==Some(owner.as_str()),"lease_lost")?;
                if !matches!(opt(&finished,"kind"),Some("event"|"workflow_timeout")){put(tx,Table::Counters,"provider-lane",json!({"owner":owner,"until":0}),"active").await?;}
                if opt(&finished,"kind")==Some("meter")&&output.get("exportedMinor").is_some(){put(tx,Table::Counters,&format!("meter-export:{}",s(&finished["payload"],"meterKey")?),json!({"minor":output["exportedMinor"],"generation":finished["payload"]["generation"]}),"active").await?;}
                current["status"]=json!("done");current["result"]=output.clone();current.as_object_mut().unwrap().remove("leaseUntil");put(tx,Table::Work,&finish_id,current,"done").await?;
                if let Some(linked)=opt(&output,"stripeCustomerId"){let mut c=this.customer(tx,&customer).await?;require(opt(&c,"stripeCustomerId").is_none_or(|old|old==linked),"customer_mapping_conflict")?;c["stripeCustomerId"]=json!(linked);put(tx,Table::Customers,s(&c,"id")?,c.clone(),"active").await?;}
                if opt(&finished,"kind")==Some("webhook"){let event=&finished["payload"]["event"];put(tx,Table::Inbox,s(event,"id")?,event.clone(),"done").await?;}Ok(Value::Null)
            })).await?;Ok(result)
        }.await;
        match outcome {
            Ok(_) => Ok(true),
            Err(e) if e.code == "interrupted" => Err(e),
            Err(e) => {
                let this = self.clone();
                let id = id.to_owned();
                let owner = token;
                let kind = s(&work, "kind")?.to_owned();
                self.atomic(scope, move |tx| {
                    Box::pin(async move {
                        let mut current = get(tx, Table::Work, &id)
                            .await?
                            .ok_or_else(|| BillingError::new("operation_not_found"))?;
                        if opt(&current, "leaseOwner") != Some(owner.as_str()) {
                            return Ok(Value::Null);
                        }
                        if !matches!(kind.as_str(), "event" | "workflow_timeout") {
                            put(
                                tx,
                                Table::Counters,
                                "provider-lane",
                                json!({"owner":owner,"until":0}),
                                "active",
                            )
                            .await?;
                        }
                        let state = if e.code == "reconciliation_required" {
                            "reconciliation"
                        } else {
                            "failed"
                        };
                        current["status"] = json!(state);
                        current["error"] = json!(e.code);
                        current["availableAt"] = json!(
                            this.now()
                                + 1000_i64
                                    .saturating_mul(
                                        2_i64.saturating_pow(n(&current, "attempts")? as u32)
                                    )
                                    .min(3600000)
                        );
                        current.as_object_mut().unwrap().remove("leaseUntil");
                        put(tx, Table::Work, &id, current, state).await?;
                        Ok(Value::Null)
                    })
                })
                .await?;
                Ok(false)
            }
        }
    }
    pub(crate) async fn maintenance_run(&self, p: Value) -> Result<Value> {
        let limit = match p.get("limit") {
            None => 100,
            Some(v) => v
                .as_u64()
                .filter(|v| *v > 0 && *v <= 1000)
                .ok_or_else(|| BillingError::new("invalid_limit"))?,
        } as usize;
        let cursor = if let Some(cursor) = opt(&p, "cursor") {
            cursor.into()
        } else {
            let v = self
                .atomic(&self.catalog_scope(), |tx| {
                    Box::pin(async {
                        Ok(get(tx, Table::Counters, "maintenance-cursor")
                            .await?
                            .unwrap_or(json!({"cursor":""})))
                    })
                })
                .await?;
            s(&v, "cursor")?.to_owned()
        };
        let scopes = if let Some(customer) = opt(&p, "customerId") {
            vec![self.scope(customer)?]
        } else {
            self.0
                .storage
                .scopes(
                    Some(&cursor),
                    limit as u32,
                    &format!("{}:c:", self.0.options.environment.name()),
                )
                .await?
        };
        let mut processed = 0;
        let mut more = false;
        let mut last = cursor;
        for scope in &scopes {
            last = scope.clone();
            let this = self.clone();
            let customer = scope[(self.0.options.environment.name().len() + 3)..].to_owned();
            self.atomic(scope, move |tx| {
                Box::pin(async move {
                    this.0.ledger.materialize(tx).await?;
                    if let Some(c) = get(tx, Table::Customers, &customer).await?
                        && let Some(t) = c["controls"].get("autoTopUp")
                    {
                        this.after_usage(tx, &customer, s(t, "feature")?, None)
                            .await?;
                    }
                    Ok(Value::Null)
                })
            })
            .await?;
            let now = self.now();
            let candidates = self
                .atomic(scope, move |tx| {
                    Box::pin(async move {
                        let mut ids = Vec::new();
                        for state in [
                            "processing",
                            "internal_pending",
                            "internal_failed",
                            "meter_pending",
                            "meter_failed",
                            "pending",
                            "failed",
                        ] {
                            for row in tx
                                .page(
                                    Table::Work,
                                    PageQuery {
                                        limit: limit as u32,
                                        state: Some(state.into()),
                                        due_before: Some(now),
                                        ..Default::default()
                                    },
                                )
                                .await?
                            {
                                let w = row.data;
                                if matches!(
                                    opt(&w, "status"),
                                    Some("pending" | "failed" | "processing")
                                ) && n(&w, "availableAt")? <= now
                                    && w["leaseUntil"].as_i64().unwrap_or(0) <= now
                                {
                                    ids.push(row.id);
                                }
                            }
                        }
                        Ok(json!(ids))
                    })
                })
                .await?;
            for id in candidates.as_array().unwrap() {
                if processed >= limit {
                    more = true;
                    break;
                }
                self.run_work(
                    scope,
                    id.as_str()
                        .ok_or_else(|| BillingError::new("invalid_record"))?,
                )
                .await?;
                processed += 1;
            }
            if processed >= limit {
                more = true;
                break;
            }
        }
        let next = if scopes.len() == limit || more {
            last
        } else {
            String::new()
        };
        if p.get("customerId").is_none() && p.get("cursor").is_none() {
            let cursor = next.clone();
            self.atomic(&self.catalog_scope(), move |tx| {
                Box::pin(async move {
                    put(
                        tx,
                        Table::Counters,
                        "maintenance-cursor",
                        json!({"cursor":cursor}),
                        "active",
                    )
                    .await?;
                    Ok(Value::Null)
                })
            })
            .await?;
        }
        Ok(json!({"processed":processed,"more":more||scopes.len()==limit,"cursor":next}))
    }
}
