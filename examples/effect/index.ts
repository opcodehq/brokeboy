import { Effect } from "effect";
import { BillingService, layer } from "../../src/effect.js";
import { memoryStorage } from "../../src/memory.js";

const program = Effect.gen(function* () {
  const billing = yield* BillingService;
  yield* billing.customers.create({ id: "team", idempotencyKey: "signup" });
  yield* billing.credits.grant({
    customerId: "team",
    feature: "credits",
    amount: "100",
    idempotencyKey: "opening-credit",
  });
  const scope = { customerId: "team", workflowId: "report" };
  yield* billing.workflows.create({
    ...scope,
    idempotencyKey: "start",
    steps: [
      { id: "research", budgets: [{ feature: "credits", amount: "20" }] },
      {
        id: "write",
        dependsOn: ["research"],
        budgets: [{ feature: "credits", amount: "30" }],
      },
    ],
  });
  for (const [index, amount] of ["12", "18"].entries()) {
    const claim = yield* billing.workflows.claim({
      ...scope,
      workerId: "worker",
      idempotencyKey: `claim-${index}`,
    });
    if (!claim.claimed) break;
    yield* billing.workflows.complete({
      ...scope,
      stepId: claim.step.id,
      token: claim.step.lease!.token,
      actuals: { credits: amount },
      result: { artifactId: `artifact-${index}` },
      idempotencyKey: `complete-${index}`,
    });
  }
  return {
    workflow: yield* billing.workflows.get(scope),
    balance: yield* billing.credits.balance({
      customerId: "team",
      feature: "credits",
    }),
    ledger: yield* billing.credits.reconcile("team"),
  };
}).pipe(Effect.provide(layer({ database: memoryStorage() })));
console.log(JSON.stringify(await Effect.runPromise(program), null, 2));
