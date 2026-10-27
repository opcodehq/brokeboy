import { brokeboy } from "../../src/index.js";
import { memoryAdapter } from "../../src/memory.js";

// Use your durable Drizzle adapter in a deployed application.
const billing = brokeboy({ database: memoryAdapter() });
await billing.customers.create({ id: "team", idempotencyKey: "signup" });
await billing.credits.grant({
  customerId: "team",
  feature: "credits",
  amount: "100",
  idempotencyKey: "opening-credit",
});
const scope = { customerId: "team", workflowId: "research-report" };
await billing.workflows.create({
  ...scope,
  idempotencyKey: "start-report",
  steps: [
    { id: "search", budgets: [{ feature: "credits", amount: "10" }] },
    { id: "analyze", budgets: [{ feature: "credits", amount: "20" }] },
    {
      id: "write",
      dependsOn: ["search", "analyze"],
      budgets: [{ feature: "credits", amount: "30" }],
    },
  ],
});
const costs: Record<string, string> = {
  search: "4",
  analyze: "12",
  write: "18",
};
for (let attempt = 0; attempt < 3; attempt++) {
  const claim = await billing.workflows.claim({
    ...scope,
    workerId: "worker",
    idempotencyKey: `poll-${attempt}`,
  });
  if (!claim.claimed) break;
  // Execute your application job outside a DB transaction. Supply its provider a
  // stable operation key such as `research-report/search` when supported.
  await billing.workflows.complete({
    ...scope,
    stepId: claim.step.id,
    token: claim.step.lease!.token,
    actuals: { credits: costs[claim.step.id]! },
    result: { artifact: `${claim.step.id}.json` },
    idempotencyKey: `complete-${claim.step.id}`,
  });
}
console.log(
  JSON.stringify(
    {
      workflow: await billing.workflows.get(scope),
      balance: await billing.credits.balance({
        customerId: "team",
        feature: "credits",
      }),
      ledger: await billing.credits.reconcile("team"),
    },
    null,
    2,
  ),
);
