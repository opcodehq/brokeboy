import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { drizzleAdapter, migrationSQL } from "../../src/drizzle.js";
import { brokeboy } from "../../src/index.js";
import { catalog } from "../catalog.js";

const pool = mysql.createPool(
  process.env.TEST_MYSQL_URL ??
    process.env.BILLING_DATABASE_URL ??
    "mysql://root@127.0.0.1:3306/brokeboy",
);
// Demo setup only; schema generation is available through brokeboy/schema/mysql.
for (const sql of migrationSQL("mysql")) await pool.query(sql);
const billing = brokeboy({
  database: drizzleAdapter(drizzle(pool), { dialect: "mysql" }),
});
await billing.catalog.publish({
  catalog,
  expectedRevision: (await billing.catalog.export()).revision,
});
const customerId = crypto.randomUUID();
await billing.customers.create({ id: customerId, idempotencyKey: "create" });
await billing.subscriptions.attach({
  customerId,
  planId: "free",
  idempotencyKey: "free",
});
console.log(await billing.credits.balance({ customerId, feature: "credits" }));
await pool.end();
