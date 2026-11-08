use super::*;
use crate::{
    ledger::{is_entitled, register_features},
    provider::ProviderEvent,
};
use brokeboy_core::compatibility::hash_v1;
impl Billing {
    pub(crate) async fn apply_provider_event(
        &self,
        scope: &str,
        event: ProviderEvent,
        work_id: &str,
        lease_owner: &str,
    ) -> Result<()> {
        require(
            self.scope(&event.customer_id)? == scope,
            "customer_mapping_conflict",
        )?;
        let data = &event.data;
        let plan = if let Some(plan) = data.get("plan") {
            Some(plan.clone())
        } else if let Some(id) = opt(data, "planId") {
            Some(self.plan(id, opt(data, "planVersion")).await?)
        } else {
            None
        };
        let this = self.clone();
        let scope = scope.to_owned();
        let work_id = work_id.to_owned();
        let lease_owner = lease_owner.to_owned();
        self.atomic(&scope.clone(),move|tx|Box::pin(async move{
            let work=get(tx,Table::Work,&work_id).await?.ok_or_else(||BillingError::new("lease_lost"))?;
            require(opt(&work,"leaseOwner")==Some(lease_owner.as_str()) && opt(&work,"status")==Some("processing"),"lease_lost")?;
            let marker=format!("applied:{}",event.id);if get(tx,Table::Counters,&marker).await?.is_some(){return Ok(Value::Null);}let data=&event.data;
            if let (Some(subscription),Some(plan))=(data.get("subscription"),plan.as_ref()){
                let id=s(subscription,"id")?;let existing=get(tx,Table::Subscriptions,id).await?;
                let pinned=existing.as_ref().filter(|old|data.get("planVersion").is_none() && data.get("plan").is_none() && old["plan"]["id"]==data["planId"]).map(|old|old["plan"].clone()).unwrap_or_else(||plan.clone());
                let plan=&pinned;
                register_features(tx,plan).await?;
                let effective=if data["pending"]==true{existing.as_ref().map(|s|s["plan"].clone()).unwrap_or(plan.clone())}else{plan.clone()};let mut next=subscription.clone();next["plan"]=effective;
                if let Some(meters)=data.get("meterPriceIds"){
                    let mut merged=next["plan"].get("stripeMeterPriceIds").cloned().unwrap_or(json!({}));
                    for (feature,price) in meters.as_object().ok_or_else(||BillingError::new("invalid_provider_event"))? {merged[feature]=price.clone();}
                    next["plan"]["stripeMeterPriceIds"]=merged;
                }
                if let Some(old)=&existing{
                    if old["periodStart"]==next["periodStart"]{
                        copy_optional(&mut next,old,"provisioningOffset");
                        if (old["plan"]["version"]!=next["plan"]["version"]||old["quantity"]!=next["quantity"])&&n(&next,"paidThrough")?>this.now(){
                            let mut until=n(&next,"periodEnd")?;let mut granted=json!({});for g in list(tx,Table::Grants,Some("active")).await?{if opt(&g,"sourceId")==Some(id)&&opt(&g,"origin")==Some("subscription")&&g["expiresAt"].as_i64().unwrap_or(i64::MAX)>this.now(){let f=s(&g,"feature")?;granted[f]=json!(d(granted[f].as_str().map(u).transpose()?.unwrap_or(0)+amount(&g,"amount")?)?);until=until.min(g["expiresAt"].as_i64().unwrap_or(i64::MAX));}}next["provisioningOffset"]=json!({"until":until,"granted":granted});
                        }
                    }
                    next["paidThrough"]=json!(n(old,"paidThrough")?.max(n(&next,"paidThrough")?));
                    if opt(&next,"status")==Some("past_due")&&n(old,"paidThrough")?>0&& let Some(days)=next["plan"]["graceDays"].as_i64(){next["graceThrough"]=json!(n(old,"paidThrough")?+days*86400000);}
                    if opt(old,"status")==Some("trialing")&&opt(&next,"status")==Some("active"){for g in list(tx,Table::Grants,Some("active")).await?{if opt(&g,"sourceId")==Some(id)&&opt(&g,"origin")==Some("subscription"){put(tx,Table::Grants,s(&g,"id")?,g.clone(),"expired").await?;}}}
                }
                if matches!(opt(&next,"status"),Some("active"|"trialing"))&&next["plan"]["addOn"]!=true{
                    for mut old in list(tx,Table::Subscriptions,Some("active")).await?{if opt(&old,"id")!=Some(id)&&old.get("entityId")==next.get("entityId")&&old["plan"]["addOn"]!=true&&opt(&old["plan"],"group").unwrap_or("base")==opt(&next["plan"],"group").unwrap_or("base"){old["status"]=json!("ended");put(tx,Table::Subscriptions,s(&old,"id")?,old.clone(),"ended").await?;}}
                }
                if let Some(meters)=data.get("providerMeterIds") {next["plan"]["providerMeterIds"]=meters.clone();}
                let state=if is_entitled(&next,this.now())?{"active"}else{s(&next,"status")?};put(tx,Table::Subscriptions,id,next.clone(),state).await?;this.0.ledger.materialize(tx).await?;
            }
            if event.kind=="purchase.paid"
                && let Some(plan)=&plan{require(opt(plan,"kind")==Some("one_time"),"invalid_purchase_plan")?;let id=hash_v1(&json!({"purchaseId":data["purchaseId"]}))?;let quantity=opt(data,"quantity").unwrap_or("1");positive(quantity)?;
                    if let Some(old)=get(tx,Table::Subscriptions,&id).await?{require(opt(&old,"quantity")==Some(quantity)&&old["plan"]["version"]==plan["version"],"purchase_conflict")?;}else{let mut purchase=json!({"id":id,"purchaseId":data["purchaseId"],"plan":plan,"status":"active","periodStart":this.now(),"periodEnd":9_007_199_254_740_991_i64,"paidThrough":9_007_199_254_740_991_i64,"quantity":quantity});copy_optional(&mut purchase,data,"entityId");register_features(tx,plan).await?;put(tx,Table::Subscriptions,&id,purchase,"active").await?;}this.0.ledger.materialize(tx).await?;
                    if let Some(counter)=opt(data,"topupCounter")&& let Some(old)=get(tx,Table::Counters,counter).await?&& let Some(pending)=opt(&old,"pending")&& this.provider_identity(&scope,pending)?==s(data,"purchaseId")?{put(tx,Table::Counters,counter,json!({"count":old["count"]}),"active").await?;if get(tx,Table::Counters,"topup-pending").await?.as_ref().and_then(|v|opt(v,"operationId"))==Some(pending){put(tx,Table::Counters,"topup-pending",json!({}),"active").await?;}}
                }
            if event.kind=="payment.reconciliation"{
                if data["stripeEventType"]!="charge.dispute.created" && let Some(purchase)=opt(data,"purchaseId"){for g in list(tx,Table::Grants,Some("active")).await?{if opt(&g,"sourceId")==Some(purchase){put(tx,Table::Grants,s(&g,"id")?,g.clone(),"review").await?;}}}
                let id=this.id();this.enqueue(tx,&id,"payment_adjustment",data.clone()).await?;let mut w=get(tx,Table::Work,&id).await?.unwrap();w["status"]=json!("reconciliation");put(tx,Table::Work,&id,w,"reconciliation").await?;
            }
            if event.kind=="purchase.adjusted" {
                this.purchase_adjustment(tx,&event).await?;
            }
            if matches!(event.kind.as_str(),"prepaid.paid"|"prepaid.imported") {
                this.prepaid_event(tx,&event).await?;
            }
            if event.kind=="purchase.reversed"{
                for mut sub in list(tx,Table::Subscriptions,Some("active")).await?{if sub.get("purchaseId")==data.get("purchaseId"){sub["status"]=json!("ended");put(tx,Table::Subscriptions,s(&sub,"id")?,sub.clone(),"ended").await?;}}
                for g in list(tx,Table::Grants,Some("active")).await?{if g.get("sourceId")==data.get("purchaseId"){let id=s(&g,"id")?;let p=this.0.ledger.position(tx,id).await?;let unused=amount(&g,"amount")?-amount(&p,"spent")?-amount(&p,"held")?;if unused>0{this.0.ledger.movement(tx,id,unused,&event.id,"purchase_refunded",None).await?;}put(tx,Table::Grants,id,g.clone(),"revoked").await?;if amount(&p,"spent")?>0{let id=this.id();this.enqueue(tx,&id,"refund_adjustment",json!({"purchaseId":data["purchaseId"],"spent":p["spent"]})).await?;let mut w=get(tx,Table::Work,&id).await?.unwrap();w["status"]=json!("reconciliation");put(tx,Table::Work,&id,w,"reconciliation").await?;}}}
            }
            put(tx,Table::Counters,&marker,json!({"appliedAt":this.now()}),"active").await?;this.event(tx,&event.customer_id,&event.kind,json!({"providerEventId":event.id})).await?;Ok(Value::Null)
        })).await?;
        Ok(())
    }
}
