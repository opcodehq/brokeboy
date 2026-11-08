import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";
import { migrationSQL } from "../src/drizzle.js";
import { brokeboy, defineCatalog } from "../src/index.js";
import { memoryAdapter } from "../src/memory.js";
import { Billing as NativeBilling } from "../src/native.js";
import { loadNative } from "../src/native-loader.js";
import { stripeProvider } from "../src/stripe.js";

const key = process.env.STRIPE_SECRET_KEY;
if (!key || !/^(sk|rk)_test_/.test(key))
  throw new Error("Set a test-mode STRIPE_SECRET_KEY. Live keys are rejected.");
const stripe = new Stripe(key, { maxNetworkRetries: 1 });
const id = `sandbox-${crypto.randomUUID()}`,
  secret = `fixture-${crypto.randomUUID()}`;
let now = Date.now();
const provider = stripeProvider({
  client: stripe,
  webhookSecret: secret,
  cryptoProvider: Stripe.createSubtleCryptoProvider(),
});
const nativeContext =
  process.env.BROKEBOY_SANDBOX_ENGINE === "rust"
    ? await (async () => {
        const directory = await mkdtemp(
          join(tmpdir(), "brokeboy-stripe-native-"),
        );
        const path = join(directory, "billing.sqlite");
        const db = new Database(path, { create: true });
        try {
          for (const sql of migrationSQL("sqlite")) db.exec(sql);
        } finally {
          db.close();
        }
        try {
          const handle = await loadNative().NativeBilling.open(
            JSON.stringify({
              database: { driver: "sqlite", url: `sqlite://${path}` },
              environment: "test",
              testClockMs: now,
              stripe: { secretKey: key, webhookSecret: secret },
            }),
          );
          // Internal qualification hook: deterministic time is deliberately absent from the public SDK.
          const billing = Reflect.construct(NativeBilling, [
            handle,
            "test",
          ]) as NativeBilling;
          return {
            billing,
            tick: (time: number) =>
              (
                handle as typeof handle & { setTestClock(time: number): void }
              ).setTestClock(time),
            close: async () => {
              await billing.close();
              await rm(directory, { recursive: true, force: true });
            },
          };
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          throw error;
        }
      })()
    : undefined;
const billing =
  nativeContext?.billing ??
  brokeboy({
    now: () => now,
    database: memoryAdapter(),
    provider: {
      ...provider,
      execute: async (command) => {
        try {
          return await provider.execute(command);
        } catch (error) {
          console.error(
            "Sandbox provider failure:",
            error instanceof Error
              ? error.message.replaceAll(key, "[REDACTED]")
              : "unknown",
          );
          throw error;
        }
      },
    },
  });
const races = process.env.STRIPE_TEST_RACES === "true";
const packId = `${id}-pack`;
const catalog = defineCatalog({
  features: [{ id: "credits", kind: "consumable" }],
  plans: [
    {
      id,
      name: "Brokeboy sandbox fixture",
      amount: "1",
      currency: "usd",
      interval: "month",
      items: [{ feature: "credits", included: "100", reset: "month" }],
    },
    ...(races
      ? [
          {
            id: packId,
            name: "Sandbox top-up pack",
            kind: "one_time" as const,
            amount: "1",
            currency: "usd",
            items: [{ feature: "credits", included: "10" }],
          },
        ]
      : []),
  ],
});
await billing.catalog.publish({ catalog, expectedRevision: 0 });
let customerId: string | undefined,
  subscriptionId: string | undefined,
  sessionId: string | undefined,
  priceId: string | undefined,
  productId: string | undefined,
  packProductId: string | undefined,
  packPriceId: string | undefined;
const clock = await stripe.testHelpers.testClocks.create({
  frozen_time: Math.floor(Date.now() / 1000),
  name: id,
});
try {
  const customer = await stripe.customers.create({
    test_clock: clock.id,
    metadata: { brokeboy_customer: id, brokeboy_environment: "test" },
  });
  customerId = customer.id;
  const paymentMethod = await stripe.paymentMethods.attach("pm_card_visa", {
    customer: customerId,
  });
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethod.id },
  });
  await billing.customers.create({
    id,
    stripeCustomerId: customerId,
    idempotencyKey: "customer",
  });
  const checkout = await billing.subscriptions.checkout({
    customerId: id,
    planId: id,
    successUrl: "https://example.com/success",
    idempotencyKey: "checkout",
  });
  assert.equal(checkout.status, "done");
  sessionId = (checkout.result as { id: string }).id;
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["line_items"],
  });
  const price = session.line_items?.data[0]?.price;
  assert(price);
  priceId = price.id;
  productId =
    typeof price.product === "string" ? price.product : price.product.id;
  const plan = await billing.catalog.get(id);
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: price.id }],
    default_payment_method: paymentMethod.id,
    metadata: {
      brokeboy_customer: id,
      brokeboy_environment: "test",
      brokeboy_plan: id,
      brokeboy_version: plan.version,
    },
    expand: ["latest_invoice"],
  });
  subscriptionId = subscription.id;
  assert.equal((subscription.latest_invoice as Stripe.Invoice).status, "paid");
  async function deliver(
    sub: Stripe.Subscription | Stripe.Invoice,
    eventId: string,
    type = "customer.subscription.updated",
  ) {
    const payload = JSON.stringify({
      id: eventId,
      object: "event",
      type,
      livemode: false,
      data: { object: sub },
    });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret,
      ...(nativeContext ? { timestamp: Math.floor(now / 1000) } : {}),
    });
    await billing.webhook(
      new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "stripe-signature": signature },
        body: payload,
      }),
    );
    await billing.maintenance.run();
  }
  await deliver(subscription, `evt_${crypto.randomUUID()}`);
  if (
    (await billing.credits.balance({ customerId: id, feature: "credits" }))
      .available !== "100"
  ) {
    console.log(
      "Allowance diagnostic",
      JSON.stringify(
        (await billing.operations.list(id)).map((work) => ({
          kind: work.kind,
          status: work.status,
          error: work.error,
          details: Reflect.get(work, "errorDetails"),
        })),
      ),
    );
  }
  assert.equal(
    (await billing.credits.balance({ customerId: id, feature: "credits" }))
      .available,
    "100",
  );
  await billing.usage.consume({
    customerId: id,
    feature: "credits",
    amount: "25",
    idempotencyKey: "consume",
  });
  assert.equal(
    (await billing.credits.balance({ customerId: id, feature: "credits" }))
      .available,
    "75",
  );
  if (races) {
    await billing.billingControls.update({
      customerId: id,
      idempotencyKey: "enable-topup",
      controls: {
        autoTopUp: {
          feature: "credits",
          below: "70",
          packPlan: packId,
          maximumPurchases: 1,
        },
      },
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        billing.usage.consume({
          customerId: id,
          feature: "credits",
          amount: "1",
          idempotencyKey: `race-${i}`,
        }),
      ),
    );
    await Promise.all(
      Array.from({ length: 8 }, () =>
        billing.maintenance.run({ customerId: id, limit: 100 }),
      ),
    );
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: 100,
    });
    const topups = invoices.data.filter(
      (invoice) => invoice.metadata?.brokeboy_topup_counter,
    );
    assert.equal(
      topups.length,
      1,
      "Concurrent maintenance must purchase one top-up",
    );
    assert.equal(topups[0]!.status, "paid");
    const invoice = topups[0]!;
    await Promise.all([
      deliver(invoice, "evt_topup_a", "invoice.paid"),
      deliver(invoice, "evt_topup_b", "invoice.paid"),
      deliver(invoice, "evt_topup_a", "invoice.paid"),
    ]);
    await billing.maintenance.run({ customerId: id });
    assert.equal(
      (await billing.credits.balance({ customerId: id, feature: "credits" }))
        .available,
      "65",
    );
    const pack = await billing.catalog.get(packId);
    packPriceId = (await billing.resources.inspect(`price:${pack.version}`))
      ?.id;
    packProductId = (await billing.resources.inspect(`product:${pack.version}`))
      ?.id;
  }
  if (process.env.STRIPE_TEST_CLOCK_ADVANCE === "true") {
    const end = subscription.items.data[0]!.current_period_end;
    async function advanceClock(target: number) {
      await stripe.testHelpers.testClocks.advance(clock.id, {
        frozen_time: target,
      });
      let ready = false;
      for (let attempt = 0; attempt < 180; attempt++) {
        if (
          (await stripe.testHelpers.testClocks.retrieve(clock.id)).status ===
          "ready"
        ) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert(ready, "Stripe test clock did not finish advancing");
      now = target * 1000;
      nativeContext?.tick(now);
    }
    await advanceClock(end + 60);
    // Renewal invoices have a draft interval before automatic collection.
    await advanceClock(end + 2 * 60 * 60);
    const renewed = await stripe.subscriptions.retrieve(subscription.id, {
      expand: ["latest_invoice"],
    });
    assert.equal((renewed.latest_invoice as Stripe.Invoice).status, "paid");
    assert(renewed.items.data[0]!.current_period_start >= end);
    if (races) {
      await Promise.all([
        deliver(renewed, "evt_renewal_a"),
        deliver(renewed, "evt_renewal_b"),
        billing.maintenance.run({ customerId: id, limit: 100 }),
      ]);
      await billing.maintenance.run({ customerId: id, limit: 100 });
      const invoices = await stripe.invoices.list({
        customer: customerId,
        limit: 100,
      });
      assert.equal(
        invoices.data.filter(
          (invoice) => invoice.metadata?.brokeboy_topup_counter,
        ).length,
        1,
        "Renewal notifications must not create an unnecessary new top-up",
      );
    } else await deliver(renewed, `evt_${crypto.randomUUID()}`);
    assert.equal(
      (await billing.credits.balance({ customerId: id, feature: "credits" }))
        .available,
      races ? "110" : "100",
    );
  }
  assert.equal((await billing.credits.reconcile(id)).consistent, true);
  console.log(
    JSON.stringify({
      passed: true,
      engine: nativeContext ? "rust" : "typescript",
      checks: [
        "checkout creation",
        "test invoice paid",
        "signed fixture ingestion using real subscription state",
        "allowance provisioning",
        "usage",
        "ledger reconciliation",
        ...(process.env.STRIPE_TEST_CLOCK_ADVANCE === "true"
          ? ["test-clock paid renewal and renewed allowance"]
          : []),
      ],
      racesQualified: races,
      clockAdvanced: process.env.STRIPE_TEST_CLOCK_ADVANCE === "true",
      note: "This does not verify delivery from a registered public webhook endpoint.",
    }),
  );
} finally {
  if (sessionId)
    await stripe.checkout.sessions.expire(sessionId).catch(() => {});
  if (subscriptionId)
    await stripe.subscriptions.cancel(subscriptionId).catch(() => {});
  if (customerId) await stripe.customers.del(customerId).catch(() => {});
  await stripe.testHelpers.testClocks.del(clock.id).catch(() => {});
  if (priceId)
    await stripe.prices.update(priceId, { active: false }).catch(() => {});
  if (productId)
    await stripe.products.update(productId, { active: false }).catch(() => {});
  if (packPriceId)
    await stripe.prices.update(packPriceId, { active: false }).catch(() => {});
  if (packProductId)
    await stripe.products
      .update(packProductId, { active: false })
      .catch(() => {});
  await nativeContext?.close();
}
