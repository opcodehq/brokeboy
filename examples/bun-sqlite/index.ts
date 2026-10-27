import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { drizzleAdapter, migrationSQL } from "../../src/drizzle.js";
import { brokeboy } from "../../src/index.js";
import { catalog } from "../catalog.js";

const sqlite = new Database(process.env.BILLING_DATABASE ?? ":memory:");
// Demo setup only. Production applications manage migrations separately.
for (const sql of migrationSQL("sqlite")) sqlite.exec(sql);
const billing = brokeboy({
  database: drizzleAdapter(drizzle(sqlite), { dialect: "sqlite" }),
});
await billing.catalog.publish({
  catalog,
  expectedRevision: (await billing.catalog.export()).revision,
});
await billing.customers.create({ id: "demo", idempotencyKey: "demo-create" });
await billing.subscriptions.attach({
  customerId: "demo",
  planId: "free",
  idempotencyKey: "demo-free",
});
await billing.usage.consume({
  customerId: "demo",
  feature: "messages",
  amount: "5",
  idempotencyKey: "demo-message",
});
console.log(
  await billing.credits.balance({ customerId: "demo", feature: "credits" }),
);
sqlite.close();
