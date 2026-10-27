import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzleAdapter, migrationSQL } from "../dist/drizzle.js";
import { brokeboy } from "../dist/index.js";

test("Node native SQLite persists billing across engine restarts", async () => {
  const db = new Database(":memory:");
  for (const sql of migrationSQL("sqlite")) db.exec(sql);
  const storage = drizzleAdapter(drizzle(db), { dialect: "sqlite" });
  const first = brokeboy({ database: storage });
  await first.customers.create({ id: "restart", idempotencyKey: "create" });
  await first.credits.grant({
    customerId: "restart",
    feature: "credits",
    amount: "10",
    idempotencyKey: "grant",
  });
  const result = await first.usage.consume({
    customerId: "restart",
    feature: "credits",
    amount: "3",
    idempotencyKey: "spend",
  });
  const restarted = brokeboy({ database: storage });
  assert.deepEqual(
    await restarted.usage.consume({
      customerId: "restart",
      feature: "credits",
      amount: "3",
      idempotencyKey: "spend",
    }),
    result,
  );
  assert.equal(
    (
      await restarted.credits.balance({
        customerId: "restart",
        feature: "credits",
      })
    ).available,
    "7",
  );
  db.close();
});
test("SQLite backup restores receipts and balances on a new connection", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "brokeboy-backup-"));
  const source = new Database(join(dir, "source.sqlite"));
  let restored: Database.Database | undefined;
  try {
    for (const sql of migrationSQL("sqlite")) source.exec(sql);
    const billing = brokeboy({
      database: drizzleAdapter(drizzle(source), { dialect: "sqlite" }),
    });
    await billing.customers.create({ id: "restore", idempotencyKey: "create" });
    await billing.credits.grant({
      customerId: "restore",
      feature: "credits",
      amount: "10",
      idempotencyKey: "grant",
    });
    const input = {
      customerId: "restore",
      feature: "credits",
      amount: "4",
      idempotencyKey: "use",
    };
    const receipt = await billing.usage.consume(input);
    await source.backup(join(dir, "backup.sqlite"));
    source.close();
    restored = new Database(join(dir, "backup.sqlite"));
    const recovered = brokeboy({
      database: drizzleAdapter(drizzle(restored), { dialect: "sqlite" }),
    });
    assert.deepEqual(await recovered.usage.consume(input), receipt);
    assert.equal(
      (
        await recovered.credits.balance({
          customerId: "restore",
          feature: "credits",
        })
      ).available,
      "6",
    );
    assert.equal(
      (await recovered.credits.reconcile("restore")).consistent,
      true,
    );
  } finally {
    if (source.open) source.close();
    restored?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
