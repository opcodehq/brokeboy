// Real Stripe test-clock qualification through the native Rust adapter.
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Stripe from "stripe";
import { migrationSQL } from "../src/drizzle.js";
import { loadNative, type NativeHandle } from "../src/native-loader.js";

const key = process.env.STRIPE_SECRET_KEY;
if (!key || !/^(sk|rk)_test_/.test(key))
  throw new Error("Test-mode Stripe credentials required.");
const stripe = new Stripe(key, { maxNetworkRetries: 1 });
const directory = await mkdtemp(join(tmpdir(), "brokeboy-meter-"));
const now = Math.floor(Date.now() / 1000);
const fixture = `meter-${randomUUID()}`;
const clock = await stripe.testHelpers.testClocks.create({
  frozen_time: now,
  name: fixture,
});
let customerId: string | undefined;
let subscriptionId: string | undefined;
let productId: string | undefined;
let meterId: string | undefined;
const prices: string[] = [];
let handle: NativeHandle | undefined;
const call = async (method: string, input: unknown) => {
  assert.ok(handle);
  const id = randomUUID();
  handle.registerRequest(id);
  return JSON.parse(await handle.call(method, JSON.stringify(input), id));
};
const wait = async <T>(
  name: string,
  read: () => Promise<T | undefined>,
  timeout = 180_000,
): Promise<T> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await read();
    if (value !== undefined) return value;
    console.log(`Waiting for Stripe ${name}`);
    await Bun.sleep(5000);
  }
  throw new Error(
    `Stripe ${name} was not observed within the qualification window`,
  );
};
try {
  const customer = await stripe.customers.create({
    test_clock: clock.id,
    metadata: { brokeboy_customer: fixture, brokeboy_environment: "test" },
  });
  customerId = customer.id;
  const payment = await stripe.paymentMethods.attach("pm_card_visa", {
    customer: customer.id,
  });
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: payment.id },
  });
  const product = await stripe.products.create({
    name: "Native metered qualification",
  });
  productId = product.id;
  const meter = await stripe.billing.meters.create({
    display_name: fixture,
    event_name: fixture.replaceAll("-", "_"),
    default_aggregation: { formula: "sum" },
    customer_mapping: {
      type: "by_id",
      event_payload_key: "stripe_customer_id",
    },
    value_settings: { event_payload_key: "value" },
  });
  meterId = meter.id;
  const base = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 100,
    recurring: { interval: "month" },
  });
  prices.push(base.id);
  const metered = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 1,
    recurring: { interval: "month", usage_type: "metered", meter: meter.id },
  });
  prices.push(metered.id);
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: base.id }, { price: metered.id }],
    payment_behavior: "error_if_incomplete",
    expand: ["latest_invoice"],
  });
  subscriptionId = subscription.id;
  assert.equal((subscription.latest_invoice as Stripe.Invoice).status, "paid");
  const path = join(directory, "billing.sqlite");
  const db = new Database(path, { create: true });
  for (const sql of migrationSQL("sqlite")) db.exec(sql);
  db.close();
  handle = await loadNative().NativeBilling.open(
    JSON.stringify({
      database: { driver: "sqlite", url: `sqlite://${path}` },
      environment: "test",
      testClockMs: now * 1000,
      stripe: { secretKey: key },
    }),
  );
  await call("catalog.publish", {
    expectedRevision: 0,
    catalog: {
      features: [{ id: "requests", kind: "consumable" }],
      plans: [
        {
          id: "metered",
          name: "Metered",
          amount: "1",
          currency: "usd",
          interval: "month",
          stripePriceId: base.id,
          stripeMeterPriceIds: { requests: metered.id },
          items: [
            {
              feature: "requests",
              included: "0",
              overage: true,
              rate: { amount: "0.01" },
            },
          ],
        },
      ],
    },
  });
  await call("customers.create", {
    id: fixture,
    stripeCustomerId: customer.id,
    idempotencyKey: "customer",
  });
  const imported = await call("migration.linkSubscription", {
    customerId: fixture,
    stripeSubscriptionId: subscription.id,
    planId: "metered",
    idempotencyKey: "subscription",
  });
  assert.equal(imported.status, "done", JSON.stringify(imported.errorDetails));
  const receipt = await call("usage.consume", {
    customerId: fixture,
    feature: "requests",
    amount: "5",
    idempotencyKey: "exported",
  });
  assert.equal(receipt.charged, "0.05");
  await call("maintenance.run", { customerId: fixture });
  const exported = await call("operations.list", { customerId: fixture });
  assert.ok(
    exported.some(
      (w: { kind: string; status: string }) =>
        w.kind === "meter" && w.status === "done",
    ),
  );
  // Leave another rated receipt unexported until the previous invoice is finalized.
  await call("usage.consume", {
    customerId: fixture,
    feature: "requests",
    amount: "2",
    idempotencyKey: "late",
  });
  const period = subscription.items.data.find(
    (i) => i.price.id === metered.id,
  )!;
  const end = period.current_period_end;
  await stripe.testHelpers.testClocks.advance(clock.id, {
    frozen_time: end + 300,
  });
  await wait("clock advance", async () =>
    (await stripe.testHelpers.testClocks.retrieve(clock.id)).status === "ready"
      ? true
      : undefined,
  );
  (handle as NativeHandle & { setTestClock(now: number): void }).setTestClock(
    (end + 300) * 1000,
  );
  const invoice = await wait("draft renewal invoice", async () => {
    const page = await stripe.invoices.list({
      subscription: subscription.id,
      limit: 10,
    });
    return page.data.find(
      (i) => i.billing_reason === "subscription_cycle" && i.status === "draft",
    );
  });
  const line = await wait("metered invoice line", async () => {
    const lines = await stripe.invoices.listLineItems(invoice.id!, {
      limit: 100,
    });
    return lines.data.find(
      (l) =>
        l.pricing?.price_details?.price === metered.id &&
        l.amount === 5 &&
        l.quantity === 5,
    );
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id!);
  assert.ok(["open", "paid"].includes(finalized.status!));
  await call("maintenance.run", { customerId: fixture });
  const operations = await call("operations.list", { customerId: fixture });
  const late = operations.find(
    (w: { kind: string; status: string; error?: string }) =>
      w.kind === "meter" &&
      w.status === "reconciliation" &&
      w.error === "reconciliation_required",
  );
  assert.ok(late, "Late export must remain an explicit reconciliation item");
  const evidence = {
    qualifiedAt: new Date().toISOString(),
    engine: "rust",
    realStripe: true,
    invoiceId: finalized.id,
    invoiceStatus: finalized.status,
    meteredLineAmount: line.amount,
    meteredLineQuantity: line.quantity,
    exportedAmount: "0.05",
    lateRatedAmount: "0.02",
    lateExport: "reconciliation",
    ledger: await call("credits.reconcile", { customerId: fixture }),
  };
  await writeFile(
    "target/stripe-meter-evidence.json",
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence));
} catch (error) {
  const message =
    error instanceof Error
      ? error.message.replaceAll(key, "[redacted]")
      : "Unknown sandbox error";
  throw new Error(message);
} finally {
  await handle?.close();
  if (subscriptionId)
    await stripe.subscriptions.cancel(subscriptionId).catch(() => {});
  if (customerId) await stripe.customers.del(customerId).catch(() => {});
  for (const id of prices)
    await stripe.prices.update(id, { active: false }).catch(() => {});
  if (productId)
    await stripe.products.update(productId, { active: false }).catch(() => {});
  if (meterId) await stripe.billing.meters.deactivate(meterId).catch(() => {});
  await stripe.testHelpers.testClocks.del(clock.id).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
