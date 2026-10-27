import { Database } from "bun:sqlite";
import { gzipSync } from "node:zlib";
import { drizzleAdapter, migrationSQL } from "../src/drizzle.js";
import { brokeboy } from "../src/index.js";

const sqlite = new Database(":memory:");
for (const sql of migrationSQL("sqlite")) sqlite.exec(sql);
let queries = 0;
const counted = new Proxy(sqlite, {
  get(target, key) {
    if (key === "prepare" || key === "query")
      return (...args: unknown[]) => {
        queries++;
        return (target[key] as (...args: unknown[]) => unknown).apply(
          target,
          args,
        );
      };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const billing = brokeboy({
  database: drizzleAdapter({ $client: counted }, { dialect: "sqlite" }),
});
await billing.customers.create({ id: "bench", idempotencyKey: "create" });
await billing.credits.grant({
  customerId: "bench",
  feature: "credits",
  amount: "10000",
  idempotencyKey: "grant",
});
const samples: number[] = [];
queries = 0;
for (let i = 0; i < 200; i++) {
  const start = performance.now();
  await billing.usage.consume({
    customerId: "bench",
    feature: "credits",
    amount: "1",
    idempotencyKey: `spend-${i}`,
  });
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const build = await Bun.build({
  entrypoints: ["src/index.ts"],
  target: "browser",
  minify: true,
});
if (!build.success) throw new Error("Browser bundle failed");
const source = await build.outputs[0]!.arrayBuffer();
console.log(
  JSON.stringify(
    {
      runtime: `Bun ${Bun.version}`,
      database: "in-memory SQLite, one customer, one grant",
      samples: samples.length,
      p50Milliseconds: samples[99],
      p95Milliseconds: samples[189],
      databaseStatementsPerConsumption: queries / samples.length,
      rootBundleBytes: source.byteLength,
      rootBundleGzipBytes: gzipSync(Buffer.from(source)).byteLength,
      scope:
        "Local microbenchmark; not a networked database or production SLA.",
    },
    null,
    2,
  ),
);
sqlite.close();
