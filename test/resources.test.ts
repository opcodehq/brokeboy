import { expect, test } from "bun:test";
import { memoryAdapter } from "../src/memory.js";
import { resourceRegistry } from "../src/storage/resources.js";

test("resource mappings survive provider idempotency retention and registry restarts", async () => {
  let now = 0,
    created = 0;
  const db = memoryAdapter();
  let registry = resourceRegistry(db, "test", () => now);
  const create = async () => `resource-${++created}`;
  expect(await registry.getOrCreate("price", create)).toBe("resource-1");
  now += 48 * 60 * 60_000;
  registry = resourceRegistry(db, "test", () => now);
  expect(await registry.getOrCreate("price", create)).toBe("resource-1");
  expect(created).toBe(1);
});
test("concurrent resource creation is coordinated across callers", async () => {
  let created = 0;
  const registry = resourceRegistry(memoryAdapter(), "test", Date.now);
  const result = await Promise.all(
    Array.from({ length: 10 }, () =>
      registry.getOrCreate("shared", async () => {
        created++;
        await new Promise((r) => setTimeout(r, 5));
        return "resource";
      }),
    ),
  );
  expect(new Set(result).size).toBe(1);
  expect(created).toBe(1);
});
test("ambiguous old creation is retained for reconciliation instead of repeated", async () => {
  let now = 0;
  const registry = resourceRegistry(memoryAdapter(), "test", () => now);
  await expect(
    registry.getOrCreate("price", async () => {
      throw new Error("lost response");
    }),
  ).rejects.toThrow();
  now = 24 * 60 * 60_000;
  let called = false;
  await expect(
    registry.getOrCreate("price", async () => {
      called = true;
      return "duplicate";
    }),
  ).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(called).toBe(false);
});
test("confirmed resource identity resolves an old ambiguous attempt without recreation", async () => {
  let now = 0;
  const storage = memoryAdapter();
  const registry = resourceRegistry(storage, "test", () => now);
  await expect(
    registry.getOrCreate("price:version", async () => {
      throw new Error("response lost");
    }),
  ).rejects.toThrow();
  now = 24 * 60 * 60_000;
  await registry.resolve(
    "price:version",
    "price_verified",
    "Verified the price in the provider account.",
  );
  expect((await registry.inspect("price:version"))?.id).toBe("price_verified");
  expect(
    await registry.getOrCreate("price:version", async () => {
      throw new Error("must not recreate");
    }),
  ).toBe("price_verified");
  await expect(
    registry.resolve(
      "price:version",
      "different",
      "Trying to replace an existing mapping",
    ),
  ).rejects.toMatchObject({ code: "resource_mapping_conflict" });
});
