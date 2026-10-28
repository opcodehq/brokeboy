import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { drizzleAdapter, migrationSQL } from "../dist/drizzle.js";
import { brokeboy } from "../dist/index.js";

test("D1 atomic batches survive contention, replay, and rollback", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-06-01",
    d1Databases: ["DB"],
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const sql of migrationSQL("d1")) await db.prepare(sql).run();
    const billing = brokeboy({
      database: drizzleAdapter(
        { $client: db },
        { dialect: "d1", retries: 100 },
      ),
    });
    await billing.customers.create({ id: "d1", idempotencyKey: "create" });
    await billing.credits.grant({
      customerId: "d1",
      feature: "credits",
      amount: "10",
      idempotencyKey: "grant",
    });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        billing.usage.consume({
          customerId: "d1",
          feature: "credits",
          amount: "1",
          idempotencyKey: `use-${i}`,
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
    assert.equal(
      (await billing.credits.balance({ customerId: "d1", feature: "credits" }))
        .available,
      "0",
    );
    assert.equal((await billing.credits.reconcile("d1")).consistent, true);
    await assert.rejects(
      billing.usage.consume({
        customerId: "d1",
        feature: "credits",
        amount: "20",
        idempotencyKey: "too-much",
      }),
    );
    assert.equal((await billing.credits.reconcile("d1")).consistent, true);
    const winner = results.findIndex((r) => r.status === "fulfilled");
    await billing.usage.consume({
      customerId: "d1",
      feature: "credits",
      amount: "1",
      idempotencyKey: `use-${winner}`,
    });
    assert.equal((await billing.usage.list({ customerId: "d1" })).length, 10);
    await billing.credits.grant({
      customerId: "d1",
      feature: "credits",
      amount: "10",
      idempotencyKey: "workflow-funds",
    });
    await billing.workflows.create({
      customerId: "d1",
      workflowId: "job",
      idempotencyKey: "start-job",
      steps: [{ id: "run", budgets: [{ feature: "credits", amount: "5" }] }],
    });
    const claims = await Promise.all(
      ["one", "two"].map((workerId) =>
        billing.workflows.claim({
          customerId: "d1",
          workflowId: "job",
          workerId,
          idempotencyKey: `claim-${workerId}`,
        }),
      ),
    );
    assert.equal(claims.filter((c) => c.claimed).length, 1);
    const claimed = claims.find((c) => c.claimed)!;
    if (!claimed.claimed) throw new Error("missing workflow claim");
    const complete = {
      customerId: "d1",
      workflowId: "job",
      stepId: "run",
      token: claimed.step.lease!.token,
      actuals: { credits: "3" },
      idempotencyKey: "complete-job",
    };
    const done = await billing.workflows.complete(complete);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(await billing.workflows.complete(complete), done);
    assert.equal(
      (await billing.credits.balance({ customerId: "d1", feature: "credits" }))
        .available,
      "7",
    );
    assert.equal((await billing.credits.reconcile("d1")).consistent, true);
  } finally {
    await mf.dispose();
  }
});

test("bundled Effect layers execute inside workerd against a native D1 binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brokeboy-effect-worker-"));
  let mf: Miniflare | undefined;
  try {
    const bundle = join(directory, "worker.mjs");
    execFileSync(
      "bun",
      [
        "build",
        fileURLToPath(new URL("./fixtures/effect-worker.ts", import.meta.url)),
        "--target=browser",
        `--outfile=${bundle}`,
      ],
      { stdio: "pipe" },
    );
    mf = new Miniflare({
      modules: true,
      scriptPath: bundle,
      modulesRoot: directory,
      rootPath: directory,
      compatibilityDate: "2026-06-01",
      d1Databases: ["DB"],
    });
    const db = await mf.getD1Database("DB");
    for (const sql of migrationSQL("d1")) await db.prepare(sql).run();
    for (const [key, available] of [
      ["one", "7"],
      ["one", "7"],
      ["two", "4"],
    ]) {
      const response = await mf.dispatchFetch(
        `https://example.test/?key=${key}`,
      );
      assert.equal(response.status, 200);
      const result = (await response.json()) as {
        balance: { available: string };
        ledger: { consistent: boolean };
      };
      assert.equal(result.balance.available, available);
      assert.equal(result.ledger.consistent, true);
    }
  } finally {
    await mf?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
