import { Database } from "bun:sqlite";

const path = process.argv[2];
if (!path) throw new Error("A fixture database path is required");
const db = new Database(path);
try {
  db.exec("BEGIN IMMEDIATE");
  console.log("locked");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      process.exitCode = 1;
      resolve();
    }, 10_000);
    process.stdin.once("data", (data) => {
      clearTimeout(timeout);
      if (String(data).trim() !== "release") process.exitCode = 1;
      resolve();
    });
  });
  process.stdin.destroy();
  db.exec("ROLLBACK");
} finally {
  db.close();
}
