// Controlled, local release-addon measurement; no throughput or SLA claim.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = resolve(process.argv[2] ?? "target/npm/platform");
const addon = join(directory, "brokeboy.node");
const fixture = await mkdtemp(join(tmpdir(), "brokeboy-native-benchmark-"));
let billing;
try {
  const { NativeBilling } = createRequire(import.meta.url)(addon);
  const schema = spawnSync(
    join(directory, "brokeboy-native"),
    ["schema", "sqlite"],
    { encoding: "utf8" },
  );
  assert.equal(schema.status, 0, schema.stderr);
  const path = join(fixture, "billing.sqlite");
  const db = new DatabaseSync(path);
  db.exec(schema.stdout);
  db.close();
  const start = performance.now();
  billing = await NativeBilling.open(
    JSON.stringify({
      database: {
        driver: "sqlite",
        url: `sqlite://${path}`,
        maxConnections: 4,
      },
    }),
  );
  const initializationMs = performance.now() - start;
  let sequence = 0;
  async function call(method, value) {
    const id = `measurement-${++sequence}`;
    billing.registerRequest(id);
    return JSON.parse(await billing.call(method, JSON.stringify(value), id));
  }
  await call("customers.create", { id: "benchmark", idempotencyKey: "create" });
  await call("credits.grant", {
    customerId: "benchmark",
    feature: "requests",
    amount: "1000",
    idempotencyKey: "fund",
  });
  const measurements = [];
  for (let i = 0; i < 200; i++) {
    const at = performance.now();
    await call("usage.consume", {
      customerId: "benchmark",
      feature: "requests",
      amount: "1",
      idempotencyKey: `sequential-${i}`,
    });
    measurements.push(performance.now() - at);
  }
  measurements.sort((a, b) => a - b);
  const contended = performance.now();
  await Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      call("usage.consume", {
        customerId: "benchmark",
        feature: "requests",
        amount: "1",
        idempotencyKey: `concurrent-${i}`,
      }),
    ),
  );
  const contendedBatchMs = performance.now() - contended;
  assert.equal(
    (
      await call("credits.balance", {
        customerId: "benchmark",
        feature: "requests",
      })
    ).available,
    "600",
  );
  assert.equal(
    (await call("credits.reconcile", { customerId: "benchmark" })).consistent,
    true,
  );
  console.log(
    JSON.stringify(
      {
        environment: {
          runtime: process.version,
          platform: process.platform,
          arch: process.arch,
          kernel: release(),
          cpu: cpus()[0]?.model,
          database:
            "local file SQLite, four SQLx connections, one customer/grant",
          artifact: "release, thin LTO, stripped",
          samples: 200,
        },
        initializationMs,
        sequential: { p50Ms: measurements[99], p95Ms: measurements[189] },
        contention: { concurrentCalls: 200, batchMs: contendedBatchMs },
        nativeBinaryBytes: (await stat(addon)).size,
        databaseStatementCount: null,
        limits:
          "Database statement tracing is not yet qualified; local measurements exclude payment networking and are not cross-platform guarantees.",
      },
      null,
      2,
    ),
  );
} finally {
  await billing?.close();
  await rm(fixture, { recursive: true, force: true });
}
