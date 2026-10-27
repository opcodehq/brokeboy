import assert from "node:assert/strict";
import Stripe from "stripe";
import { brokeboy, defineCatalog } from "../src/index.js";
import { memoryAdapter } from "../src/memory.js";
import { stripeProvider } from "../src/stripe.js";

const key = process.env.STRIPE_SECRET_KEY;
if (!key || !/^(sk|rk)_test_/.test(key))
  throw new Error("Set a test-mode STRIPE_SECRET_KEY. Live keys are rejected.");
const stripe = new Stripe(key, { maxNetworkRetries: 1 });
const id = `sandbox-${crypto.randomUUID()}`,
  secret = `fixture-${crypto.randomUUID()}`;
const billing = brokeboy({
  database: memoryAdapter(),
  provider: stripeProvider({
    client: stripe,
    webhookSecret: secret,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  }),
});
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
  ],
});
await billing.catalog.publish({ catalog, expectedRevision: 0 });
let customerId: string | undefined,
  subscriptionId: string | undefined,
  sessionId: string | undefined;
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
  await stripe.paymentMethods.attach("pm_card_visa", { customer: customerId });
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: "pm_card_visa" },
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
  const plan = await billing.catalog.get(id);
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: price.id }],
    default_payment_method: "pm_card_visa",
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
  async function deliver(sub: Stripe.Subscription, eventId: string) {
    const payload = JSON.stringify({
      id: eventId,
      object: "event",
      type: "customer.subscription.updated",
      livemode: false,
      data: { object: sub },
    });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret,
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
  if (process.env.STRIPE_TEST_CLOCK_ADVANCE === "true") {
    const end = subscription.items.data[0]!.current_period_end;
    await stripe.testHelpers.testClocks.advance(clock.id, {
      frozen_time: end + 60,
    });
    for (let attempt = 0; attempt < 45; attempt++) {
      if (
        (await stripe.testHelpers.testClocks.retrieve(clock.id)).status ===
        "ready"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const renewed = await stripe.subscriptions.retrieve(subscription.id, {
      expand: ["latest_invoice"],
    });
    assert.equal((renewed.latest_invoice as Stripe.Invoice).status, "paid");
    await deliver(renewed, `evt_${crypto.randomUUID()}`);
  }
  assert.equal((await billing.credits.reconcile(id)).consistent, true);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "checkout creation",
        "test invoice paid",
        "signed fixture ingestion using real subscription state",
        "allowance provisioning",
        "usage",
        "ledger reconciliation",
      ],
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
}
