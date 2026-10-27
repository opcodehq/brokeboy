import { afterAll } from "bun:test";
import { drizzle as mysqlDrizzle } from "drizzle-orm/mysql2";
import { drizzle as pgDrizzle } from "drizzle-orm/node-postgres";
import mysql from "mysql2/promise";
import { Pool } from "pg";
import { drizzleAdapter, migrationSQL } from "../src/drizzle.js";
import { engineContract } from "./engine.test.js";

const pools: { end: () => Promise<void> }[] = [];
if (process.env.TEST_POSTGRES_URL) {
  const pool = new Pool({
    connectionString: process.env.TEST_POSTGRES_URL,
    max: 12,
  });
  pools.push(pool);
  let ready: Promise<void> | undefined;
  engineContract("postgres", async () => {
    ready ??= (async () => {
      for (const sql of migrationSQL("postgres")) await pool.query(sql);
    })();
    await ready;
    return drizzleAdapter(pgDrizzle(pool), { dialect: "postgres" });
  });
}
if (process.env.TEST_MYSQL_URL) {
  const pool = mysql.createPool(process.env.TEST_MYSQL_URL);
  pools.push(pool);
  let ready: Promise<void> | undefined;
  engineContract("mysql", async () => {
    ready ??= (async () => {
      for (const sql of migrationSQL("mysql")) await pool.query(sql);
    })();
    await ready;
    return drizzleAdapter(mysqlDrizzle(pool), { dialect: "mysql" });
  });
}
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});
