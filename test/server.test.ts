import { expect, test } from "bun:test";
import { brokeboy } from "../src/index.js";
import { memoryAdapter } from "../src/memory.js";
import { toHandler } from "../src/server.js";

async function setup() {
  const billing = brokeboy({ database: memoryAdapter() });
  await billing.customers.create({ id: "a", idempotencyKey: "create" });
  await billing.customers.create({ id: "b", idempotencyKey: "create" });
  await billing.credits.grant({
    customerId: "a",
    feature: "credits",
    amount: "10",
    idempotencyKey: "grant",
  });
  await billing.credits.grant({
    customerId: "b",
    feature: "credits",
    amount: "100",
    idempotencyKey: "grant",
  });
  return {
    billing,
    handler: toHandler({ billing, resolveCustomer: async () => "a" }),
  };
}
test("browser-supplied customer identity cannot override trusted session", async () => {
  const { handler } = await setup();
  const result = await handler(
    new Request(
      "https://example.test/api/billing/balance?feature=credits&customerId=b",
    ),
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ available: "10" });
});
test("admin routes deny access without explicit authorization", async () => {
  const { handler } = await setup();
  expect(
    (
      await handler(
        new Request(
          "https://example.test/api/billing/admin/customer?customerId=b",
        ),
      )
    ).status,
  ).toBe(403);
});
test("cross-origin writes are rejected", async () => {
  const { handler } = await setup();
  expect(
    (
      await handler(
        new Request("https://example.test/api/billing/checkout", {
          method: "POST",
          headers: {
            origin: "https://evil.test",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(403);
});
test("customer responses omit internal metadata and provider identifiers", async () => {
  const { handler } = await setup();
  const response = await handler(
    new Request("https://example.test/api/billing/customer"),
  );
  expect(await response.json()).toEqual({ id: "a", controls: {} });
});
test("storage failures are visible and do not grant feature access", async () => {
  const database = memoryAdapter();
  database.atomic = async () => {
    throw new Error("database unavailable");
  };
  const billing = brokeboy({ database });
  await expect(
    billing.entitlements.check({ customerId: "a", feature: "credits" }),
  ).rejects.toThrow("database unavailable");
});
test("checkout responses do not expose catalog rate internals or operation payloads", async () => {
  const { billing } = await setup();
  await billing.catalog.publish({
    catalog: {
      features: [{ id: "credits", kind: "consumable" }],
      plans: [
        {
          id: "free",
          name: "Free",
          kind: "free",
          items: [
            {
              feature: "credits",
              included: "10",
              rate: { amount: "0.123456" },
            },
          ],
        },
      ],
    },
    expectedRevision: 0,
  });
  const handler = toHandler({ billing, resolveCustomer: async () => "a" });
  const result = await handler(
    new Request("https://example.test/api/billing/checkout", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        planId: "free",
        successUrl: "https://example.test",
        idempotencyKey: "free",
      }),
    }),
  );
  expect(result.status).toBe(200);
  const body = await result.text();
  expect(body).not.toContain("rate");
  expect(body).not.toContain("payload");
  expect(body).not.toContain("0.123456");
});
test("workflow resolution requires administrator authorization and records the actor", async () => {
  const { billing, handler } = await setup();
  await billing.workflows.create({
    customerId: "a",
    workflowId: "job",
    idempotencyKey: "start",
    steps: [{ id: "run", budgets: [{ feature: "credits", amount: "5" }] }],
  });
  const claim = await billing.workflows.claim({
    customerId: "a",
    workflowId: "job",
    workerId: "worker",
    idempotencyKey: "claim",
  });
  if (!claim.claimed) throw new Error("missing claim");
  await billing.workflows.fail({
    customerId: "a",
    workflowId: "job",
    stepId: "run",
    token: claim.step.lease!.token,
    retrySafe: false,
    code: "unknown",
    idempotencyKey: "failed",
  });
  const request = () =>
    new Request(
      "https://example.test/api/billing/admin/workflow/resolve?customerId=a",
      {
        method: "POST",
        headers: {
          origin: "https://example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workflowId: "job",
          stepId: "run",
          outcome: "succeeded",
          actuals: { credits: "2" },
          reason: "verified output",
          idempotencyKey: "resolution",
        }),
      },
    );
  expect((await handler(request())).status).toBe(403);
  const admin = toHandler({
    billing,
    resolveCustomer: async () => "a",
    authorizeAdmin: async () => ({ actorId: "operator" }),
  });
  const result = await admin(request());
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ status: "succeeded" });
  expect(JSON.stringify(await billing.events.list("a"))).toContain(
    "operator: verified output",
  );
  // A regular customer endpoint never returns lease tokens or workflow results.
  const customer = await handler(
    new Request("https://example.test/api/billing/customer"),
  );
  expect(await customer.text()).not.toContain(claim.step.lease!.token);
});
