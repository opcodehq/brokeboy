// Explicit, merchant-authorized test-mode exercise. Never runs as part of CI.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import Stripe from "stripe";
import { migrationSQL } from "../src/drizzle.js";
import { loadNative, type NativeHandle } from "../src/native-loader.js";

const directory = resolve("target/stripe-public-qualification");
const statePath = resolve(directory, "state.json");
const key = process.env.STRIPE_SECRET_KEY;
if (!key || !/^(sk|rk)_test_/.test(key))
  throw new Error(
    "A test-mode Stripe key is required; live credentials are rejected.",
  );
const stripe = new Stripe(key, { maxNetworkRetries: 1 });
if (
  [
    "inspect",
    "refund",
    "add-refundfailure",
    "refund-failure",
    "add-dispute",
    "add-delayed",
    "win-dispute",
    "opening",
    "maintain",
  ].includes(process.argv[2] || "")
) {
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  if (process.argv[2] === "inspect") {
    for (const checkout of saved.checkouts) {
      const session = await stripe.checkout.sessions.retrieve(checkout.id, {
        expand: ["payment_intent.latest_charge"],
      });
      const intent = session.payment_intent as Stripe.PaymentIntent;
      const charge = intent.latest_charge as Stripe.Charge;
      console.log(
        JSON.stringify({
          scenario: checkout.scenario,
          status: session.payment_status,
          threeDSecure: charge.payment_method_details?.card?.three_d_secure,
        }),
      );
    }
    process.exit(0);
  }
  const database = new URL(process.env.TEST_POSTGRES_URL || "");
  database.searchParams.set("options", `-csearch_path=${saved.schema}`);
  const native = await loadNative().NativeBilling.open(
    JSON.stringify({
      database: { driver: "postgres", url: database.toString() },
      environment: "test",
      stripe: { secretKey: key },
    }),
  );
  try {
    const checkout = saved.checkouts[0];
    const invoke = async (method: string, input: unknown) => {
      const id = randomUUID();
      native.registerRequest(id);
      return JSON.parse(await native.call(method, JSON.stringify(input), id));
    };
    if (process.argv[2]?.startsWith("add-")) {
      const scenario = process.argv[2].slice(4);
      const work = await invoke("prepaid.checkout", {
        customerId: checkout.customerId,
        feature: "wallet",
        amountCents: 100,
        successUrl: `${saved.publicUrl}/complete`,
        paymentMethodTypes: [
          scenario === "delayed" ? "us_bank_account" : "card",
        ],
        idempotencyKey: `public-${scenario}-checkout-${randomUUID()}`,
      });
      if (work.status !== "done")
        throw new Error(
          `Native checkout failure: ${work.error} ${JSON.stringify(work.errorDetails)}`,
        );
      await writeFile(
        resolve(directory, `${scenario}.json`),
        JSON.stringify({ customerId: checkout.customerId, ...work.result }),
        { mode: 0o600 },
      );
      console.log(JSON.stringify({ scenario, ...work.result }));
      process.exitCode = 0;
    } else if (process.argv[2] === "win-dispute") {
      const extra = JSON.parse(
        await readFile(resolve(directory, "dispute.json"), "utf8"),
      );
      const session = await stripe.checkout.sessions.retrieve(extra.id, {
        expand: ["payment_intent.latest_charge"],
      });
      const intent = session.payment_intent as Stripe.PaymentIntent;
      const charge = intent.latest_charge as Stripe.Charge;
      const disputes = await stripe.disputes.list({ charge: charge.id });
      if (disputes.data.length !== 1)
        throw new Error("Expected one fixture dispute");
      const result = await stripe.disputes.update(disputes.data[0]!.id, {
        evidence: { uncategorized_text: "winning_evidence" },
        submit: true,
      });
      console.log(
        JSON.stringify({
          disputeId: result.id,
          status: result.status,
          amount: result.amount,
        }),
      );
    } else if (process.argv[2] === "opening") {
      const original = await stripe.customers.retrieve(
        checkout.stripeCustomerId,
      );
      if (original.deleted) throw new Error("Fixture customer was deleted");
      assert.equal(original.balance, 0);
      await stripe.customers.createBalanceTransaction(
        checkout.stripeCustomerId,
        {
          amount: -375,
          currency: "usd",
          description: "Isolated opening balance qualification",
        },
        { idempotencyKey: `opening-fixture:${saved.schema}` },
      );
      const preview = await invoke("migration.importStripeBalance", {
        customerId: checkout.customerId,
        feature: "wallet",
        idempotencyKey: "opening-preview",
      });
      const input = {
        customerId: checkout.customerId,
        feature: "wallet",
        expectedCreditCents: 375,
        externalSpendingDisabled: true,
        dryRun: false,
        idempotencyKey: "opening-apply",
      };
      const applied = await invoke("migration.importStripeBalance", input);
      assert.equal(
        applied.status,
        "done",
        JSON.stringify(applied.errorDetails),
      );
      await invoke("migration.importStripeBalance", input);
      const replay = await invoke("migration.importStripeBalance", {
        ...input,
        idempotencyKey: "opening-replay",
      });
      assert.equal(replay.status, "done");
      const customer = await stripe.customers.retrieve(
        checkout.stripeCustomerId,
      );
      if (customer.deleted) throw new Error("Fixture customer deleted");
      assert.equal(customer.balance, 0);
      const evidence = {
        realStripe: true,
        engine: "rust",
        dryRunCreditCents: preview.result.creditCents,
        sourceBalance: customer.balance,
        sourceTransactionId: applied.result.sourceTransactionId,
        balance: await invoke("credits.balance", {
          customerId: checkout.customerId,
          feature: "wallet",
        }),
        ledger: await invoke("credits.reconcile", {
          customerId: checkout.customerId,
        }),
      };
      await writeFile(
        resolve(directory, "opening-evidence.json"),
        JSON.stringify(evidence, null, 2),
      );
      console.log(JSON.stringify(evidence));
    } else if (process.argv[2] === "maintain") {
      for (const customer of saved.checkouts) {
        await invoke("maintenance.run", { customerId: customer.customerId });
        console.log(
          JSON.stringify({
            customerId: customer.customerId,
            balance: await invoke("credits.balance", {
              customerId: customer.customerId,
              feature: "wallet",
            }),
            consistent: await invoke("credits.reconcile", {
              customerId: customer.customerId,
            }),
          }),
        );
      }
    } else {
      const refundCheckout =
        process.argv[2] === "refund-failure"
          ? JSON.parse(
              await readFile(resolve(directory, "refundfailure.json"), "utf8"),
            )
          : checkout;
      const session = await stripe.checkout.sessions.retrieve(
        refundCheckout.id,
      );
      const id = randomUUID();
      native.registerRequest(id);
      const result = JSON.parse(
        await native.call(
          "commerce.refund",
          JSON.stringify({
            customerId: checkout.customerId,
            paymentIntentId: session.payment_intent,
            amount: "0.25",
            reason: "Sandbox partial-refund qualification",
            idempotencyKey:
              process.argv[2] === "refund-failure"
                ? "public-failed-refund"
                : "public-partial-refund",
          }),
          id,
        ),
      );
      console.log(
        JSON.stringify({
          status: result.status,
          result: result.result,
          error: result.error,
          details: result.errorDetails,
        }),
      );
    }
  } finally {
    await native.close();
  }
  process.exit(0);
}
if (process.argv[2] === "status") {
  console.log(await readFile(statePath, "utf8"));
  process.exit(0);
}
const publicUrl = process.env.STRIPE_QUALIFICATION_PUBLIC_URL;
const databaseUrl = process.env.TEST_POSTGRES_URL;
if (!publicUrl?.startsWith("https://") || !databaseUrl)
  throw new Error("Set STRIPE_QUALIFICATION_PUBLIC_URL and TEST_POSTGRES_URL.");
await mkdir(directory, { recursive: true });
const resuming = process.argv[2] === "resume";
const previous = resuming
  ? JSON.parse(await readFile(statePath, "utf8"))
  : undefined;
const schema =
  previous?.schema || `stripe_public_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: databaseUrl });
if (!resuming) await admin.query(`CREATE SCHEMA ${schema}`);
const scoped = new URL(databaseUrl);
scoped.searchParams.set("options", `-csearch_path=${schema}`);
const migration = new Pool({ connectionString: scoped.toString() });
if (!resuming)
  for (const sql of migrationSQL("postgres")) await migration.query(sql);
await migration.end();
let endpoint: Stripe.WebhookEndpoint | undefined;
let handle: NativeHandle;
const state = {
  schema,
  publicUrl,
  endpointId: "",
  customers: [] as string[],
  checkouts: [] as {
    customerId: string;
    stripeCustomerId: string;
    id: string;
    url: string;
    scenario: string;
  }[],
  deliveries: [] as {
    eventId: string;
    type: string;
    accepted: boolean;
    receivedAt: string;
  }[],
  balances: {} as Record<string, unknown>,
};
if (previous) Object.assign(state, previous);
const save = () =>
  writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
const call = async (method: string, input: unknown) => {
  const id = randomUUID();
  handle.registerRequest(id);
  return JSON.parse(await handle.call(method, JSON.stringify(input), id));
};
let stopped = false;
let server: ReturnType<typeof Bun.serve> | undefined;
async function cleanup() {
  if (stopped) return;
  stopped = true;
  server?.stop(true);
  if (endpoint) await stripe.webhookEndpoints.del(endpoint.id).catch(() => {});
  for (const checkout of state.checkouts)
    await stripe.checkout.sessions.expire(checkout.id).catch(() => {});
  for (const customer of state.customers)
    await stripe.customers.del(customer).catch(() => {});
  if (handle) await handle.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());
try {
  const secretPath = resolve(directory, "webhook-secret");
  const oldSecret = resuming
    ? await readFile(secretPath, "utf8").catch(() => undefined)
    : undefined;
  if (resuming && oldSecret) {
    endpoint = await stripe.webhookEndpoints.retrieve(state.endpointId);
    endpoint.secret = oldSecret;
  } else {
    if (resuming)
      await stripe.webhookEndpoints.del(state.endpointId).catch(() => {});
    endpoint = await stripe.webhookEndpoints.create({
      url: `${publicUrl.replace(/\/$/, "")}/webhook`,
      api_version: "2026-09-30.endive",
      enabled_events: [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "charge.refunded",
        "refund.updated",
        "refund.failed",
        "charge.dispute.created",
        "charge.dispute.funds_withdrawn",
        "charge.dispute.funds_reinstated",
      ],
      description:
        "Temporary native billing qualification; delete after exercise",
    });
    await writeFile(secretPath, endpoint.secret!, { mode: 0o600 });
  }
  state.endpointId = endpoint.id;
  await save();
  handle = await loadNative().NativeBilling.open(
    JSON.stringify({
      database: { driver: "postgres", url: scoped.toString() },
      environment: "test",
      stripe: { secretKey: key, webhookSecret: endpoint.secret },
    }),
  );
  server = Bun.serve({
    port: Number(process.env.STRIPE_QUALIFICATION_PORT || "8899"),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/health")
        return new Response("sandbox-ready");
      if (request.method === "GET" && path === "/complete")
        return new Response("Sandbox checkout completed");
      if (request.method !== "POST" || path !== "/webhook")
        return new Response(null, { status: 404 });
      const raw = Buffer.from(await request.arrayBuffer());
      const id = randomUUID();
      handle.registerRequest(id);
      try {
        await handle.webhook(
          JSON.stringify(Object.fromEntries(request.headers)),
          raw,
          id,
        );
        const event = JSON.parse(raw.toString());
        state.deliveries.push({
          eventId: event.id,
          type: event.type,
          accepted: true,
          receivedAt: new Date().toISOString(),
        });
        for (const customer of state.checkouts) {
          await call("maintenance.run", {
            customerId: customer.customerId,
            limit: 100,
          });
          state.balances[customer.customerId] = await call("credits.balance", {
            customerId: customer.customerId,
            feature: "wallet",
          });
        }
        await save();
        return new Response(null, { status: 204 });
      } catch {
        return new Response(null, { status: 500 });
      }
    },
  });
  for (const scenario of resuming ? [] : ["card", "3ds"]) {
    const customerId = `public-${scenario}-${randomUUID()}`;
    const customer = await stripe.customers.create({
      email: "native-qualification@example.com",
      metadata: { fixture: "brokeboy-public" },
    });
    state.customers.push(customer.id);
    await call("migration.adoptStripeCustomer", {
      customerId,
      stripeCustomerId: customer.id,
      dryRun: false,
      idempotencyKey: "adopt",
    });
    const work = await call("prepaid.checkout", {
      customerId,
      feature: "wallet",
      amountCents: 100,
      successUrl: `${publicUrl}/complete`,
      paymentMethodTypes: ["card"],
      ...(scenario === "3ds" ? { requestThreeDSecure: "any" } : {}),
      idempotencyKey: "checkout",
    });
    if (work.status !== "done")
      throw new Error(
        `Native checkout did not complete: ${work.error} ${JSON.stringify(work.errorDetails)}`,
      );
    state.checkouts.push({
      customerId,
      stripeCustomerId: customer.id,
      id: work.result.id,
      url: work.result.url,
      scenario,
    });
    await save();
  }
  console.log(
    "Sandbox receiver ready. Checkout URLs and delivery evidence are in target/stripe-public-qualification/state.json.",
  );
} catch (error) {
  if (error && typeof error === "object") {
    const safe = error as {
      code?: string;
      type?: string;
      statusCode?: number;
      message?: string;
    };
    console.error(
      "Sandbox setup diagnostic:",
      JSON.stringify({
        code: safe.code,
        type: safe.type,
        status: safe.statusCode,
        message: safe.message
          ?.replaceAll(key, "[redacted]")
          .replaceAll(endpoint?.secret || "no-secret", "[redacted]")
          .replace(/(?:[sr]k_(?:test|live)|whsec)_[A-Za-z0-9]+/g, "[redacted]"),
      }),
    );
  }
  await cleanup();
  throw new Error(
    "Sandbox setup failed; inspect fixture configuration without exposing credentials.",
  );
}
