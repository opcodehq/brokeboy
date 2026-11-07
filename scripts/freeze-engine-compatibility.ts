import { brokeboy } from "../src/index.js";
import { memoryAdapter } from "../src/memory.js";
import { tables } from "../src/storage/contract.js";

// Isolated fixture generation only. Never import this script into application code.
const original = crypto.randomUUID;
let sequence = 0;
Object.defineProperty(crypto, "randomUUID", {
  configurable: true,
  value: () =>
    `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
});
try {
  const database = memoryAdapter();
  const now = Date.UTC(2026, 0, 31, 12, 34, 56, 789);
  const billing = brokeboy({ database, now: () => now });
  const traces: { method: string; input: unknown; result: unknown }[] = [];
  async function trace<T>(
    method: string,
    input: unknown,
    run: () => Promise<T>,
  ) {
    const result = await run();
    traces.push({ method, input, result });
    return result;
  }
  const catalog = {
    features: [
      { id: "credits", kind: "consumable" as const },
      { id: "tokens", kind: "consumable" as const },
    ],
    plans: [
      {
        id: "free",
        name: "Free",
        kind: "free" as const,
        items: [
          { feature: "credits", included: "20.00", reset: "month" as const },
          { feature: "tokens", pool: "credits", rate: { amount: "0.5" } },
        ],
      },
    ],
  };
  await billing.catalog.publish({ catalog, expectedRevision: 0 });
  const create = {
    id: "fixture",
    metadata: { account: "organization" },
    idempotencyKey: "create",
  };
  await trace("customers.create", create, () =>
    billing.customers.create(create),
  );
  const entity = {
    customerId: "fixture",
    id: "project",
    metadata: { name: "Project" },
    idempotencyKey: "entity",
  };
  await trace("entities.create", entity, () => billing.entities.create(entity));
  const attach = {
    customerId: "fixture",
    planId: "free",
    idempotencyKey: "attach",
  };
  await trace("subscriptions.attach", attach, () =>
    billing.subscriptions.attach(attach),
  );
  const fund = {
    customerId: "fixture",
    feature: "budget",
    amount: "30.00",
    priority: -1,
    expiresAt: now + 86_400_000,
    idempotencyKey: "fund",
  };
  await trace("credits.grant", fund, () => billing.credits.grant(fund));
  const consume = {
    customerId: "fixture",
    feature: "tokens",
    amount: "1.000001",
    properties: { region: "us" },
    idempotencyKey: "consume",
  };
  const usage = await trace("usage.consume", consume, () =>
    billing.usage.consume(consume),
  );
  const correction = {
    customerId: "fixture",
    usageId: usage.id,
    reason: "fixture correction",
    idempotencyKey: "correct",
  };
  await trace("usage.correct", correction, () =>
    billing.usage.correct(correction),
  );
  const reserve = {
    customerId: "fixture",
    feature: "budget",
    amount: "7.50",
    idempotencyKey: "reserve",
  };
  const reservation = await trace("reservations.create", reserve, () =>
    billing.reservations.create(reserve),
  );
  const settle = {
    customerId: "fixture",
    reservationId: reservation.id,
    amount: "5.25",
    idempotencyKey: "settle",
  };
  await trace("reservations.settle", settle, () =>
    billing.reservations.settle(settle),
  );
  const workflow = {
    customerId: "fixture",
    workflowId: "pipeline",
    idempotencyKey: "workflow",
    steps: [
      { id: "prepare", budgets: [{ feature: "budget", amount: "3" }] },
      {
        id: "finish",
        dependsOn: ["prepare"],
        budgets: [{ feature: "budget", amount: "4" }],
      },
    ],
  };
  await trace("workflows.create", workflow, () =>
    billing.workflows.create(workflow),
  );
  for (const [stepId, amount] of [
    ["prepare", "2"],
    ["finish", "3"],
  ] as const) {
    const claim = {
      customerId: "fixture",
      workflowId: "pipeline",
      workerId: "worker",
      idempotencyKey: `claim-${stepId}`,
    };
    const claimed = await trace("workflows.claim", claim, () =>
      billing.workflows.claim(claim),
    );
    if (!claimed.claimed) throw new Error("Fixture step could not be claimed");
    const complete = {
      customerId: "fixture",
      workflowId: "pipeline",
      stepId,
      token: claimed.step.lease!.token,
      actuals: { budget: amount },
      idempotencyKey: `complete-${stepId}`,
    };
    await trace("workflows.complete", complete, () =>
      billing.workflows.complete(complete),
    );
  }
  const snapshot = await billing.migration.export("fixture");
  const scopes = await database.scopes();
  const records: { scope: string; table: string; rows: unknown[] }[] = [];
  for (const scope of scopes) {
    await database.read(scope, async (tx) => {
      for (const table of tables) {
        const rows = (await tx.list(table)).sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        );
        if (rows.length) records.push({ scope, table, rows });
      }
    });
  }
  const fixture = {
    oracle: "26c5eb67e9e7eb7d017fd968556172877ab48296",
    now,
    traces,
    snapshot,
    records,
  };
  await Bun.write(
    new URL("../test/fixtures/compatibility/engine-v1.json", import.meta.url),
    `${JSON.stringify(fixture, null, 2)}\n`,
  );
} finally {
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: original,
  });
}
