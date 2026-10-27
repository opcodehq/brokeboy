import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { memoryAdapter } from "../src/memory.js";

test("the browser-targeted root bundle has executable exports without optional peers", async () => {
  const result = await Bun.build({
    entrypoints: ["src/index.ts"],
    target: "browser",
    minify: true,
  });
  expect(result.success).toBe(true);
  const directory = await mkdtemp(join(tmpdir(), "brokeboy-bundle-"));
  try {
    const file = join(directory, "bundle.mjs");
    await Bun.write(file, await result.outputs[0]!.text());
    const root = await import(pathToFileURL(file).href);
    expect(typeof root.brokeboy).toBe("function");
    const billing = root.brokeboy({ database: memoryAdapter() });
    await billing.customers.create({ id: "bundle", idempotencyKey: "create" });
    await billing.credits.grant({
      customerId: "bundle",
      feature: "credits",
      amount: "2",
      idempotencyKey: "grant",
    });
    await billing.usage.consume({
      customerId: "bundle",
      feature: "credits",
      amount: "1",
      idempotencyKey: "use",
    });
    expect(
      (
        await billing.credits.balance({
          customerId: "bundle",
          feature: "credits",
        })
      ).available,
    ).toBe("1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
