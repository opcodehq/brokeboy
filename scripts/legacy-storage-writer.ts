// Cross-process storage contract. Only dedicated test databases may invoke this.
import { Database } from "bun:sqlite";
import mysql from "mysql2/promise";
import pg from "pg";
import { drizzleAdapter } from "../src/drizzle.js";

const dialect = process.argv[2];
const scope = process.argv[3];
if (!scope?.startsWith("test:c:rust-"))
  throw new Error("A test scope is required");
const url = process.env.BROKEBOY_CONTRACT_DATABASE;
if (!url) throw new Error("A contract database is required");
let client: Database | pg.Pool | mysql.Pool;
let close: () => void | Promise<void>;
if (dialect === "sqlite") {
  client = new Database(url);
  client.exec("PRAGMA busy_timeout=15000");
  close = () => (client as Database).close();
} else if (dialect === "postgres") {
  client = new pg.Pool({ connectionString: url });
  close = () => (client as pg.Pool).end();
} else if (dialect === "mysql") {
  client = mysql.createPool(url);
  close = () => (client as mysql.Pool).end();
} else throw new Error("Unsupported contract dialect");
try {
  const storage = drizzleAdapter({ $client: client }, { dialect });
  for (let i = 0; i < 20; i++) {
    await storage.atomic(scope, async (tx) => {
      const row = await tx.get<{ count: number }>("counters", "mixed-writers");
      if (!row) throw new Error("Missing contract counter");
      await Bun.sleep(1);
      await tx.put("counters", { ...row, data: { count: row.data.count + 1 } });
    });
  }
} finally {
  await close();
}
