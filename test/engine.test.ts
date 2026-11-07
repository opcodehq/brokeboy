import { describe, expect, test } from "bun:test";
import type { Storage } from "../src/index.js";
import {
  addInterval,
  brokeboy,
  defineCatalog,
  rateUsage,
} from "../src/index.js";
import { memoryAdapter } from "../src/memory.js";
import type { OpenBilling } from "./billing-harness.js";
import { workflowContract } from "./workflows.contract.js";

const catalog = defineCatalog({
  features: [
    { id: "credits", kind: "consumable" },
    { id: "messages", kind: "consumable" },
    { id: "seats", kind: "quantity" },
    { id: "sso", kind: "boolean" },
  ],
  plans: [
    {
      id: "free",
      name: "Free",
      kind: "free",
      items: [
        { feature: "credits", included: "100", reset: "month" },
        { feature: "messages", pool: "credits", rate: { amount: "2" } },
        { feature: "seats", included: "3", reset: "never" },
        { feature: "sso", enabled: true },
      ],
    },
    {
      id: "metered",
      name: "Metered",
      kind: "free",
      currency: "usd",
      interval: "month",
      items: [
        {
          feature: "messages",
          included: "10",
          overage: true,
          rate: { amount: "0.1" },
        },
      ],
    },
  ],
});
export function engineContract(
  name: string,
  make: () => Promise<Storage>,
  open: OpenBilling = brokeboy,
  makeTarget: () => Promise<Storage> = async () => memoryAdapter(),
) {
  workflowContract(name, make, open);
  describe(name, () => {
    async function setup() {
      let now = Date.UTC(2026, 0, 31);
      const db = await make();
      const billing = await open({ database: db, now: () => now });
      const current = await billing.catalog.export();
      await billing.catalog.publish({
        catalog,
        expectedRevision: current.revision,
      });
      const id = crypto.randomUUID();
      await billing.customers.create({ id, idempotencyKey: "create" });
      await billing.subscriptions.attach({
        customerId: id,
        planId: "free",
        idempotencyKey: "attach",
      });
      return {
        billing,
        id,
        db,
        tick: (n: number) => {
          now = n;
        },
      };
    }
    test("simultaneous spending has a single winner per remaining unit", async () => {
      const { billing, id } = await setup();
      const attempts = await Promise.allSettled(
        Array.from({ length: 80 }, (_, i) =>
          billing.usage.consume({
            customerId: id,
            feature: "messages",
            amount: "1",
            idempotencyKey: `spend-${i}`,
          }),
        ),
      );
      expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(50);
      expect(
        (await billing.credits.balance({ customerId: id, feature: "credits" }))
          .available,
      ).toBe("0");
      expect((await billing.credits.reconcile(id)).consistent).toBe(true);
    });
    test("retries replay results and reject altered payloads", async () => {
      const { billing, id } = await setup();
      const input = {
        customerId: id,
        feature: "credits",
        amount: "1.123456",
        idempotencyKey: "same",
      };
      const a = await billing.usage.consume(input);
      expect(await billing.usage.consume(input)).toEqual(a);
      await expect(
        billing.usage.consume({ ...input, amount: "2" }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(
        (await billing.credits.balance({ customerId: id, feature: "credits" }))
          .available,
      ).toBe("98.876544");
    });
    test("failed allocation rolls back partial movements", async () => {
      const { billing, id } = await setup();
      await expect(
        billing.usage.consume({
          customerId: id,
          feature: "credits",
          amount: "101",
          idempotencyKey: "too-much",
        }),
      ).rejects.toMatchObject({ code: "insufficient_balance" });
      expect(
        (await billing.credits.balance({ customerId: id, feature: "credits" }))
          .available,
      ).toBe("100");
      expect((await billing.credits.reconcile(id)).consistent).toBe(true);
    });
    test("reservation settlement consumes actual usage and releases change", async () => {
      const { billing, id } = await setup();
      const r = await billing.reservations.create({
        customerId: id,
        feature: "credits",
        amount: "80",
        idempotencyKey: "reserve",
      });
      expect(
        (await billing.credits.balance({ customerId: id, feature: "credits" }))
          .available,
      ).toBe("20");
      await billing.reservations.settle({
        customerId: id,
        reservationId: r.id,
        amount: "25",
        idempotencyKey: "settle",
      });
      expect(
        (await billing.credits.balance({ customerId: id, feature: "credits" }))
          .available,
      ).toBe("75");
      expect((await billing.credits.reconcile(id)).consistent).toBe(true);
    });
    test("expired reservation and late settlement retain reconciliation evidence", async () => {
      const { billing, id, tick } = await setup();
      const r = await billing.reservations.create({
        customerId: id,
        feature: "credits",
        amount: "20",
        idempotencyKey: "reserve",
        expiresAt: Date.UTC(2026, 0, 31, 0, 1),
      });
      tick(Date.UTC(2026, 0, 31, 0, 2));
      const result = await billing.reservations.settle({
        customerId: id,
        reservationId: r.id,
        amount: "10",
        idempotencyKey: "late",
      });
      expect(result.status).toBe("reconciliation");
      expect(
        (await billing.credits.balance({ customerId: id, feature: "credits" }))
          .available,
      ).toBe("100");
      expect((await billing.operations.list(id))[0]?.status).toBe(
        "reconciliation",
      );
    });
    test("usage corrections append reversals and reject duplicate correction", async () => {
      const { billing, id } = await setup();
      const u = await billing.usage.consume({
        customerId: id,
        feature: "credits",
        amount: "13",
        idempotencyKey: "use",
      });
      await billing.usage.correct({
        customerId: id,
        usageId: u.id,
        reason: "failed work",
        idempotencyKey: "reverse",
      });
      expect(
        (await billing.credits.balance({ customerId: id, feature: "credits" }))
          .available,
      ).toBe("100");
      expect(await billing.usage.list({ customerId: id })).toHaveLength(2);
      await expect(
        billing.usage.correct({
          customerId: id,
          usageId: u.id,
          reason: "again",
          idempotencyKey: "reverse2",
        }),
      ).rejects.toMatchObject({ code: "already_corrected" });
    });
    test("renewals preserve end-of-month anchors", async () => {
      const { billing, id, tick } = await setup();
      await billing.usage.consume({
        customerId: id,
        feature: "credits",
        amount: "50",
        idempotencyKey: "use",
      });
      tick(Date.UTC(2026, 1, 28));
      expect(
        (await billing.credits.balance({ customerId: id, feature: "credits" }))
          .available,
      ).toBe("100");
      tick(Date.UTC(2026, 2, 30));
      await billing.usage.consume({
        customerId: id,
        feature: "credits",
        amount: "25",
        idempotencyKey: "use2",
      });
      expect(
        (await billing.credits.balance({ customerId: id, feature: "credits" }))
          .available,
      ).toBe("75");
      tick(Date.UTC(2026, 2, 31));
      expect(
        (await billing.credits.balance({ customerId: id, feature: "credits" }))
          .available,
      ).toBe("100");
    });
    test("catalog conflicts preserve grandfathered versions", async () => {
      const { billing, id } = await setup();
      const old = (await billing.subscriptions.list(id))[0]!.plan;
      await billing.catalog.publish({
        catalog: {
          ...catalog,
          plans: catalog.plans.map((p) => ({ ...p, name: `${p.name} v2` })),
        },
        expectedRevision: (await billing.catalog.export()).revision,
      });
      expect((await billing.subscriptions.list(id))[0]!.plan.version).toBe(
        old.version,
      );
      await expect(
        billing.catalog.publish({ catalog, expectedRevision: 0 }),
      ).rejects.toMatchObject({ code: "catalog_conflict" });
    });
    test("seat assignment and release preserve ledger", async () => {
      const { billing, id } = await setup();
      await billing.entities.create({
        customerId: id,
        id: "member",
        idempotencyKey: "entity",
      });
      const license = await billing.licenses.assign({
        customerId: id,
        entityId: "member",
        feature: "seats",
        idempotencyKey: "assign",
      });
      expect(
        (await billing.credits.balance({ customerId: id, feature: "seats" }))
          .available,
      ).toBe("2");
      await billing.licenses.release({
        customerId: id,
        licenseId: license.id,
        idempotencyKey: "release",
      });
      expect(
        (await billing.credits.balance({ customerId: id, feature: "seats" }))
          .available,
      ).toBe("3");
      expect((await billing.credits.reconcile(id)).consistent).toBe(true);
    });
    test("migration preserves remaining balances with replay protection", async () => {
      const { billing, id } = await setup();
      await billing.usage.consume({
        customerId: id,
        feature: "credits",
        amount: "33",
        idempotencyKey: "use",
      });
      const snapshot = await billing.migration.export(id);
      const other = await open({
        database: await makeTarget(),
        now: () => Date.UTC(2026, 0, 31),
      });
      await other.migration.import({ snapshot, idempotencyKey: "import" });
      await other.migration.import({ snapshot, idempotencyKey: "import" });
      expect(
        (await other.credits.balance({ customerId: id, feature: "credits" }))
          .available,
      ).toBe("67");
      expect((await other.credits.reconcile(id)).consistent).toBe(true);
    });
    test("persistent seat capacity survives renewal and reassignment", async () => {
      const { billing, id, tick } = await setup();
      await billing.entities.create({
        customerId: id,
        id: "member",
        idempotencyKey: "member",
      });
      const license = await billing.licenses.assign({
        customerId: id,
        entityId: "member",
        feature: "seats",
        idempotencyKey: "assign",
      });
      await billing.licenses.release({
        customerId: id,
        licenseId: license.id,
        idempotencyKey: "release",
      });
      await billing.licenses.assign({
        customerId: id,
        entityId: "member",
        feature: "seats",
        idempotencyKey: "reassign",
      });
      tick(Date.UTC(2026, 2, 31));
      expect(
        (await billing.credits.balance({ customerId: id, feature: "seats" }))
          .available,
      ).toBe("2");
    });
    test("usage pages preserve an explicit continuation cursor", async () => {
      const { billing, id } = await setup();
      for (let i = 0; i < 3; i++)
        await billing.usage.consume({
          customerId: id,
          feature: "credits",
          amount: "1",
          idempotencyKey: `page-${i}`,
        });
      const first = await billing.usage.page({ customerId: id, limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeDefined();
      const second = await billing.usage.page({
        customerId: id,
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(second.items).toHaveLength(1);
      expect(
        new Set([...first.items, ...second.items].map((u) => u.id)).size,
      ).toBe(3);
    });
    test("rollover cap bounds all active rollover grants", async () => {
      const { billing, id, tick } = await setup();
      const current = await billing.catalog.export();
      await billing.catalog.publish({
        catalog: {
          features: [...catalog.features, { id: "roll", kind: "consumable" }],
          plans: [
            {
              id: "roll",
              name: "Roll",
              kind: "free",
              addOn: true,
              items: [
                {
                  feature: "roll",
                  included: "10",
                  reset: "month",
                  rollover: { maximum: "5", periods: 2 },
                },
              ],
            },
          ],
        },
        expectedRevision: current.revision,
      });
      await billing.subscriptions.attach({
        customerId: id,
        planId: "roll",
        idempotencyKey: "roll",
      });
      tick(Date.UTC(2026, 2, 31));
      expect(
        (await billing.credits.balance({ customerId: id, feature: "roll" }))
          .available,
      ).toBe("15");
    });
  });
}
engineContract("memory", async () => memoryAdapter());
describe("pricing", () => {
  test("graduated and volume pricing use exact arithmetic", () => {
    expect(
      rateUsage(
        {
          mode: "graduated",
          tiers: [
            { upTo: "10", amount: "1" },
            { upTo: null, amount: "0.5" },
          ],
        },
        "15",
      ),
    ).toBe("12.5");
    expect(
      rateUsage(
        {
          mode: "volume",
          tiers: [
            { upTo: "10", amount: "1" },
            { upTo: null, amount: "0.5" },
          ],
        },
        "15",
      ),
    ).toBe("7.5");
    expect(rateUsage({ amount: "0.000001" }, "1000000")).toBe("1");
  });
  test("ambiguous dimensional rates fail explicitly", () => {
    expect(() =>
      rateUsage(
        {
          dimensions: [
            { match: { model: "a" }, amount: "1" },
            { match: { model: "a" }, amount: "2" },
          ],
        },
        "1",
        { model: "a" },
      ),
    ).toThrow();
  });
  test("calendar arithmetic clamps and handles leap days", () => {
    expect(addInterval(Date.UTC(2024, 1, 29), "year")).toBe(
      Date.UTC(2025, 1, 28),
    );
  });
});
