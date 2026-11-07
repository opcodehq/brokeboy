// Reuse the 0.1 domain contract unchanged against the native public facade.
import { Database } from "bun:sqlite";
import { afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { drizzleAdapter, migrationSQL } from "../src/drizzle.js";
import type { Storage } from "../src/index.js";
import { Billing } from "../src/native.js";
import { loadNative, type NativeHandle } from "../src/native-loader.js";
import type { OpenBilling } from "./billing-harness.js";
import { engineContract } from "./engine.test.js";
import { workflowScenarios } from "./workflows.test.js";

const fixtures = new WeakMap<Storage, string>();
const databases: Database[] = [];
const directories: string[] = [];
const handles: NativeHandle[] = [];
const makeFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "brokeboy-parity-"));
  directories.push(directory);
  const path = join(directory, "billing.sqlite");
  const db = new Database(path, { create: true });
  databases.push(db);
  for (const sql of migrationSQL("sqlite")) db.exec(sql);
  const storage = drizzleAdapter(drizzle(db), { dialect: "sqlite" });
  fixtures.set(storage, path);
  return storage;
};
const openNative: OpenBilling = async (options) => {
  const path = fixtures.get(options.database);
  if (!path || options.provider || options.hooks)
    throw new Error("Unsupported parity fixture configuration");
  const now = options.now ?? Date.now;
  const handle = await loadNative().NativeBilling.open(
    JSON.stringify({
      database: {
        driver: "sqlite",
        url: `sqlite://${path}`,
        maxConnections: 4,
      },
      testClockMs: now(),
    }),
  );
  handles.push(handle);
  const timed = new Proxy(handle, {
    get(target, key) {
      if (key === "call")
        return (...args: Parameters<NativeHandle["call"]>) => {
          (
            handle as NativeHandle & { setTestClock(time: number): void }
          ).setTestClock(now());
          return target.call(...args);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // Keep clock injection internal to qualification; normal consumers use Billing.open.
  return Reflect.construct(Billing, [timed, "test"]) as Billing;
};
engineContract(
  "native Rust SQLite parity",
  makeFixture,
  openNative,
  makeFixture,
);
workflowScenarios("native Rust workflow scenarios", makeFixture, openNative);

afterAll(async () => {
  for (const handle of handles) await handle.close();
  for (const db of databases) db.close();
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});
