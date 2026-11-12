#![cfg(feature = "sqlite")]
use brokeboy::{
    Billing, BillingOptions,
    provider::{PaymentCommand, PaymentProvider, ProviderEvent},
    sql::SqlStorage,
    storage::{BillingFuture, Clock},
};
use brokeboy_core::{
    BillingError,
    schema::{Dialect, migration_sql},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
};

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
struct Notifications;
impl PaymentProvider for Notifications {
    fn execute(&self, _: PaymentCommand) -> BillingFuture<'_, Value> {
        Box::pin(async { Err(BillingError::new("fixture_only")) })
    }
    fn verify(
        &self,
        _: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> BillingFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move { Ok(Some(serde_json::from_slice(&body).unwrap())) })
    }
    fn reconcile(&self, event: ProviderEvent) -> BillingFuture<'_, ProviderEvent> {
        Box::pin(async move { Ok(event) })
    }
}
async fn setup() -> (Billing, Arc<TestClock>) {
    setup_provider(Arc::new(Notifications)).await
}
async fn setup_provider(provider: Arc<dyn PaymentProvider>) -> (Billing, Arc<TestClock>) {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    for sql in migration_sql(Dialect::Sqlite) {
        sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
            .execute(&pool)
            .await
            .unwrap();
    }
    let clock = Arc::new(TestClock(AtomicI64::new(1_800_000_000_000)));
    let billing = Billing::from_storage(
        Arc::new(SqlStorage::owned(pool)),
        BillingOptions {
            provider: Some(provider),
            clock: clock.clone(),
            ..Default::default()
        },
    );
    billing
        .call(
            "customers.create",
            json!({"id":"account","stripeCustomerId":"cus_adopted","idempotencyKey":"customer"}),
        )
        .await
        .unwrap();
    (billing, clock)
}
async fn notify(b: &Billing, id: &str, kind: &str, data: Value) {
    let event = json!({"id":id,"type":kind,"customerId":"account","data":data});
    b.webhook(BTreeMap::new(), serde_json::to_vec(&event).unwrap())
        .await
        .unwrap();
    b.call("maintenance.run", json!({"customerId":"account"}))
        .await
        .unwrap();
}
async fn balance(b: &Billing) -> Value {
    b.call(
        "credits.balance",
        json!({"customerId":"account","feature":"wallet"}),
    )
    .await
    .unwrap()
}
async fn fund(b: &Billing, amount: &str) {
    b.call("credits.grant",json!({"customerId":"account","feature":"wallet","amount":amount,"origin":"purchase","sourceId":"purchase","idempotencyKey":"fund"})).await.unwrap();
}

#[tokio::test]
async fn cumulative_refunds_disputes_and_compensations_are_idempotent() {
    let (b, _) = setup().await;
    fund(&b, "10").await;
    let refund = json!({"purchaseId":"purchase","paidMinor":1000,"refundedMinor":250});
    notify(&b, "refund-1", "purchase.adjusted", refund.clone()).await;
    assert_eq!(balance(&b).await["available"], "7.5");
    notify(&b, "refund-1", "purchase.adjusted", refund.clone()).await;
    notify(
        &b,
        "refund-duplicate-notification",
        "purchase.adjusted",
        refund,
    )
    .await;
    assert_eq!(balance(&b).await["available"], "7.5");
    let withdrawn = json!({"purchaseId":"purchase","paidMinor":1000,"refundedMinor":250,"dispute":{"id":"dp_partial","amount":200,"reinstated":false}});
    notify(&b, "withdraw", "purchase.adjusted", withdrawn.clone()).await;
    assert_eq!(balance(&b).await["available"], "5.5");
    notify(&b, "withdraw-retry", "purchase.adjusted", withdrawn.clone()).await;
    let mut restored = withdrawn.clone();
    restored["dispute"]["reinstated"] = json!(true);
    notify(&b, "reinstated", "purchase.adjusted", restored.clone()).await;
    notify(
        &b,
        "old-withdrawal-delivered-late",
        "purchase.adjusted",
        withdrawn,
    )
    .await;
    notify(&b, "reinstated-duplicate", "purchase.adjusted", restored).await;
    assert_eq!(balance(&b).await["available"], "7.5");
    // A refund which has failed no longer contributes to canonical cumulative refunds.
    notify(
        &b,
        "refund-failed",
        "purchase.adjusted",
        json!({"purchaseId":"purchase","paidMinor":1000,"refundedMinor":0}),
    )
    .await;
    assert_eq!(balance(&b).await["available"], "10");
    // Reinstatement arriving before withdrawal never causes a temporary double credit.
    notify(&b,"reinstatement-first","purchase.adjusted",json!({"purchaseId":"purchase","paidMinor":1000,"refundedMinor":0,"dispute":{"id":"dp_reordered","amount":100,"reinstated":true}})).await;
    notify(&b,"withdrawal-last","purchase.adjusted",json!({"purchaseId":"purchase","paidMinor":1000,"refundedMinor":0,"dispute":{"id":"dp_reordered","amount":100,"reinstated":false}})).await;
    assert_eq!(balance(&b).await["available"], "10");
    assert_eq!(
        b.call("credits.reconcile", json!({"customerId":"account"}))
            .await
            .unwrap()["consistent"],
        true
    );
    b.close().await.unwrap();
}

#[tokio::test]
async fn spent_or_held_credit_creates_a_durable_shortfall_without_negative_balance() {
    let (b, clock) = setup().await;
    fund(&b, "10").await;
    b.call(
        "usage.consume",
        json!({"customerId":"account","feature":"wallet","amount":"8","idempotencyKey":"spent"}),
    )
    .await
    .unwrap();
    let held=b.call("reservations.create",json!({"customerId":"account","feature":"wallet","amount":"1","expiresAt":clock.now()+1000,"idempotencyKey":"hold"})).await.unwrap();
    let reversal = json!({"purchaseId":"purchase","paidMinor":1000,"refundedMinor":500});
    notify(&b, "refund", "purchase.adjusted", reversal.clone()).await;
    assert_eq!(balance(&b).await["available"], "0");
    let work = b
        .call("operations.list", json!({"customerId":"account"}))
        .await
        .unwrap();
    assert!(
        work.as_array()
            .unwrap()
            .iter()
            .any(|w| w["kind"] == "payment_adjustment"
                && w["payload"]["shortfall"] == "4"
                && w["status"] == "reconciliation")
    );
    b.call(
        "reservations.release",
        json!({"customerId":"account","reservationId":held["id"],"idempotencyKey":"release"}),
    )
    .await
    .unwrap();
    notify(&b, "refund-followup", "purchase.adjusted", reversal).await;
    assert_eq!(balance(&b).await["available"], "0");
    notify(
        &b,
        "refund-reversed",
        "purchase.adjusted",
        json!({"purchaseId":"purchase","paidMinor":1000,"refundedMinor":0}),
    )
    .await;
    assert_eq!(balance(&b).await["available"], "2");
    b.close().await.unwrap();
}

#[tokio::test]
async fn adopted_customers_and_unmatched_events_are_durable() {
    let (b, _) = setup().await;
    fund(&b, "10").await;
    let event = json!({"id":"adopted","type":"purchase.adjusted","customerId":"","data":{"provider":"stripe","providerCustomerId":"cus_adopted","purchaseId":"purchase","paidMinor":1000,"refundedMinor":100}});
    b.webhook(BTreeMap::new(), serde_json::to_vec(&event).unwrap())
        .await
        .unwrap();
    b.call("maintenance.run", json!({"customerId":"account"}))
        .await
        .unwrap();
    assert_eq!(balance(&b).await["available"], "9");
    let event = json!({"id":"unmatched","type":"purchase.adjusted","customerId":"","data":{"provider":"stripe","providerCustomerId":"cus_unknown"}});
    assert_eq!(
        b.webhook(BTreeMap::new(), serde_json::to_vec(&event).unwrap())
            .await
            .unwrap()["requiresReview"],
        true
    );
    let review = b.call("operations.unmatched", json!({})).await.unwrap();
    assert_eq!(review.as_array().unwrap().len(), 1);
    assert_eq!(review[0]["id"], "unmatched");
    b.close().await.unwrap();
}

#[tokio::test]
async fn periods_count_live_holds_and_preserve_settled_receipts() {
    let (b, clock) = setup().await;
    b.call("periods.create",json!({"customerId":"account","periodId":"month","currency":"usd","start":clock.now(),"end":clock.now()+10000,"status":"active","included":100,"markupBasisPoints":500,"overageCap":106,"idempotencyKey":"period"})).await.unwrap();
    let reserve = json!({"customerId":"account","periodId":"month","reservationId":"r","cost":200,"expiresAt":clock.now()+1000,"idempotencyKey":"reserve"});
    b.call("periods.reserve", reserve.clone()).await.unwrap();
    assert_eq!(
        b.call("periods.reserve", reserve).await.unwrap()["cost"],
        200
    );
    assert_eq!(b.call("periods.reserve",json!({"customerId":"account","periodId":"month","reservationId":"other","cost":1,"expiresAt":clock.now()+1000,"idempotencyKey":"blocked"})).await.unwrap_err().code,"billing_hold");
    let settle = json!({"customerId":"account","periodId":"month","reservationId":"r","sourceId":"report","cost":180,"idempotencyKey":"settle"});
    let receipt = b.call("periods.settle", settle.clone()).await.unwrap();
    assert_eq!(receipt["charge"], 84);
    assert_eq!(b.call("periods.settle", settle).await.unwrap(), receipt);
    let period = b
        .call(
            "periods.get",
            json!({"customerId":"account","periodId":"month"}),
        )
        .await
        .unwrap();
    assert_eq!(period["reserved"], 0);
    assert_eq!(period["charged"], 84);
    let source = json!({"customerId":"account","periodId":"month","sourceId":"zero-cost-report","cost":0,"idempotencyKey":"source-receipt"});
    let receipt = b.call("periods.settle", source.clone()).await.unwrap();
    let mut replay = source;
    replay["idempotencyKey"] = json!("source-receipt-new-request");
    assert_eq!(b.call("periods.settle", replay).await.unwrap(), receipt);
    for status in [
        "grace",
        "billing-hold",
        "ended",
        "manual",
        "pending",
        "active",
    ] {
        b.call("periods.setStatus",json!({"customerId":"account","periodId":"month","status":status,"reason":"test transition","idempotencyKey":status})).await.unwrap();
        let check = b
            .call(
                "periods.check",
                json!({"customerId":"account","periodId":"month"}),
            )
            .await
            .unwrap();
        assert_eq!(
            check["allowed"],
            matches!(status, "manual" | "pending" | "active")
        );
    }
    assert_eq!(
        b.call(
            "periods.get",
            json!({"customerId":"account","periodId":"month"})
        )
        .await
        .unwrap()["charged"],
        84
    );
    b.close().await.unwrap();
}

#[tokio::test]
async fn streams_hold_estimates_settle_actuals_and_bill_abandoned_estimates_once() {
    let (b, clock) = setup().await;
    fund(&b, "1").await;
    let input = json!({"customerId":"account","feature":"wallet","amount":"0.6","expiresAt":clock.now()+3600000,"onExpiry":"settle_estimate","idempotencyKey":"stream"});
    let mut competing = input.clone();
    competing["idempotencyKey"] = json!("competing-stream");
    let (first, second) = tokio::join!(
        b.call("reservations.create", input.clone()),
        b.call("reservations.create", competing.clone())
    );
    let (input, r) = match (first, second) {
        (Ok(r), Err(error)) => {
            assert_eq!(error.code, "insufficient_balance");
            (input, r)
        }
        (Err(error), Ok(r)) => {
            assert_eq!(error.code, "insufficient_balance");
            (competing, r)
        }
        _ => panic!("Exactly one concurrent stream must acquire the available estimate"),
    };
    assert_eq!(b.call("reservations.create", input).await.unwrap(), r);
    assert_eq!(b.call("reservations.create",json!({"customerId":"account","feature":"wallet","amount":"0.6","idempotencyKey":"parallel"})).await.unwrap_err().code,"insufficient_balance");
    let settle = json!({"customerId":"account","reservationId":r["id"],"amount":"0.25","idempotencyKey":"actual"});
    b.call("reservations.settle", settle.clone()).await.unwrap();
    b.call("reservations.settle", settle).await.unwrap();
    assert_eq!(balance(&b).await["available"], "0.75");
    let r=b.call("reservations.create",json!({"customerId":"account","feature":"wallet","amount":"0.3","expiresAt":clock.now()+3600000,"onExpiry":"settle_estimate","idempotencyKey":"abandoned"})).await.unwrap();
    clock.0.fetch_add(3600001, Ordering::SeqCst);
    b.call("maintenance.run", json!({"customerId":"account"}))
        .await
        .unwrap();
    b.call("maintenance.run", json!({"customerId":"account"}))
        .await
        .unwrap();
    assert_eq!(balance(&b).await["available"], "0.45");
    assert_eq!(b.call("reservations.settle",json!({"customerId":"account","reservationId":r["id"],"amount":"0.1","idempotencyKey":"late-actual"})).await.unwrap()["status"],"reconciliation");
    assert_eq!(balance(&b).await["available"], "0.45");
    assert_eq!(
        b.call("credits.reconcile", json!({"customerId":"account"}))
            .await
            .unwrap()["consistent"],
        true
    );
    b.close().await.unwrap();
}

struct DelayedNotification {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    first: std::sync::atomic::AtomicBool,
}
impl PaymentProvider for DelayedNotification {
    fn execute(&self, _: PaymentCommand) -> BillingFuture<'_, Value> {
        Box::pin(async { Err(BillingError::new("fixture_only")) })
    }
    fn verify(
        &self,
        _: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> BillingFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move { Ok(Some(serde_json::from_slice(&body).unwrap())) })
    }
    fn reconcile(&self, mut event: ProviderEvent) -> BillingFuture<'_, ProviderEvent> {
        Box::pin(async move {
            if self.first.swap(false, Ordering::SeqCst) {
                self.entered.notify_one();
                self.release.notified().await;
                event.data["refundedMinor"] = json!(100);
            } else {
                event.data["refundedMinor"] = json!(200);
            }
            Ok(event)
        })
    }
}
#[tokio::test]
async fn expired_provider_worker_cannot_rewind_a_newer_financial_snapshot() {
    let provider = Arc::new(DelayedNotification {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        first: std::sync::atomic::AtomicBool::new(true),
    });
    let (b, clock) = setup_provider(provider.clone()).await;
    fund(&b, "10").await;
    let event = json!({"id":"delayed","type":"purchase.adjusted","customerId":"account","data":{"purchaseId":"purchase","paidMinor":1000,"refundedMinor":100}});
    b.webhook(BTreeMap::new(), serde_json::to_vec(&event).unwrap())
        .await
        .unwrap();
    let worker = b.clone();
    let first = tokio::spawn(async move {
        worker
            .call("maintenance.run", json!({"customerId":"account"}))
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        provider.entered.notified(),
    )
    .await
    .unwrap();
    clock.0.fetch_add(120001, Ordering::SeqCst);
    b.call("maintenance.run", json!({"customerId":"account"}))
        .await
        .unwrap();
    assert_eq!(balance(&b).await["available"], "8");
    provider.release.notify_one();
    first.await.unwrap().unwrap();
    assert_eq!(balance(&b).await["available"], "8");
    b.close().await.unwrap();
}

struct Purchases(std::sync::atomic::AtomicUsize);
impl PaymentProvider for Purchases {
    fn execute(&self, command: PaymentCommand) -> BillingFuture<'_, Value> {
        Box::pin(async move {
            assert_eq!(command.kind, "auto_topup");
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"id":"invoice"}))
        })
    }
    fn verify(
        &self,
        _: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> BillingFuture<'_, Option<ProviderEvent>> {
        Box::pin(async move { Ok(Some(serde_json::from_slice(&body).unwrap())) })
    }
    fn reconcile(&self, event: ProviderEvent) -> BillingFuture<'_, ProviderEvent> {
        Box::pin(async move { Ok(event) })
    }
}
#[tokio::test]
async fn accepted_credit_notifications_cancel_unstarted_topups_and_restore_purchase_capacity() {
    let provider = Arc::new(Purchases(std::sync::atomic::AtomicUsize::new(0)));
    let (b, clock) = setup_provider(provider.clone()).await;
    b.catalog().publish(json!({"expectedRevision":0,"catalog":{"features":[{"id":"wallet","kind":"consumable"}],"plans":[{"id":"pack","name":"Credit pack","kind":"one_time","amount":"1","currency":"usd","items":[{"feature":"wallet","included":"10"}]}]}})).await.unwrap();
    b.billing_controls().update(json!({"customerId":"account","idempotencyKey":"controls","controls":{"autoTopUp":{"feature":"wallet","below":"5","packPlan":"pack","maximumPurchases":1}}})).await.unwrap();
    // A delayed payment or renewal was durably accepted after the top-up was queued.
    let event = json!({"id":"credit-confirmed","type":"prepaid.imported","customerId":"account","data":{"providerCustomerId":"cus_adopted","feature":"wallet","creditCents":1000}});
    b.webhook(BTreeMap::new(), serde_json::to_vec(&event).unwrap())
        .await
        .unwrap();
    b.maintenance()
        .run(json!({"customerId":"account"}))
        .await
        .unwrap();
    clock.0.fetch_add(3000, Ordering::SeqCst);
    b.maintenance()
        .run(json!({"customerId":"account"}))
        .await
        .unwrap();
    assert_eq!(provider.0.load(Ordering::SeqCst), 0);
    assert_eq!(balance(&b).await["available"], "10");
    let work = b
        .operations()
        .list(json!({"customerId":"account"}))
        .await
        .unwrap();
    assert!(work.iter().any(|w| w.kind == "auto_topup"
        && w.status == brokeboy_core::models::WorkStatus::Done
        && w.result.as_ref().is_some_and(|v| v["skipped"] == true)));
    b.usage()
        .consume(
            json!({"customerId":"account","feature":"wallet","amount":"7","idempotencyKey":"use"}),
        )
        .await
        .unwrap();
    let mut workers = Vec::new();
    for _ in 0..8 {
        let worker = b.clone();
        workers.push(tokio::spawn(async move {
            worker
                .maintenance()
                .run(json!({"customerId":"account"}))
                .await
                .unwrap()
        }));
    }
    for worker in workers {
        worker.await.unwrap();
    }
    assert_eq!(provider.0.load(Ordering::SeqCst), 1);
    clock.0.fetch_add(120001, Ordering::SeqCst);
    b.maintenance()
        .run(json!({"customerId":"account"}))
        .await
        .unwrap();
    assert_eq!(provider.0.load(Ordering::SeqCst), 1);
    assert_eq!(balance(&b).await["available"], "3");
    b.close().await.unwrap();
}

#[tokio::test]
async fn overlapping_refund_and_dispute_excess_remains_a_reconciliation_case() {
    let (b, _) = setup().await;
    fund(&b, "10").await;
    notify(
        &b,
        "full-refund",
        "purchase.adjusted",
        json!({"purchaseId":"purchase","paidMinor":1000,"refundedMinor":1000}),
    )
    .await;
    notify(&b,"overlapping-dispute","purchase.adjusted",json!({"purchaseId":"purchase","paidMinor":1000,"refundedMinor":1000,"dispute":{"id":"du_overlap","amount":200,"reinstated":false}})).await;
    assert_eq!(balance(&b).await["available"], "0");
    let work = b
        .call("operations.list", json!({"customerId":"account"}))
        .await
        .unwrap();
    assert!(
        work.as_array()
            .unwrap()
            .iter()
            .any(|w| w["payload"]["uncoveredMinor"] == "200" && w["status"] == "reconciliation")
    );
    notify(&b,"dispute-reinstated","purchase.adjusted",json!({"purchaseId":"purchase","paidMinor":1000,"refundedMinor":1000,"dispute":{"id":"du_overlap","amount":200,"reinstated":true}})).await;
    assert_eq!(balance(&b).await["available"], "0");
    assert_eq!(
        b.credits()
            .reconcile(json!({"customerId":"account"}))
            .await
            .unwrap()["consistent"],
        true
    );
    b.close().await.unwrap();
}

#[tokio::test]
async fn variants_publish_inherited_snapshots_without_moving_existing_customers() {
    let (b, _) = setup().await;
    let mut catalog = json!({"features":[{"id":"wallet","kind":"consumable"}],"plans":[{"id":"pro","name":"Pro","kind":"free","items":[{"feature":"wallet","included":"10","reset":"month"}],"variants":[{"id":"pro-annual","overrides":{"name":"Annual","interval":"year"}}]}]});
    b.call(
        "catalog.publish",
        json!({"catalog":catalog,"expectedRevision":0}),
    )
    .await
    .unwrap();
    let old = b
        .call("catalog.get", json!({"id":"pro-annual"}))
        .await
        .unwrap();
    assert_eq!(old["basePlanId"], "pro");
    assert_eq!(old["items"][0]["included"], "10");
    assert_eq!(
        b.call("catalog.diff", catalog.clone()).await.unwrap()["changes"],
        json!([])
    );
    b.call(
        "subscriptions.attach",
        json!({"customerId":"account","planId":"pro-annual","idempotencyKey":"attach-variant"}),
    )
    .await
    .unwrap();
    catalog["plans"][0]["items"][0]["included"] = json!("20");
    let changes = b.call("catalog.diff", catalog.clone()).await.unwrap();
    assert_eq!(changes["changes"].as_array().unwrap().len(), 2);
    b.call(
        "catalog.publish",
        json!({"catalog":catalog,"expectedRevision":1}),
    )
    .await
    .unwrap();
    let new = b
        .call("catalog.get", json!({"id":"pro-annual"}))
        .await
        .unwrap();
    assert_ne!(new["version"], old["version"]);
    assert_eq!(new["items"][0]["included"], "20");
    assert_eq!(
        b.call("subscriptions.list", json!({"customerId":"account"}))
            .await
            .unwrap()[0]["plan"]["version"],
        old["version"]
    );
    let exported = b.call("catalog.export", json!({})).await.unwrap();
    assert_eq!(
        b.call("catalog.diff", exported).await.unwrap()["changes"],
        json!([])
    );
    catalog["plans"][0]["variants"][0]["id"] = json!("pro");
    assert_eq!(
        b.call("catalog.validate", catalog.clone())
            .await
            .unwrap_err()
            .code,
        "duplicate_plan"
    );
    catalog["plans"][0]["variants"][0]["id"] = json!("pro-annual");
    catalog["plans"][0]["variants"][0]["overrides"]["version"] = json!("forged");
    assert_eq!(
        b.call("catalog.validate", catalog).await.unwrap_err().code,
        "invalid_variant_override"
    );
}
