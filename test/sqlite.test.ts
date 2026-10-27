import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { drizzleAdapter, migrationSQL } from "../src/drizzle.js";
import { engineContract } from "./engine.test.js";

engineContract("bun sqlite", async () => {
  const db = new Database(":memory:");
  for (const sql of migrationSQL("sqlite")) db.exec(sql);
  return drizzleAdapter(drizzle(db), { dialect: "sqlite" });
});
