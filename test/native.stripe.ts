// Run with Node or Bun against the compiled addon. All HTTP traffic stays on loopback.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { Billing as PublicBilling } from "../dist/native.js";

type Handle = {
  registerRequest(id: string): void;
  call(method: string, input: string, id: string): Promise<string>;
  webhook(headers: string, body: Buffer, id: string): Promise<string>;
  close(): Promise<void>;
};
const { NativeBilling } = createRequire(import.meta.url)(
  "../target/debug/brokeboy.node",
) as { NativeBilling: { open(options: string): Promise<Handle> } };
async function call(h: Handle, method: string, input: unknown) {
  const id = randomUUID();
  h.registerRequest(id);
  return JSON.parse(await h.call(method, JSON.stringify(input), id));
}
async function webhook(
  h: Handle,
  id: string,
  type: string,
  object: unknown,
  tamper = false,
) {
  const raw = JSON.stringify({ id, type, livemode: false, data: { object } });
  const now = Math.floor(Date.now() / 1000);
  const hash = createHmac("sha256", "whsec_fixture")
    .update(`${now}.`)
    .update(raw)
    .digest("hex");
  const billing = Reflect.construct(PublicBilling, [
    h,
    "test",
  ]) as PublicBilling;
  return billing.webhook(
    new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${now},v1=${hash}` },
      body: Buffer.from(tamper ? `${raw} ` : raw),
    }),
  );
}
test("native Stripe HTTP preserves intents, verifies paid state, deduplicates and compensates refunds", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "brokeboy-stripe-native-"));
  let handle: Handle | undefined;
  const calls: {
    path: string;
    body: URLSearchParams;
    key: string | undefined;
  }[] = [];
  const state = {
    customer: {} as Record<string, string>,
    product: {} as Record<string, string>,
    purchase: {} as Record<string, string>,
    paid: false,
    failures: 2,
  };
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const path = new URL(request.url!, "http://localhost").pathname;
      assert.equal(request.headers["stripe-version"], "2026-09-30.endive");
      calls.push({
        path,
        body,
        key: request.headers["idempotency-key"] as string | undefined,
      });
      const metadata = () =>
        Object.fromEntries(
          [...body]
            .filter(([k]) => /^metadata\[[^\]]+\]$/.test(k))
            .map(([k, v]) => [k.slice(9, -1), v]),
        );
      let value: unknown;
      if (path === "/v1/customers" && request.method === "POST") {
        // A single SQL connection is configured below: this callback proves HTTP
        // requests run after the durable intent transaction has released it.
        await call(handle!, "customers.get", { customerId: "native" });
        state.customer = metadata();
        value = { id: "cus_native", livemode: false, metadata: state.customer };
      } else if (path === "/v1/customers/cus_native")
        value = { id: "cus_native", livemode: false, metadata: state.customer };
      else if (path === "/v1/products" && request.method === "POST") {
        state.product = metadata();
        value = { id: "prod_native", livemode: false, metadata: state.product };
      } else if (path === "/v1/products/prod_native")
        value = { id: "prod_native", livemode: false, metadata: state.product };
      else if (path === "/v1/prices" && request.method === "POST")
        value = { id: "price_native", livemode: false };
      else if (path === "/v1/checkout/sessions") {
        state.purchase = metadata();
        if (state.failures-- > 0) {
          response.writeHead(500, {
            "content-type": "application/json",
            "request-id": "req_fixture",
          });
          response.end(
            JSON.stringify({ error: { message: "Synthetic lost response" } }),
          );
          return;
        }
        value = { id: "cs_native", url: "https://checkout.stripe.com/fixture" };
      } else if (path === "/v1/checkout/sessions/cs_native")
        value = {
          id: "cs_native",
          mode: "payment",
          payment_status: state.paid ? "paid" : "unpaid",
          metadata: state.purchase,
        };
      else if (path === "/v1/invoices/in_native")
        value = {
          id: "in_native",
          status: "paid",
          customer: "cus_native",
          currency: "usd",
          metadata: state.purchase,
        };
      else if (path === "/v1/payment_intents/pi_native")
        value = {
          id: "pi_native",
          customer: "cus_native",
          currency: "usd",
          metadata: state.purchase,
        };
      else if (path === "/v1/refunds")
        value =
          request.method === "POST"
            ? { id: "re_native", status: "succeeded" }
            : {
                data: [
                  {
                    id: "re_native",
                    charge: "ch_native",
                    amount: 1000,
                    status: "succeeded",
                  },
                ],
                has_more: false,
              };
      else if (path === "/v1/charges/ch_native")
        value = {
          id: "ch_native",
          livemode: false,
          customer: "cus_native",
          payment_intent: "pi_native",
          amount: 1000,
          amount_refunded: 1000,
          metadata: state.purchase,
        };
      else
        throw new Error(
          `Unexpected Stripe fixture route: ${request.method} ${path}`,
        );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    })().catch((error) => {
      errors.push(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Fixture assertion failed" } }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
    const path = resolve(directory, "billing.sqlite");
    const seeded = spawnSync("bun", ["scripts/seed-native-fixture.ts", path], {
      encoding: "utf8",
    });
    assert.equal(seeded.status, 0, seeded.stderr);
    handle = await NativeBilling.open(
      JSON.stringify({
        database: {
          driver: "sqlite",
          url: `sqlite://${path}`,
          maxConnections: 1,
        },
        stripe: {
          secretKey: "sk_test_fixture_only",
          webhookSecret: "whsec_fixture",
          apiBase: `http://127.0.0.1:${address.port}/v1`,
        },
      }),
    );
    await call(handle, "catalog.publish", {
      expectedRevision: 0,
      catalog: {
        features: [{ id: "budget", kind: "consumable" }],
        plans: [
          {
            id: "pack",
            name: "Pack",
            kind: "one_time",
            amount: "5.00",
            currency: "usd",
            items: [{ feature: "budget", included: "25" }],
          },
        ],
      },
    });
    const checkout = {
      customerId: "native",
      planId: "pack",
      quantity: "2",
      successUrl: "https://example.test/success",
      idempotencyKey: "checkout",
    };
    const failed = await call(handle, "subscriptions.checkout", checkout);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "provider_error");
    const retry = await call(handle, "operations.retry", {
      customerId: "native",
      operationId: failed.id,
      idempotencyKey: "retry",
    });
    assert.equal(retry.status, "done");
    assert.equal(retry.result.id, "cs_native");
    const attempts = calls.filter((c) => c.path === "/v1/checkout/sessions");
    assert.equal(attempts.length, 3);
    assert.equal(new Set(attempts.map((c) => c.key)).size, 1);
    const params = attempts[0]!.body;
    assert.equal(params.get("line_items[0][quantity]"), "2");
    assert.equal(
      params.get("metadata[brokeboy_purchase]"),
      params.get("payment_intent_data[metadata][brokeboy_purchase]"),
    );
    assert.equal(
      params.get("metadata[brokeboy_purchase]"),
      params.get("invoice_creation[invoice_data][metadata][brokeboy_purchase]"),
    );
    assert.equal(
      (
        await call(handle, "credits.balance", {
          customerId: "native",
          feature: "budget",
        })
      ).available,
      "0",
    );
    await assert.rejects(
      webhook(
        handle,
        "evt_bad",
        "checkout.session.completed",
        { id: "cs_native", metadata: state.purchase },
        true,
      ),
      /invalid_signature/,
    );
    await webhook(handle, "evt_unpaid", "checkout.session.completed", {
      id: "cs_native",
      metadata: state.purchase,
    });
    await call(handle, "maintenance.run", { customerId: "native" });
    assert.equal(
      (
        await call(handle, "credits.balance", {
          customerId: "native",
          feature: "budget",
        })
      ).available,
      "0",
    );
    state.paid = true;
    await webhook(
      handle,
      "evt_paid",
      "checkout.session.async_payment_succeeded",
      { id: "cs_native", metadata: state.purchase },
    );
    await webhook(handle, "evt_invoice", "invoice.paid", {
      id: "in_native",
      metadata: state.purchase,
    });
    await webhook(
      handle,
      "evt_paid",
      "checkout.session.async_payment_succeeded",
      { id: "cs_native", metadata: state.purchase },
    );
    await call(handle, "maintenance.run", { customerId: "native" });
    assert.equal(
      (
        await call(handle, "credits.balance", {
          customerId: "native",
          feature: "budget",
        })
      ).available,
      "50",
    );
    await call(handle, "usage.consume", {
      customerId: "native",
      feature: "budget",
      amount: "4",
      idempotencyKey: "spend",
    });
    const refunded = await call(handle, "commerce.refund", {
      customerId: "native",
      paymentIntentId: "pi_native",
      amount: "2.50",
      reason: "Fixture refund",
      idempotencyKey: "refund",
    });
    assert.equal(refunded.status, "done");
    assert.equal(
      calls.find((c) => c.path === "/v1/refunds")!.body.get("amount"),
      "250",
    );
    await webhook(handle, "evt_refund", "charge.refunded", {
      id: "ch_native",
      metadata: state.purchase,
    });
    await call(handle, "maintenance.run", { customerId: "native" });
    assert.equal(
      (
        await call(handle, "credits.balance", {
          customerId: "native",
          feature: "budget",
        })
      ).available,
      "0",
    );
    assert.equal(
      (await call(handle, "usage.list", { customerId: "native" }))[0].quantity,
      "4",
    );
    assert.equal(
      (await call(handle, "credits.reconcile", { customerId: "native" }))
        .consistent,
      true,
    );
    const operations = await call(handle, "operations.list", {
      customerId: "native",
    });
    assert.ok(
      operations.some(
        (w: { kind: string; status: string }) =>
          w.kind === "payment_adjustment" && w.status === "reconciliation",
      ),
    );
    const plan = await call(handle, "catalog.get", { id: "pack" });
    const resource = await call(handle, "resources.inspect", {
      key: `product:${plan.version}`,
    });
    assert.equal(resource.id, "prod_native");
    const resolved = await call(handle, "resources.reconcile", {
      key: `product:${plan.version}`,
      id: "prod_native",
      reason: "Verified fixture mapping",
    });
    assert.equal(resolved.resolution, "Verified fixture mapping");
    assert.deepEqual(errors, []);
  } finally {
    await handle?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("native prepaid checkout, opening balances, adoption and cumulative reversals use canonical Stripe state", async () => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "brokeboy-prepaid-native-"),
  );
  let handle: Handle | undefined;
  const errors: unknown[] = [];
  const state = {
    credit: 375,
    paid: false,
    metadata: {} as Record<string, string>,
    refunded: 0,
    refundStatus: "succeeded",
  };
  let sourceDebit: Record<string, unknown> | undefined;
  let sourceDebitCalls = 0;
  const sourceDebitKeys = new Set<string | undefined>();
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const params = new URLSearchParams(Buffer.concat(chunks).toString());
      const path = new URL(request.url!, "http://localhost").pathname;
      let value: unknown;
      if (path === "/v1/customers/cus_existing")
        value = {
          id: "cus_existing",
          livemode: false,
          currency: "usd",
          balance: -state.credit,
          metadata: {},
        };
      else if (path === "/v1/customers/cus_existing/balance_transactions") {
        if (request.method === "POST") {
          sourceDebitCalls++;
          sourceDebitKeys.add(
            request.headers["idempotency-key"] as string | undefined,
          );
          sourceDebit ||= {
            id: "cbtxn_opening",
            amount: 375,
            ending_balance: 0,
            currency: "usd",
            metadata: {
              brokeboy_opening_balance: params.get(
                "metadata[brokeboy_opening_balance]",
              ),
            },
          };
          assert.equal(params.get("amount"), "375");
          state.credit = 0;
          if (sourceDebitCalls === 1) {
            response.writeHead(500);
            response.end("{}");
            return;
          }
          value = sourceDebit;
        } else
          value = { data: sourceDebit ? [sourceDebit] : [], has_more: false };
      } else if (
        path === "/v1/checkout/sessions" &&
        request.method === "POST"
      ) {
        assert.equal(
          params.get("line_items[0][price_data][unit_amount]"),
          "125",
        );
        assert.equal(params.get("allowed_payment_method_types[0]"), "card");
        assert.equal(params.get("payment_method_types[0]"), null);
        assert.equal(
          params.get("payment_method_options[card][request_three_d_secure]"),
          "any",
        );
        state.metadata = Object.fromEntries(
          [...params]
            .filter(([k]) => /^metadata\[[^\]]+\]$/.test(k))
            .map(([k, v]) => [k.slice(9, -1), v]),
        );
        value = {
          id: "cs_prepaid",
          url: "https://checkout.stripe.com/fixture",
        };
      } else if (path === "/v1/checkout/sessions/cs_prepaid")
        value = {
          id: "cs_prepaid",
          customer: "cus_existing",
          mode: "payment",
          currency: "usd",
          amount_total: 125,
          payment_status: state.paid ? "paid" : "unpaid",
          metadata: state.metadata,
          payment_intent: {
            id: "pi_prepaid",
            status: "succeeded",
            amount_received: 125,
            latest_charge: {
              id: "ch_prepaid",
              paid: true,
              captured: true,
              amount_captured: 125,
              currency: "usd",
            },
          },
        };
      else if (path === "/v1/charges/ch_prepaid")
        value = {
          id: "ch_prepaid",
          customer: "cus_existing",
          livemode: false,
          amount: 125,
          payment_intent: "pi_prepaid",
          metadata: state.metadata,
        };
      else if (path === "/v1/payment_intents/pi_prepaid")
        value = {
          id: "pi_prepaid",
          customer: "cus_existing",
          metadata: state.metadata,
        };
      else if (path === "/v1/refunds")
        value = {
          data: state.refunded
            ? [
                {
                  id: "re_partial",
                  charge: "ch_prepaid",
                  amount: state.refunded,
                  status: state.refundStatus,
                },
              ]
            : [],
          has_more: false,
        };
      else throw new Error(`Unexpected prepaid fixture route ${path}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    })().catch((error) => {
      errors.push(error);
      response.writeHead(500);
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const path = resolve(directory, "billing.sqlite");
    const seeded = spawnSync("bun", ["scripts/seed-native-fixture.ts", path], {
      encoding: "utf8",
    });
    assert.equal(seeded.status, 0, seeded.stderr);
    handle = await NativeBilling.open(
      JSON.stringify({
        database: {
          driver: "sqlite",
          url: `sqlite://${path}`,
          maxConnections: 1,
        },
        environment: "test",
        stripe: {
          secretKey: "sk_test_fixture_only",
          webhookSecret: "whsec_fixture",
          apiBase: `http://127.0.0.1:${address.port}/v1`,
        },
      }),
    );
    const adoption = {
      customerId: "prepaid",
      stripeCustomerId: "cus_existing",
      idempotencyKey: "adopt",
    };
    assert.equal(
      (await call(handle, "migration.adoptStripeCustomer", adoption)).dryRun,
      true,
    );
    await assert.rejects(
      call(handle, "customers.get", { customerId: "prepaid" }),
      /customer_not_found/,
    );
    await call(handle, "migration.adoptStripeCustomer", {
      ...adoption,
      dryRun: false,
    });
    await call(handle, "migration.adoptStripeCustomer", {
      ...adoption,
      dryRun: false,
    });
    const opening = {
      customerId: "prepaid",
      feature: "wallet",
      idempotencyKey: "opening-preview",
    };
    assert.equal(
      (await call(handle, "migration.importStripeBalance", opening)).result
        .creditCents,
      375,
    );
    const balance = async () =>
      (
        await call(handle!, "credits.balance", {
          customerId: "prepaid",
          feature: "wallet",
        })
      ).available;
    assert.equal(await balance(), "0");
    const apply = {
      ...opening,
      expectedCreditCents: 375,
      externalSpendingDisabled: true,
      dryRun: false,
      idempotencyKey: "opening-apply",
    };
    assert.equal(
      (await call(handle, "migration.importStripeBalance", apply)).status,
      "done",
    );
    await call(handle, "migration.importStripeBalance", {
      ...apply,
      idempotencyKey: "opening-replayed-different-key",
    });
    assert.equal(await balance(), "3.75");
    assert.equal(
      state.credit,
      0,
      "Opening credit must no longer be spendable at its old source",
    );
    assert.equal(sourceDebitCalls, 2);
    assert.equal(sourceDebitKeys.size, 1);
    await call(handle, "customers.create", {
      id: "alias",
      stripeCustomerId: "cus_existing",
      idempotencyKey: "alias",
    });
    const rejected = await call(handle, "migration.importStripeBalance", {
      customerId: "alias",
      feature: "wallet",
      expectedCreditCents: 375,
      externalSpendingDisabled: true,
      dryRun: false,
      idempotencyKey: "alias-import",
    });
    assert.equal(rejected.error, "customer_mapping_conflict");
    assert.equal(sourceDebitCalls, 2);
    const checkout = {
      customerId: "prepaid",
      feature: "wallet",
      amountCents: 125,
      successUrl: "https://app.test/success",
      paymentMethodTypes: ["card"],
      requestThreeDSecure: "any",
      idempotencyKey: "checkout",
    };
    assert.equal(
      (await call(handle, "prepaid.checkout", checkout)).status,
      "done",
    );
    const deliver = async (id: string, type: string, object: unknown) => {
      await webhook(handle!, id, type, object);
      await call(handle!, "maintenance.run", { customerId: "prepaid" });
    };
    await deliver("prepaid-unpaid", "checkout.session.completed", {
      id: "cs_prepaid",
      customer: "cus_existing",
    });
    assert.equal(await balance(), "3.75");
    state.paid = true;
    await deliver(
      "prepaid-delayed-paid",
      "checkout.session.async_payment_succeeded",
      { id: "cs_prepaid", customer: "cus_existing" },
    );
    await deliver(
      "prepaid-delayed-paid",
      "checkout.session.async_payment_succeeded",
      { id: "cs_prepaid", customer: "cus_existing" },
    );
    await deliver(
      "prepaid-reordered-completion",
      "checkout.session.completed",
      { id: "cs_prepaid", customer: "cus_existing" },
    );
    assert.equal(await balance(), "5");
    state.refunded = 50;
    await deliver("partial", "charge.refunded", {
      id: "ch_prepaid",
      customer: "cus_existing",
      amount_refunded: 125,
    });
    await deliver("partial-duplicate", "refund.updated", {
      id: "re_partial",
      charge: "ch_prepaid",
    });
    assert.equal(await balance(), "4.5");
    state.refundStatus = "failed";
    await deliver("failed-refund", "refund.failed", {
      id: "re_partial",
      charge: "ch_prepaid",
    });
    assert.equal(await balance(), "5");
    await deliver("withdraw", "charge.dispute.funds_withdrawn", {
      id: "dp_prepaid",
      charge: "ch_prepaid",
      amount: 25,
    });
    assert.equal(await balance(), "4.75");
    await deliver("restore", "charge.dispute.funds_reinstated", {
      id: "dp_prepaid",
      charge: "ch_prepaid",
      amount: 25,
    });
    await deliver("withdraw-late", "charge.dispute.funds_withdrawn", {
      id: "dp_prepaid",
      charge: "ch_prepaid",
      amount: 25,
    });
    assert.equal(await balance(), "5");
    assert.equal(
      (await call(handle, "credits.reconcile", { customerId: "prepaid" }))
        .consistent,
      true,
    );
    const foreign = {
      ...adoption,
      customerId: "other",
      dryRun: false,
      idempotencyKey: "conflicting-adoption",
    };
    await assert.rejects(
      call(handle, "migration.adoptStripeCustomer", foreign),
      /customer_mapping_conflict/,
    );
    assert.deepEqual(errors, []);
  } finally {
    await handle?.close();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
