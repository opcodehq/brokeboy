import { expect, test } from "bun:test";
import type { PaymentProvider, ProviderEvent } from "../src/index.js";
import { brokeboy } from "../src/index.js";
import { memoryAdapter } from "../src/memory.js";
import { put } from "../src/storage/contract.js";

const catalog = {
  features: [{ id: "credits", kind: "consumable" as const }],
  plans: [
    {
      id: "paid",
      name: "Paid",
      amount: "10",
      interval: "month" as const,
      trialDays: 7,
      items: [{ feature: "credits", included: "100", reset: "month" as const }],
    },
    {
      id: "pack",
      name: "Pack",
      kind: "one_time" as const,
      amount: "5",
      items: [{ feature: "credits", included: "25" }],
    },
  ],
};
async function setup(provider: PaymentProvider) {
  let now = Date.UTC(2026, 0, 1);
  const db = memoryAdapter();
  const billing = brokeboy({ database: db, provider, now: () => now });
  await billing.catalog.publish({ catalog, expectedRevision: 0 });
  await billing.customers.create({ id: "a", idempotencyKey: "create" });
  return {
    billing,
    db,
    advance: (milliseconds = 5000) => {
      now += milliseconds;
    },
  };
}
const simple: PaymentProvider = {
  execute: async () => ({ ok: true }),
  verify: async (req) => (await req.json()) as ProviderEvent,
  reconcile: async (e) => e,
};
function request(event: ProviderEvent) {
  return new Request("https://example.test/webhook", {
    method: "POST",
    body: JSON.stringify(event),
  });
}
test("durable inbox deduplicates purchases across provider events", async () => {
  const { billing } = await setup(simple);
  const data = {
    planId: "pack",
    purchaseId: "canonical-purchase",
    quantity: "2",
  };
  await billing.webhook(
    request({ id: "checkout", type: "purchase.paid", customerId: "a", data }),
  );
  await billing.webhook(
    request({ id: "invoice", type: "purchase.paid", customerId: "a", data }),
  );
  await billing.webhook(
    request({ id: "checkout", type: "purchase.paid", customerId: "a", data }),
  );
  await billing.maintenance.run();
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .available,
  ).toBe("50");
});
test("payment calls persist failures and retry without changing external identity", async () => {
  const calls: string[] = [];
  let fail = true;
  const { billing, advance } = await setup({
    ...simple,
    execute: async (c) => {
      calls.push(c.id);
      if (fail) throw new Error("network response lost");
      return {
        stripeCustomerId: "cus_a",
        url: "https://checkout.stripe.com/test",
      };
    },
  });
  const input = {
    customerId: "a",
    idempotencyKey: "checkout",
    planId: "paid",
    successUrl: "https://example.test/success",
  };
  const first = await billing.subscriptions.checkout(input);
  expect(first.status).toBe("failed");
  fail = false;
  advance();
  const second = await billing.subscriptions.checkout(input);
  expect(second.status).toBe("done");
  expect(new Set(calls).size).toBe(1);
  expect((await billing.customers.get("a")).stripeCustomerId).toBe("cus_a");
});
test("payment idempotency is isolated across customers", async () => {
  const ids: string[] = [];
  const { billing } = await setup({
    ...simple,
    execute: async (c) => {
      ids.push(c.id);
      return { ok: true };
    },
  });
  await billing.customers.create({ id: "b", idempotencyKey: "create" });
  for (const customerId of ["a", "b"])
    await billing.subscriptions.checkout({
      customerId,
      idempotencyKey: "same-key",
      planId: "paid",
      successUrl: "https://example.test",
    });
  expect(new Set(ids).size).toBe(2);
});
test("trials are claimed once and grant zero credits without explicit trial allocation", async () => {
  const claims: unknown[] = [];
  const { billing, advance } = await setup({
    ...simple,
    execute: async (c) => {
      claims.push(c.input.trialAllowed);
      return {};
    },
  });
  await billing.subscriptions.checkout({
    customerId: "a",
    planId: "paid",
    idempotencyKey: "trial1",
    successUrl: "https://example.test",
  });
  advance(25 * 60 * 60_000);
  await billing.subscriptions.checkout({
    customerId: "a",
    planId: "paid",
    idempotencyKey: "trial2",
    successUrl: "https://example.test",
  });
  expect(claims).toEqual([true, false]);
  const plan = await billing.catalog.get("paid");
  await billing.webhook(
    request({
      id: "trial",
      customerId: "a",
      type: "subscription.updated",
      data: {
        plan,
        subscription: {
          id: "sub_a",
          plan,
          status: "trialing",
          periodStart: Date.UTC(2026, 0, 2),
          periodEnd: Date.UTC(2026, 0, 9),
          paidThrough: Date.UTC(2026, 0, 9),
          quantity: "1",
        },
      },
    }),
  );
  await billing.maintenance.run();
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .available,
  ).toBe("0");
});
test("lease coordination serializes provider calls per customer", async () => {
  let active = 0,
    max = 0;
  const { billing } = await setup({
    ...simple,
    execute: async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return {};
    },
  });
  await Promise.all(
    ["one", "two"].map((idempotencyKey) =>
      billing.subscriptions.checkout({
        customerId: "a",
        planId: "paid",
        idempotencyKey,
        successUrl: "https://example.test",
      }),
    ),
  );
  await billing.maintenance.run();
  expect(max).toBe(1);
});
test("full refund revokes remaining credits and retains consumed-usage review", async () => {
  const { billing } = await setup(simple);
  await billing.webhook(
    request({
      id: "purchase",
      type: "purchase.paid",
      customerId: "a",
      data: { planId: "pack", purchaseId: "payment" },
    }),
  );
  await billing.maintenance.run();
  await billing.usage.consume({
    customerId: "a",
    feature: "credits",
    amount: "5",
    idempotencyKey: "consume",
  });
  await billing.webhook(
    request({
      id: "refund",
      type: "purchase.reversed",
      customerId: "a",
      data: { purchaseId: "payment" },
    }),
  );
  await billing.maintenance.run();
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .available,
  ).toBe("0");
  expect(
    (await billing.operations.list("a")).some(
      (o) => o.status === "reconciliation",
    ),
  ).toBe(true);
  expect((await billing.credits.reconcile("a")).consistent).toBe(true);
});
test("one-time purchases include lifetime boolean entitlements", async () => {
  const { billing } = await setup(simple);
  await billing.catalog.publish({
    catalog: {
      ...catalog,
      features: [...catalog.features, { id: "lifetime", kind: "boolean" }],
      plans: [
        {
          id: "lifetime",
          name: "Lifetime",
          kind: "one_time",
          amount: "10",
          items: [{ feature: "lifetime", enabled: true }],
        },
      ],
    },
    expectedRevision: 1,
  });
  await billing.webhook(
    request({
      id: "life",
      customerId: "a",
      type: "purchase.paid",
      data: { planId: "lifetime", purchaseId: "purchase-life" },
    }),
  );
  await billing.maintenance.run();
  expect(
    (await billing.entitlements.check({ customerId: "a", feature: "lifetime" }))
      .allowed,
  ).toBe(true);
  await billing.webhook(
    request({
      id: "life-refund",
      customerId: "a",
      type: "purchase.reversed",
      data: { purchaseId: "purchase-life" },
    }),
  );
  await billing.maintenance.run();
  expect(
    (await billing.entitlements.check({ customerId: "a", feature: "lifetime" }))
      .allowed,
  ).toBe(false);
});
test("paid upgrades grant only the additional current-period allowance", async () => {
  const { billing } = await setup(simple);
  const sub = {
    id: "sub",
    status: "active",
    periodStart: Date.UTC(2026, 0, 1),
    periodEnd: Date.UTC(2026, 1, 1),
    paidThrough: Date.UTC(2026, 1, 1),
    quantity: "1",
  };
  await billing.webhook(
    request({
      id: "start",
      customerId: "a",
      type: "subscription.updated",
      data: { planId: "paid", subscription: sub },
    }),
  );
  await billing.maintenance.run();
  await billing.usage.consume({
    customerId: "a",
    feature: "credits",
    amount: "60",
    idempotencyKey: "spend",
  });
  await billing.catalog.publish({
    catalog: {
      ...catalog,
      plans: [
        {
          ...catalog.plans[0]!,
          items: [{ feature: "credits", included: "200", reset: "month" }],
        },
      ],
    },
    expectedRevision: 1,
  });
  await billing.webhook(
    request({
      id: "upgrade",
      customerId: "a",
      type: "subscription.updated",
      data: { planId: "paid", subscription: sub },
    }),
  );
  await billing.maintenance.run();
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .available,
  ).toBe("140");
});
test("postpaid included usage cannot be multiplied by arbitrary event properties", async () => {
  const { billing } = await setup(simple);
  await billing.catalog.publish({
    catalog: {
      features: [{ id: "calls", kind: "consumable" }],
      plans: [
        {
          id: "meter",
          name: "Meter",
          kind: "free",
          interval: "month",
          items: [
            {
              feature: "calls",
              included: "10",
              overage: true,
              rate: { amount: "1" },
            },
          ],
        },
      ],
    },
    expectedRevision: 1,
  });
  await billing.subscriptions.attach({
    customerId: "a",
    planId: "meter",
    idempotencyKey: "meter",
  });
  const sub = (await billing.subscriptions.list("a"))[0]!;
  await billing.webhook(
    request({
      id: "meter-link",
      customerId: "a",
      type: "subscription.updated",
      data: {
        planId: "meter",
        meterPriceIds: { calls: "price_calls" },
        subscription: { ...sub, stripeSubscriptionId: "sub_m" },
      },
    }),
  );
  await billing.maintenance.run();
  const first = await billing.usage.consume({
    customerId: "a",
    feature: "calls",
    amount: "10",
    properties: { request: "one" },
    idempotencyKey: "use-one",
  });
  const second = await billing.usage.consume({
    customerId: "a",
    feature: "calls",
    amount: "10",
    properties: { request: "two" },
    idempotencyKey: "use-two",
  });
  expect(first.charged).toBe("0");
  expect(second.charged).toBe("10");
});
test("maintenance advances beyond inactive customers and isolates environments", async () => {
  const db = memoryAdapter();
  const calls: string[] = [];
  const testBilling = brokeboy({
    database: db,
    provider: {
      ...simple,
      execute: async (c) => {
        calls.push(c.customer.id);
        return {};
      },
    },
  });
  const liveBilling = brokeboy({ database: db, environment: "live" });
  for (const billing of [testBilling, liveBilling])
    for (let i = 0; i < 5; i++)
      await billing.customers.create({
        id: `customer-${i}`,
        idempotencyKey: "create",
      });
  await testBilling.catalog.publish({ catalog, expectedRevision: 0 });
  for (let i = 0; i < 5; i++)
    await testBilling.subscriptions.checkout({
      customerId: `customer-${i}`,
      planId: "paid",
      successUrl: "https://example.test",
      idempotencyKey: "checkout",
    });
  for (let i = 0; i < 6; i++) await testBilling.maintenance.run({ limit: 1 });
  expect(new Set(calls).size).toBe(5);
});
test("credit pack checkout remains available alongside an active base subscription", async () => {
  const { billing } = await setup(simple);
  await billing.webhook(
    request({
      id: "base",
      customerId: "a",
      type: "subscription.updated",
      data: {
        planId: "paid",
        subscription: {
          id: "sub",
          stripeSubscriptionId: "sub",
          status: "active",
          periodStart: Date.UTC(2026, 0, 1),
          periodEnd: Date.UTC(2026, 1, 1),
          paidThrough: Date.UTC(2026, 1, 1),
          quantity: "1",
        },
      },
    }),
  );
  await billing.maintenance.run();
  const result = await billing.subscriptions.checkout({
    customerId: "a",
    planId: "pack",
    idempotencyKey: "buy-pack",
    successUrl: "https://example.test",
  });
  expect(result.status).toBe("done");
});
test("purchased credits are consumed before generating overage charges", async () => {
  const { billing } = await setup(simple);
  const current = await billing.catalog.export();
  await billing.catalog.publish({
    catalog: {
      features: catalog.features,
      plans: [
        {
          id: "usage",
          name: "Usage",
          amount: "1",
          interval: "month",
          currency: "usd",
          items: [
            {
              feature: "credits",
              included: "10",
              overage: true,
              rate: { amount: "1" },
            },
          ],
        },
      ],
    },
    expectedRevision: current.revision,
  });
  await billing.webhook(
    request({
      id: "usage-start",
      customerId: "a",
      type: "subscription.updated",
      data: {
        planId: "usage",
        meterPriceIds: { credits: "price_credits" },
        subscription: {
          id: "sub_usage",
          stripeSubscriptionId: "sub_usage",
          status: "active",
          periodStart: Date.UTC(2026, 0, 1),
          periodEnd: Date.UTC(2026, 1, 1),
          paidThrough: Date.UTC(2026, 1, 1),
          quantity: "1",
        },
      },
    }),
  );
  await billing.webhook(
    request({
      id: "pack",
      customerId: "a",
      type: "purchase.paid",
      data: { planId: "pack", purchaseId: "pack" },
    }),
  );
  await billing.maintenance.run();
  const receipt = await billing.usage.consume({
    customerId: "a",
    feature: "credits",
    amount: "30",
    idempotencyKey: "spend-30",
  });
  expect(receipt.charged).toBe("0");
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .available,
  ).toBe("5");
  const next = await billing.usage.consume({
    customerId: "a",
    feature: "credits",
    amount: "10",
    idempotencyKey: "spend-10",
  });
  expect(next.charged).toBe("5");
  expect((await billing.credits.reconcile("a")).consistent).toBe(true);
});
test("advisory overage access respects caps and missing payment setup", async () => {
  const { billing } = await setup(simple);
  const current = await billing.catalog.export();
  await billing.catalog.publish({
    catalog: {
      features: catalog.features,
      plans: [
        {
          id: "free-usage",
          name: "Free usage",
          kind: "free",
          items: [
            {
              feature: "credits",
              included: "2",
              overage: true,
              rate: { amount: "1" },
            },
          ],
        },
      ],
    },
    expectedRevision: current.revision,
  });
  await billing.subscriptions.attach({
    customerId: "a",
    planId: "free-usage",
    idempotencyKey: "free-usage",
  });
  await billing.usage.consume({
    customerId: "a",
    feature: "credits",
    amount: "2",
    idempotencyKey: "free-two",
  });
  expect(
    (await billing.entitlements.check({ customerId: "a", feature: "credits" }))
      .allowed,
  ).toBe(false);
  await expect(
    billing.usage.consume({
      customerId: "a",
      feature: "credits",
      amount: "1",
      idempotencyKey: "unfunded",
    }),
  ).rejects.toMatchObject({ code: "payment_setup_required" });
});
test("migration retains license occupancy and supports release after import", async () => {
  const db = memoryAdapter(),
    billing = brokeboy({ database: db });
  const seats = {
    features: [{ id: "seats", kind: "quantity" as const }],
    plans: [
      {
        id: "team",
        name: "Team",
        kind: "free" as const,
        items: [{ feature: "seats", included: "3" }],
      },
    ],
  };
  await billing.catalog.publish({ catalog: seats, expectedRevision: 0 });
  await billing.customers.create({ id: "team", idempotencyKey: "create" });
  await billing.subscriptions.attach({
    customerId: "team",
    planId: "team",
    idempotencyKey: "plan",
  });
  await billing.entities.create({
    customerId: "team",
    id: "member",
    idempotencyKey: "member",
  });
  const assignment = await billing.licenses.assign({
    customerId: "team",
    entityId: "member",
    feature: "seats",
    idempotencyKey: "assign",
  });
  const snapshot = await billing.migration.export("team");
  const target = brokeboy({ database: memoryAdapter() });
  await target.migration.import({ snapshot, idempotencyKey: "import" });
  expect(
    (await target.credits.balance({ customerId: "team", feature: "seats" }))
      .available,
  ).toBe("2");
  await target.licenses.release({
    customerId: "team",
    licenseId: assignment.id,
    idempotencyKey: "release",
  });
  expect(
    (await target.credits.balance({ customerId: "team", feature: "seats" }))
      .available,
  ).toBe("3");
});
test("entity plans can draw from an explicitly shared customer pool", async () => {
  const { billing } = await setup(simple);
  const revision = (await billing.catalog.export()).revision;
  await billing.catalog.publish({
    catalog: {
      features: [
        { id: "credits", kind: "consumable" },
        { id: "messages", kind: "consumable" },
      ],
      plans: [
        {
          id: "entity",
          name: "Entity",
          kind: "free",
          items: [
            {
              feature: "messages",
              pool: "credits",
              poolScope: "customer",
              rate: { amount: "2" },
            },
          ],
        },
      ],
    },
    expectedRevision: revision,
  });
  await billing.credits.grant({
    customerId: "a",
    feature: "credits",
    amount: "100",
    idempotencyKey: "credit",
  });
  await billing.entities.create({
    customerId: "a",
    id: "project",
    idempotencyKey: "project",
  });
  await billing.subscriptions.attach({
    customerId: "a",
    entityId: "project",
    planId: "entity",
    idempotencyKey: "entity-plan",
  });
  await billing.usage.consume({
    customerId: "a",
    entityId: "project",
    feature: "messages",
    amount: "10",
    idempotencyKey: "messages",
  });
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .available,
  ).toBe("80");
  expect((await billing.credits.reconcile("a")).consistent).toBe(true);
});
test("automatic top-up coordination survives a month boundary without a second charge", async () => {
  let now = Date.UTC(2026, 0, 31, 23, 59);
  let charges = 0;
  const billing = brokeboy({
    database: memoryAdapter(),
    now: () => now,
    provider: {
      ...simple,
      execute: async () => {
        charges++;
        return {};
      },
    },
  });
  await billing.catalog.publish({ catalog, expectedRevision: 0 });
  await billing.customers.create({ id: "topup", idempotencyKey: "create" });
  await billing.billingControls.update({
    customerId: "topup",
    idempotencyKey: "enable",
    controls: {
      autoTopUp: {
        feature: "credits",
        below: "10",
        packPlan: "pack",
        maximumPurchases: 2,
      },
    },
  });
  await billing.maintenance.run();
  expect(charges).toBe(1);
  expect(
    (await billing.credits.balance({ customerId: "topup", feature: "credits" }))
      .available,
  ).toBe("0");
  now += 120000;
  await billing.maintenance.run();
  expect(charges).toBe(1);
  expect((await billing.migration.export("topup")).blockers).toContain(
    "pending_topup_confirmation",
  );
});
test("a migrated customer replays a lost usage response without a second debit", async () => {
  const { billing } = await setup(simple);
  await billing.credits.grant({
    customerId: "a",
    feature: "credits",
    amount: "10",
    idempotencyKey: "grant",
  });
  const input = {
    customerId: "a",
    feature: "credits",
    amount: "3",
    idempotencyKey: "lost-response",
  };
  const receipt = await billing.usage.consume(input);
  const snapshot = await billing.migration.export("a");
  const restored = brokeboy({ database: memoryAdapter() });
  await restored.migration.import({ snapshot, idempotencyKey: "cutover" });
  expect(await restored.usage.consume(input)).toEqual(receipt);
  expect(
    (await restored.credits.balance({ customerId: "a", feature: "credits" }))
      .available,
  ).toBe("7");
  expect((await restored.credits.reconcile("a")).consistent).toBe(true);
});

test("bounded maintenance recovers interrupted work and drains meters before dependent changes", async () => {
  const calls: string[] = [];
  const { billing, db } = await setup({
    ...simple,
    execute: async ({ kind }) => {
      calls.push(kind);
      return {};
    },
  });
  await db.atomic("test:c:a", async (tx) => {
    const createdAt = Date.UTC(2026, 0, 1);
    const add = (id: string, kind: string, status: "pending" | "processing") =>
      put(
        tx,
        "work",
        id,
        {
          id,
          kind,
          status,
          createdAt,
          availableAt: createdAt,
          attempts: 0,
          leaseUntil: status === "processing" ? createdAt - 1 : undefined,
          payload: { subscriptionId: "sub", generation: 1, meterKey: "rate" },
        },
        status,
      );
    await add("a-change", "subscription_update", "pending");
    await add("z-meter", "meter", "pending");
    await add("zz-interrupted", "checkout", "processing");
    await put(tx, "counters", "provider-lane", {
      owner: "lost-worker",
      until: createdAt - 1,
      operationId: "zz-interrupted",
    });
  });
  for (let i = 0; i < 3; i++)
    await billing.maintenance.run({ customerId: "a", limit: 1 });
  expect(calls).toEqual(["checkout", "meter", "subscription_update"]);
});
