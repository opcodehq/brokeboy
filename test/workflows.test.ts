import { expect, test } from "bun:test";
import { brokeboy, type WorkflowStepDefinition } from "../src/index.js";
import { memoryAdapter } from "../src/memory.js";
import { put } from "../src/storage/contract.js";

const budgets = [{ feature: "credits", amount: "10" }];
async function setup(
  steps: WorkflowStepDefinition[] = [{ id: "run", budgets }],
  expiry = 60_000,
) {
  let now = Date.UTC(2026, 0, 1);
  const db = memoryAdapter();
  const billing = brokeboy({ database: db, now: () => now });
  await billing.customers.create({ id: "a", idempotencyKey: "create" });
  await billing.credits.grant({
    customerId: "a",
    feature: "credits",
    amount: "100",
    idempotencyKey: "fund",
  });
  const scope = { customerId: "a", workflowId: "job" };
  await billing.workflows.create({
    ...scope,
    steps,
    expiresAt: now + expiry,
    idempotencyKey: "start",
  });
  async function claim(idempotencyKey = "claim", leaseMs = 1000) {
    const c = await billing.workflows.claim({
      ...scope,
      workerId: "worker",
      leaseMs,
      idempotencyKey,
    });
    if (!c.claimed) throw new Error("no claim");
    return { ...scope, stepId: c.step.id, token: c.step.lease!.token };
  }
  return {
    billing,
    db,
    scope,
    claim,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

test("parallel branches unlock a join only after all dependencies succeed", async () => {
  const { billing, scope, claim } = await setup([
    { id: "left", budgets },
    { id: "right", budgets },
    { id: "join", dependsOn: ["left", "right"], budgets: [] },
  ]);
  const left = await claim("left"),
    right = await claim("right");
  expect(
    (
      await billing.workflows.claim({
        ...scope,
        workerId: "other",
        idempotencyKey: "blocked",
      })
    ).claimed,
  ).toBe(false);
  await billing.workflows.complete({
    ...left,
    actuals: { credits: "2" },
    result: { artifact: "left" },
    idempotencyKey: "done-left",
  });
  expect(
    (
      await billing.workflows.claim({
        ...scope,
        workerId: "other",
        idempotencyKey: "still-blocked",
      })
    ).claimed,
  ).toBe(false);
  await billing.workflows.complete({
    ...right,
    actuals: { credits: "3" },
    idempotencyKey: "done-right",
  });
  const join = await claim("join");
  expect(join.stepId).toBe("join");
  expect(
    (
      await billing.workflows.complete({
        ...join,
        actuals: {},
        idempotencyKey: "joined",
      })
    ).status,
  ).toBe("succeeded");
});
test("worker timeouts create reconciliation, never automatic external retries", async () => {
  const { billing, scope, claim, tick } = await setup();
  const worker = await claim();
  tick(1001);
  await billing.maintenance.run({ customerId: "a" });
  expect((await billing.workflows.get(scope)).status).toBe("reconciliation");
  await expect(
    billing.workflows.claim({
      ...scope,
      workerId: "another",
      idempotencyKey: "again",
    }),
  ).rejects.toMatchObject({ code: "workflow_not_active" });
  const late = await billing.workflows.complete({
    ...worker,
    actuals: { credits: "3" },
    idempotencyKey: "late",
  });
  expect(late.steps[0]?.reportedActuals).toEqual({ credits: "3" });
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .spent,
  ).toBe("0");
  const resolved = await billing.workflows.resolve({
    ...scope,
    stepId: "run",
    outcome: "succeeded",
    actuals: { credits: "3" },
    reason: "Verified provider output",
    idempotencyKey: "resolve",
  });
  expect(resolved.status).toBe("succeeded");
  expect((await billing.credits.reconcile("a")).consistent).toBe(true);
});
test("heartbeats survive earlier timeout tasks", async () => {
  const { billing, scope, claim, tick } = await setup();
  const worker = await claim();
  tick(500);
  await billing.workflows.heartbeat({
    ...worker,
    leaseMs: 2000,
    idempotencyKey: "beat",
  });
  tick(501);
  await billing.maintenance.run({ customerId: "a" });
  expect((await billing.workflows.get(scope)).steps[0]?.status).toBe("running");
  await billing.workflows.complete({
    ...worker,
    actuals: { credits: "5" },
    idempotencyKey: "done",
  });
});
test("safe retries delay the next claim and fence the previous worker", async () => {
  const { billing, scope, claim, tick } = await setup();
  const first = await claim();
  await billing.workflows.fail({
    ...first,
    code: "request_not_sent",
    retrySafe: true,
    retryAfterMs: 2000,
    idempotencyKey: "fail",
  });
  expect(
    (
      await billing.workflows.claim({
        ...scope,
        workerId: "new",
        idempotencyKey: "early",
      })
    ).claimed,
  ).toBe(false);
  tick(2000);
  const second = await claim("second");
  expect(second.token).not.toBe(first.token);
  await expect(
    billing.workflows.complete({
      ...first,
      actuals: { credits: "1" },
      idempotencyKey: "stale",
    }),
  ).rejects.toMatchObject({ code: "workflow_lease_lost" });
  expect(
    (
      await billing.workflows.complete({
        ...second,
        actuals: { credits: "4" },
        idempotencyKey: "done",
      })
    ).status,
  ).toBe("succeeded");
});
test("budget increases require the live worker token and preserve the ledger", async () => {
  const { billing, claim } = await setup();
  const worker = await claim();
  await expect(
    billing.workflows.increase({
      ...worker,
      token: "stale",
      feature: "credits",
      amount: "5",
      reason: "larger request",
      idempotencyKey: "stale-increase",
    }),
  ).rejects.toMatchObject({ code: "workflow_lease_lost" });
  await billing.workflows.increase({
    ...worker,
    feature: "credits",
    amount: "5",
    reason: "larger request",
    idempotencyKey: "increase",
  });
  const done = await billing.workflows.complete({
    ...worker,
    actuals: { credits: "12" },
    idempotencyKey: "done",
  });
  expect(done.status).toBe("succeeded");
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .available,
  ).toBe("88");
  expect((await billing.credits.reconcile("a")).consistent).toBe(true);
});
test("uncovered usage stays visible and needs explicit recovery funding", async () => {
  const { billing, scope, claim } = await setup();
  const worker = await claim();
  const overrun = await billing.workflows.complete({
    ...worker,
    actuals: { credits: "12" },
    idempotencyKey: "overrun",
  });
  expect(overrun.status).toBe("reconciliation");
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .spent,
  ).toBe("0");
  const resolved = await billing.workflows.resolve({
    ...scope,
    stepId: "run",
    outcome: "succeeded",
    fundUncovered: true,
    actuals: { credits: "12" },
    reason: "Approved additional prepaid spend",
    idempotencyKey: "recover",
  });
  expect(resolved.status).toBe("succeeded");
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .available,
  ).toBe("88");
  expect((await billing.credits.reconcile("a")).consistent).toBe(true);
});
test("cancellation releases unstarted budgets and reconciles already-running work", async () => {
  const { billing, scope, claim } = await setup([
    { id: "run", budgets },
    { id: "later", dependsOn: ["run"], budgets },
  ]);
  await claim();
  const cancelling = await billing.workflows.cancel({
    ...scope,
    reason: "user cancelled",
    idempotencyKey: "cancel",
  });
  expect(cancelling.status).toBe("reconciliation");
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .reserved,
  ).toBe("10");
  const done = await billing.workflows.resolve({
    ...scope,
    stepId: "run",
    outcome: "failed",
    actuals: { credits: "2" },
    reason: "confirmed partial cost",
    idempotencyKey: "resolve",
  });
  expect(done.status).toBe("cancelled");
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .available,
  ).toBe("98");
});
test("expired workflows release holds and retain late-cost evidence", async () => {
  const { billing, scope, claim, tick } = await setup(undefined, 2000);
  const worker = await claim();
  tick(2001);
  await billing.maintenance.run({ customerId: "a" });
  expect((await billing.workflows.get(scope)).status).toBe("reconciliation");
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .reserved,
  ).toBe("0");
  await billing.workflows.complete({
    ...worker,
    actuals: { credits: "4" },
    idempotencyKey: "late",
  });
  const zero = await billing.workflows.resolve({
    ...scope,
    stepId: "run",
    outcome: "failed",
    actuals: { credits: "0" },
    reason: "provider confirmed no charge",
    idempotencyKey: "resolve",
  });
  expect(zero.status).toBe("failed");
  expect((await billing.credits.reconcile("a")).consistent).toBe(true);
});
test("invalid dependency graphs and cross-entity access fail without changing funding", async () => {
  const { billing, scope } = await setup();
  await expect(
    billing.workflows.create({
      customerId: "a",
      workflowId: "cycle",
      idempotencyKey: "cycle",
      steps: [
        { id: "one", dependsOn: ["two"], budgets },
        { id: "two", dependsOn: ["one"], budgets },
      ],
    }),
  ).rejects.toMatchObject({ code: "invalid_workflow_dependencies" });
  await expect(
    billing.workflows.get({ ...scope, entityId: "other" }),
  ).rejects.toMatchObject({ code: "workflow_not_found" });
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .reserved,
  ).toBe("10");
});
test("a failed parallel branch releases pending stages while preserving in-flight accounting", async () => {
  const { billing, scope, claim } = await setup([
    { id: "left", budgets },
    { id: "right", budgets },
    { id: "join", dependsOn: ["left", "right"], budgets },
  ]);
  const left = await claim("left"),
    right = await claim("right");
  await billing.workflows.fail({
    ...left,
    retrySafe: false,
    code: "ambiguous",
    idempotencyKey: "fail",
  });
  await billing.workflows.resolve({
    ...scope,
    stepId: "left",
    outcome: "failed",
    actuals: { credits: "2" },
    reason: "verified failure cost",
    idempotencyKey: "resolve",
  });
  const done = await billing.workflows.complete({
    ...right,
    actuals: { credits: "3" },
    idempotencyKey: "right-done",
  });
  expect(done.status).toBe("failed");
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .available,
  ).toBe("95");
});
test("claim detects an expired sibling lease even before scheduled maintenance", async () => {
  const { billing, scope, claim, tick } = await setup([
    { id: "one", budgets },
    { id: "two", budgets },
  ]);
  await claim();
  tick(1001);
  expect(
    (
      await billing.workflows.claim({
        ...scope,
        workerId: "next",
        idempotencyKey: "next",
      })
    ).claimed,
  ).toBe(false);
  expect((await billing.workflows.get(scope)).status).toBe("reconciliation");
});
test("completed workflows export and restore their history without waiting for stale timeout tasks", async () => {
  const { billing, scope, claim } = await setup();
  expect((await billing.migration.export("a")).blockers).toContain(
    "active_workflow:job",
  );
  const worker = await claim();
  const done = await billing.workflows.complete({
    ...worker,
    actuals: { credits: "2" },
    result: { file: "stored" },
    idempotencyKey: "done",
  });
  const snapshot = await billing.migration.export("a");
  expect(snapshot.blockers).toHaveLength(0);
  const restored = brokeboy({ database: memoryAdapter() });
  await restored.migration.import({ snapshot, idempotencyKey: "restore" });
  expect(await restored.workflows.get(scope)).toEqual(done);
  expect((await restored.credits.reconcile("a")).consistent).toBe(true);
});
test("usage aggregation keeps fractional quantities and correction history deterministic", async () => {
  const { billing, tick } = await setup();
  const original = await billing.usage.consume({
    customerId: "a",
    feature: "credits",
    amount: "0.125",
    properties: { model: "small" },
    idempotencyKey: "fraction",
  });
  await billing.usage.consume({
    customerId: "a",
    feature: "credits",
    amount: "0.25",
    properties: { model: "large" },
    idempotencyKey: "other",
  });
  await billing.usage.correct({
    customerId: "a",
    usageId: original.id,
    reason: "cancelled request",
    idempotencyKey: "correct",
  });
  const totals = await billing.usage.aggregate({
    customerId: "a",
    from: Date.UTC(2026, 0, 1),
    to: Date.UTC(2026, 0, 2),
    groupBy: ["model"],
  });
  expect(totals.complete).toBe(true);
  expect(
    totals.totals.find((g) => g.properties.model === "small")?.quantity,
  ).toBe("0");
  expect(
    totals.totals.find((g) => g.properties.model === "large")?.quantity,
  ).toBe("0.25");
  const first = await billing.usage.aggregate({
    customerId: "a",
    from: Date.UTC(2026, 0, 1),
    to: Date.UTC(2026, 0, 2),
    limit: 1,
  });
  expect(first.complete).toBe(false);
  expect(first.nextCursor).toBeDefined();
  tick(86400_000);
});
test("shared parent budgets are explicit and grant expiry bounds the whole workflow", async () => {
  const { billing } = await setup();
  await billing.entities.create({
    customerId: "a",
    id: "team",
    idempotencyKey: "team",
  });
  await expect(
    billing.workflows.create({
      customerId: "a",
      entityId: "team",
      workflowId: "isolated",
      idempotencyKey: "isolated",
      steps: [{ id: "run", budgets }],
    }),
  ).rejects.toMatchObject({ code: "insufficient_balance" });
  const shared = await billing.workflows.create({
    customerId: "a",
    entityId: "team",
    workflowId: "shared",
    idempotencyKey: "shared",
    steps: [
      {
        id: "run",
        budgets: [{ feature: "credits", amount: "1", poolScope: "customer" }],
      },
    ],
  });
  expect(shared.entityId).toBe("team");
  const expiry = Date.UTC(2026, 0, 1) + 5000;
  await billing.credits.grant({
    customerId: "a",
    feature: "temporary",
    amount: "5",
    expiresAt: expiry,
    idempotencyKey: "temporary",
  });
  const bounded = await billing.workflows.create({
    customerId: "a",
    workflowId: "bounded",
    idempotencyKey: "bounded",
    steps: [
      { id: "first", budgets: [{ feature: "temporary", amount: "1" }] },
      { id: "last", budgets: [] },
    ],
  });
  expect(bounded.expiresAt).toBe(expiry);
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .reserved,
  ).toBe("11");
});

test("internal lease recovery is not blocked by pending provider work", async () => {
  const { billing, db, scope, claim, tick } = await setup();
  await claim();
  await db.atomic("test:c:a", (tx) =>
    put(
      tx,
      "work",
      "a-payment",
      {
        id: "a-payment",
        kind: "checkout",
        status: "pending",
        createdAt: Date.UTC(2026, 0, 1),
        availableAt: 0,
        attempts: 0,
        payload: {},
      },
      "pending",
    ),
  );
  tick(1001);
  await billing.maintenance.run({ customerId: "a", limit: 1 });
  expect((await billing.workflows.get(scope)).status).toBe("reconciliation");
});
test("revoked backing grants require reconciliation before a held stage can spend", async () => {
  const { billing, db, claim } = await setup();
  const worker = await claim();
  await db.atomic("test:c:a", async (tx) => {
    const grant = (await tx.list("grants"))[0]!;
    await put(tx, "grants", grant.id, grant.data, "revoked");
  });
  const result = await billing.workflows.complete({
    ...worker,
    actuals: { credits: "2" },
    idempotencyKey: "done",
  });
  expect(result.status).toBe("reconciliation");
  expect((await billing.credits.reconcile("a")).consistent).toBe(true);
});
test("oversized checkpoints fail before committing any usage", async () => {
  const { billing, claim } = await setup();
  const worker = await claim();
  await expect(
    billing.workflows.complete({
      ...worker,
      actuals: { credits: "2" },
      result: { output: "x".repeat(65536) },
      idempotencyKey: "oversized",
    }),
  ).rejects.toMatchObject({ code: "workflow_result_too_large" });
  expect(
    (await billing.credits.balance({ customerId: "a", feature: "credits" }))
      .spent,
  ).toBe("0");
  expect(
    (
      await billing.workflows.complete({
        ...worker,
        actuals: { credits: "2" },
        result: { output: "stored-elsewhere" },
        idempotencyKey: "done",
      })
    ).status,
  ).toBe("succeeded");
});
