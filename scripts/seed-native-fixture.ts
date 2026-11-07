import { Database } from "bun:sqlite";
import { migrationSQL } from "../src/drizzle.js";

const path = process.argv[2];
if (!path) throw new Error("A fixture database path is required");
const db = new Database(path, { create: true });
for (const sql of migrationSQL("sqlite")) db.exec(sql);
db.query(
  "INSERT INTO brokeboy_customers (scope,id,state,data) VALUES (?,?,?,?)",
).run(
  "test:c:native",
  "native",
  "active",
  JSON.stringify({
    id: "native",
    metadata: { future: "preserved" },
    controls: {},
  }),
);
db.close();
