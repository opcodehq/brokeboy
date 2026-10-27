# Billing complex application jobs

Brokeboy coordinates funding and durable job state in your database. Your workers execute application code. You can use an existing queue, scheduled Worker or server worker; Brokeboy does not require a separate service or execute arbitrary callbacks inside database transactions.

## Reserve before starting

```ts
const scope = { customerId: "team_123", workflowId: "video_456" };
await billing.workflows.create({
  ...scope,
  idempotencyKey: "start-video-456",
  expiresAt: Date.now() + 30 * 60_000,
  steps: [
    { id: "transcribe", budgets: [{ feature: "credits", amount: "20" }] },
    { id: "extract", budgets: [{ feature: "credits", amount: "10" }] },
    {
      id: "summarize",
      dependsOn: ["transcribe", "extract"],
      budgets: [{ feature: "credits", amount: "30" }],
    },
  ],
});
```

Admission atomically reserves every stage's maximum cost, or rolls back the entire workflow. Dependencies must exist and form an acyclic graph. Independent stages can run concurrently; a join becomes available after all its prerequisites succeed. Limits are 32 stages, eight budgets per stage and 32 budgets overall. Stages can have no budget for unbilled work.

Budget amounts and settlement actuals are **prepaid pool units**, such as credits, not dollars or raw model tokens. No implicit pricing conversion occurs inside workflow reservations. Rate your estimate before creating the workflow. Use `usage.batch` for known postpaid events; workflow reservations do not authorize speculative postpaid spending or create Stripe charges.

The deadline defaults to 15 minutes and cannot exceed 30 days. It is shortened to the earliest funding-grant expiry across all stages. Long jobs must use credit grants with an appropriate lifetime. Entity budgets are isolated unless `poolScope: "customer"` explicitly selects the parent's pool.

## Claim, run, settle

```ts
const claim = await billing.workflows.claim({
  ...scope,
  workerId: "worker_1",
  idempotencyKey: crypto.randomUUID(),
  leaseMs: 60_000,
});
if (claim.claimed) {
  // External work runs here, outside any Brokeboy transaction.
  const output = await runYourJob(claim.step.id, {
    providerIdempotencyKey: `${scope.workflowId}/${claim.step.id}`,
  });
  await billing.workflows.complete({
    ...scope,
    stepId: claim.step.id,
    token: claim.step.lease!.token,
    actuals: { credits: output.creditsUsed },
    result: { artifactId: output.artifactId },
    idempotencyKey: `complete-${claim.step.lease!.token}`,
  });
}
```

Only one worker can claim a stage. The lease token fences stale workers. Leases last between one second and 15 minutes; `heartbeat` extends a current lease within the funding deadline. Use a **new claim key for each poll**: a replay of a key returns its original claim, including an original `claimed: false`. Retry the same completion key after a lost response.

Completion atomically settles all stage budgets, records usage with workflow/stage/reservation provenance, and releases unused funds. Persisted results must be JSON, at most 64 KiB per stage, with a 512 KiB limit for the complete workflow state. Store large artifacts elsewhere and return references. Use `get` to read completed prerequisite results after a worker restart.

Use `increase` before exceeding an estimate. Supply the active worker's token, feature, additional amount and reason. Funding the increase is atomic; a shorter-lived grant also shortens the workflow deadline.

## Retry and reconcile

`fail({ code, retrySafe: true, retryAfterMs })` permits another attempt only when the application knows no unaccounted external cost occurred. Attempts default to three and are bounded at 100. Backoff defaults to exponential delay capped at one hour. An exhausted or ambiguous failure enters reconciliation.

A lost worker is **never automatically re-executed**. Maintenance turns its expired lease into reconciliation; claim also detects expired sibling leases even if maintenance has not run. External side effects cannot be made exactly once by a database lease alone. Use provider idempotency and verify ambiguous outcomes before authorizing another attempt.

Late completion preserves reported actuals without silently debiting expired holds. Actuals above the reserved amount also produce reconciliation, with no partial debit. Trusted application code or an authorized administrator resolves the stage with a reason:

- `outcome: "retry"`: confirmed safe to run again; requires valid holds and remaining attempts.
- `outcome: "succeeded"`: record verified actuals and continue the graph.
- `outcome: "failed"`: record verified incurred costs and release unstarted stages. Other running stages still need their own accounting.

An expired hold or an overrun requires `fundUncovered: true` before nonzero actuals can use newly available prepaid funds. This flag never purchases credits or charges a card. Insufficient funds roll back the whole resolution. Verified zero-cost outcomes can release an expired case without additional funding.

`cancel` releases unstarted budgets immediately. In-flight stages enter reconciliation until their actual costs are confirmed. Cancellation does not erase charges already recorded. Every transition and resolution is audited. Fulfillment timeout jobs use the same bounded `maintenance.run` entry point as other billing work and do not require a Stripe connection.

## Inspect and recover

`workflows.get` and `workflows.page` are trusted server APIs. They include lease tokens and internal results; never expose their raw output to ordinary customer browsers. Administrative handlers provide:

- `GET /admin/workflows?customerId=...` with cursor and optional entity ID.
- `GET /admin/workflow?customerId=...&workflowId=...`.
- `POST /admin/workflow/resolve?customerId=...` with explicit actuals, outcome and reason.

All require the application's `authorizeAdmin` callback; resolution reasons include the authenticated actor. The admin customer inspector includes the first workflow page. The CLI supports `brokeboy workflows <customerId> [workflowId] [--entity id]`.

Active or unresolved workflows block customer snapshot migration. Completed workflows, results, receipts and replay keys are included in the migration archive. A restored workflow can replay its original completion without a second debit.

## Atomic usage ingestion and aggregation

```ts
await billing.usage.batch({
  customerId: "team_123",
  idempotencyKey: "batch_789",
  events: [
    { feature: "requests", amount: "1", idempotencyKey: "request_1" },
    {
      feature: "tokens",
      amount: "1200",
      properties: { model: "small" },
      idempotencyKey: "tokens_1",
    },
  ],
});
```

A batch contains 1–100 events for one customer, optionally across entities. Each event has its own globally customer-scoped retry key; those keys work across batches and `usage.consume`. Identical repeated events return their receipts. Altered events conflict. A failed event rolls back every newly recorded event and debit in the batch. Do not reuse the batch's own key as an event key.

`usage.aggregate({ customerId, from, to, groupBy: ["model"], limit, cursor })` scans a bounded receipt page for a half-open time window. It returns exact decimal quantities and charges, grouped separately by feature, pricing version, currency and requested properties. Credits and monetary charges are never added together. Compensating corrections contribute negative quantities. `complete: false` means **partial totals**: continue with `nextCursor` and combine groups across pages. Keep the same explicit time window while paging. This is an inspectable ledger query, not a warehouse or an indexed analytics service.
