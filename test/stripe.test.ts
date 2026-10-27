import { expect, test } from "bun:test";
import Stripe from "stripe";
import type { PaymentCommand } from "../src/index.js";
import { stripeProvider } from "../src/stripe.js";

function fixture(respond: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
      return Response.json(
        url.includes("/customers/cus_a")
          ? {
              id: "cus_a",
              livemode: false,
              metadata: {
                brokeboy_customer: "a",
                brokeboy_environment: "test",
              },
            }
          : respond(url, init),
      );
    },
    { preconnect: () => {} },
  );
  const client = new Stripe("sk_test_fixture_only", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(fetcher),
  });
  return {
    client,
    calls,
    provider: stripeProvider({
      client,
      webhookSecret: "whsec_fixture",
      cryptoProvider: Stripe.createSubtleCryptoProvider(),
    }),
  };
}
async function signed(client: Stripe, object: unknown, type: string) {
  const payload = JSON.stringify({
    id: "evt_fixture",
    object: "event",
    livemode: false,
    type,
    data: { object },
  });
  const signature = await client.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: "whsec_fixture",
  });
  return new Request("https://example.test/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });
}
test("async Checkout fulfillment retrieves paid state and canonical quantity", async () => {
  const metadata = {
    brokeboy_customer: "a",
    brokeboy_environment: "test",
    brokeboy_plan: "pack",
    brokeboy_version: "version",
    brokeboy_purchase: "purchase",
    brokeboy_quantity: "2",
  };
  const { client, provider } = fixture(() => ({
    id: "cs_fixture",
    mode: "payment",
    payment_status: "paid",
    metadata,
  }));
  const event = await provider.verify(
    await signed(
      client,
      { id: "cs_fixture", metadata },
      "checkout.session.async_payment_succeeded",
    ),
  );
  expect(event).not.toBeNull();
  const fulfilled = await provider.reconcile(event!);
  expect(fulfilled.type).toBe("purchase.paid");
  expect(fulfilled.data.purchaseId).toBe("purchase");
  expect(fulfilled.data.quantity).toBe("2");
});
test("invalid webhook signatures fail closed", async () => {
  const { provider } = fixture(() => ({}));
  await expect(
    provider.verify(
      new Request("https://example.test", {
        method: "POST",
        headers: { "stripe-signature": "invalid" },
        body: "{}",
      }),
    ),
  ).rejects.toMatchObject({ code: "invalid_signature" });
});
test("disputes resolve customer identity through the charge", async () => {
  const { client, provider } = fixture((url) =>
    url.includes("/charges/")
      ? { id: "ch_a", customer: "cus_a", metadata: {} }
      : {
          id: "cus_a",
          metadata: { brokeboy_customer: "a", brokeboy_environment: "test" },
        },
  );
  const event = await provider.verify(
    await signed(
      client,
      { id: "dp_a", charge: "ch_a" },
      "charge.dispute.created",
    ),
  );
  expect(event?.customerId).toBe("a");
});
test("pack checkout records identical purchase identity on all payment objects", async () => {
  const { provider, calls } = fixture(() => ({
    id: "cs_a",
    url: "https://checkout.stripe.com/a",
  }));
  const command: PaymentCommand = {
    id: "operation",
    kind: "checkout",
    customer: {
      id: "a",
      stripeCustomerId: "cus_a",
      metadata: {},
      controls: {},
    },
    input: {
      plan: {
        id: "pack",
        name: "Pack",
        version: "version",
        revision: 1,
        stripePriceId: "price_pack",
        kind: "one_time",
        items: [],
      },
      quantity: "2",
      successUrl: "https://example.test",
    },
  };
  await provider.execute(command);
  const body = calls.find((call) =>
    call.url.includes("/checkout/sessions"),
  )!.body;
  expect(body.get("line_items[0][quantity]")).toBe("2");
  for (const prefix of [
    "metadata",
    "payment_intent_data[metadata]",
    "invoice_creation[invoice_data][metadata]",
  ])
    expect(body.get(`${prefix}[brokeboy_purchase]`)).toBe("operation");
});
test("meter exports cumulative rounding differences rather than rounding each event", async () => {
  const { provider, calls } = fixture((url) =>
    url.includes("/subscriptions/")
      ? {
          id: "sub_a",
          customer: "cus_a",
          metadata: { brokeboy_environment: "test" },
          items: { data: [{ price: { id: "price_a" } }] },
        }
      : url.includes("/prices/")
        ? {
            id: "price_a",
            currency: "usd",
            unit_amount: 1,
            recurring: { usage_type: "metered", meter: "meter_a" },
          }
        : url.includes("/meters/")
          ? {
              id: "meter_a",
              event_name: "credits",
              customer_mapping: { event_payload_key: "stripe_customer_id" },
              value_settings: { event_payload_key: "value" },
            }
          : { identifier: "event" },
  );
  const result = await provider.execute({
    id: "operation",
    kind: "meter",
    customer: {
      id: "a",
      stripeCustomerId: "cus_a",
      metadata: {},
      controls: {},
    },
    input: {
      subscriptionId: "sub_a",
      priceId: "price_a",
      currency: "usd",
      total: "0.015",
      previousMinor: "1",
      periodEnd: Date.now() + 10000,
    },
  });
  expect(result).toMatchObject({ exportedMinor: "2" });
  expect(calls.at(-1)!.body.get("payload[value]")).toBe("1");
});
