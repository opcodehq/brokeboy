import { describe, expect, test } from "bun:test";
import { brokeboy, type Storage } from "../src/index.js";

export function workflowContract(name: string, make: () => Promise<Storage>) {
  describe(`${name} workflow contract`, () => {
    async function setup() {
      const database = await make();
      const billing = brokeboy({ database });
      const customerId = crypto.randomUUID();
      await billing.customers.create({
        id: customerId,
        idempotencyKey: "create",
      });
      await billing.credits.grant({
        customerId,
        feature: "budget",
        amount: "20",
        idempotencyKey: "fund",
      });
      return { billing, customerId, database };
    }
    test("workflow claims serialize and settlement survives restarts and retries", async () => {
      const { billing, customerId, database } = await setup();
      const scope = { customerId, workflowId: "pipeline" };
      await billing.workflows.create({
        ...scope,
        idempotencyKey: "start",
        steps: [
          { id: "prepare", budgets: [{ feature: "budget", amount: "5" }] },
          {
            id: "finish",
            dependsOn: ["prepare"],
            budgets: [{ feature: "budget", amount: "10" }],
          },
        ],
      });
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          billing.workflows.claim({
            ...scope,
            workerId: `w${i}`,
            idempotencyKey: `claim${i}`,
          }),
        ),
      );
      const winners = claims.filter((c) => c.claimed);
      expect(winners).toHaveLength(1);
      const winner = winners[0]!;
      if (!winner.claimed) throw new Error("missing claim");
      const complete = {
        ...scope,
        stepId: "prepare",
        token: winner.step.lease!.token,
        actuals: { budget: "3" },
        idempotencyKey: "complete",
      };
      const receipt = await billing.workflows.complete(complete);
      const resumed = brokeboy({ database });
      expect(await resumed.workflows.complete(complete)).toEqual(receipt);
      const finish = await resumed.workflows.claim({
        ...scope,
        workerId: "restart",
        idempotencyKey: "last-claim",
      });
      if (!finish.claimed) throw new Error("dependent step not ready");
      const done = await resumed.workflows.complete({
        ...scope,
        stepId: "finish",
        token: finish.step.lease!.token,
        actuals: { budget: "7" },
        idempotencyKey: "finish",
      });
      expect(done.status).toBe("succeeded");
      expect(
        (await resumed.credits.balance({ customerId, feature: "budget" }))
          .available,
      ).toBe("10");
      expect((await resumed.credits.reconcile(customerId)).consistent).toBe(
        true,
      );
    });
    test("multi-feature admission and usage batches commit entirely or roll back", async () => {
      const { billing, customerId } = await setup();
      await expect(
        billing.workflows.create({
          customerId,
          workflowId: "denied",
          idempotencyKey: "deny",
          steps: [
            {
              id: "step",
              budgets: [
                { feature: "budget", amount: "10" },
                { feature: "unfunded", amount: "1" },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "insufficient_balance" });
      expect(
        (await billing.credits.balance({ customerId, feature: "budget" }))
          .reserved,
      ).toBe("0");
      const good = { feature: "budget", amount: "3", idempotencyKey: "event1" };
      await expect(
        billing.usage.batch({
          customerId,
          idempotencyKey: "batch-fail",
          events: [
            good,
            { feature: "unfunded", amount: "1", idempotencyKey: "event2" },
          ],
        }),
      ).rejects.toMatchObject({ code: "insufficient_balance" });
      expect(
        (await billing.credits.balance({ customerId, feature: "budget" }))
          .available,
      ).toBe("20");
      const batch = await billing.usage.batch({
        customerId,
        idempotencyKey: "batch",
        events: [good],
      });
      expect(await billing.usage.consume({ ...good, customerId })).toEqual(
        batch.receipts[0]!,
      );
      await billing.usage.batch({
        customerId,
        idempotencyKey: "another-batch",
        events: [good],
      });
      expect(
        (await billing.credits.balance({ customerId, feature: "budget" }))
          .available,
      ).toBe("17");
      expect((await billing.credits.reconcile(customerId)).consistent).toBe(
        true,
      );
    });
  });
}
