import assert from "node:assert/strict";
import { test } from "node:test";
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
  } finally {
    await mf.dispose();
  }
});
