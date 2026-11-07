import { Database } from "bun:sqlite";

const path = process.argv[2];
if (!path) throw new Error("A fixture database path is required");
const db = new Database(path);
try {
  db.exec("BEGIN IMMEDIATE");
  console.log("locked");
  await Bun.sleep(250);
  db.exec("ROLLBACK");
} finally {
  db.close();
}
