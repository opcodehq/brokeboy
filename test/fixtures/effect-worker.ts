import { Effect } from "effect";
import { type D1Client, drizzleStorage } from "../../src/drizzle.js";
import { BillingService, layer } from "../../src/effect.js";

export default {
  fetch(request: Request, env: { DB: D1Client }) {
    const key = new URL(request.url).searchParams.get("key")!;
    return Effect.runPromise(
      Effect.gen(function* () {
        const billing = yield* BillingService;
        yield* billing.customers.create({
          id: "worker",
          idempotencyKey: "create",
        });
        yield* billing.credits.grant({
          customerId: "worker",
          feature: "credits",
          amount: "10",
          idempotencyKey: "fund",
        });
        yield* billing.usage.consume({
          customerId: "worker",
          feature: "credits",
          amount: "3",
          idempotencyKey: key,
        });
        return Response.json({
          balance: yield* billing.credits.balance({
            customerId: "worker",
            feature: "credits",
          }),
          ledger: yield* billing.credits.reconcile("worker"),
        });
      }).pipe(
        Effect.provide(
          layer({
            database: drizzleStorage({ $client: env.DB }, { dialect: "d1" }),
          }),
        ),
      ),
    );
  },
};
