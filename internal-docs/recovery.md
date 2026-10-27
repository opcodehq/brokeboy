# Operations and recovery

## Routine maintenance

Schedule `billing.maintenance.run({limit:100})` every minute. The engine persists its customer scan position. It returns processed work and whether more remains. Run additional bounded batches when backlog grows; do not depend on a serverless process continuing after a response.

Application notification callbacks may receive an event more than once after a crash. Deduplicate by event ID. Monitor failed work, reconciliation cases, queue age and repeated contention errors.

## Interrupted usage

Retry with the original customer, idempotency key and payload. A committed operation returns its original serialized result. A different payload under the same key fails. Never generate a new key merely because the previous response was lost.

For long-running work, persist the reservation ID alongside the job. Set a realistic expiry, increase the hold before exceeding it, and settle or release explicitly. Expiry cannot prove external work stopped. Late actual usage is preserved in a reconciliation case.

## Interrupted Stripe calls

Inspect `operations.get`/`list`. Failed operations retry with the same external key and a bounded backoff. Requests outside the safe provider window become reconciliation cases. A resource-creation case includes its logical key in operation details. Inspect it with `resources.inspect`; after finding the matching external resource, use `resources.reconcile({key,id,reason})`. This verifies provider metadata and persists the confirmed identity.

Determine the external outcome from Stripe before applying a compensating adjustment and resolving the operation with an audit reason. `operations.reconcile`/`resolve` can record a verified result. Use `outcome: "not_executed"` only after confirming that the external action did not happen; it releases the corresponding checkout or top-up intent for a new attempt.

Do not delete operation, resource-mapping or webhook records to restart an attempt.

Resource mappings also record their first creation attempt. If a customer/product/price creation succeeded but its response was lost, retries within the provider window retain the original identity. An unresolved old creation intentionally blocks another resource creation until reviewed.

## Invoice closing

Configure Stripe's invoice finalization grace period to match your maximum expected export lag. The initial exporter assumes the standard one-hour window and refuses automatic late export rather than promising an already finalized invoice will change. Reconcile delayed items and issue explicit adjustments. Custom finalization schedules require qualification before production use.

## Backup and restore exercise

1. Stop new writes and maintenance for the test application.
2. Take a consistent database backup including all billing tables and external resource mappings.
3. Restore it into an isolated database, with outbound payment execution disabled.
4. Run `credits.reconcile` for representative accounts and compare catalog versions, paid-through dates and reservations.
5. Replay a previously committed usage key; verify the same receipt and unchanged balance.
6. Compare outstanding work and provider state before enabling any external execution.

A customer snapshot is a migration aid, not a full database backup. Imports preserve grant provenance, expiry, opening spent balances, subscription snapshots, license assignments and persistent quantity occupancy. Dry runs report blockers; unfinished financial work and open postpaid periods require reconciliation before importing. Live reservations must be settled or reconciled before importing. Imports are idempotent and do not automatically charge or rewrite external subscriptions.

To link existing Stripe subscriptions, verify the application's customer mapping, call `customers.update` with the verified Stripe customer ID, then `migration.linkSubscription` with an explicit plan mapping. This operation modifies subscription metadata and reconciles current state; it does not transfer payment data between accounts. Do not run two active charging engines during cutover.

## Workflow upgrade and recovery

Generate the additive `brokeboy_workflows` table and state index using your normal Drizzle migration workflow before invoking workflows or customer exports with this version. Brokeboy does not apply it at startup. `migrationSQL` also emits idempotent table/index creation for a reviewed manual installation. No existing financial rows are rewritten.

Worker lease expiry does not prove external work stopped. Inspect the upstream operation before resolving a stage; retries require safe execution evidence. Resolve with verified actuals, an authenticated reason and explicit funding permission for uncovered costs. Do not delete a reservation or change a workflow row to bypass reconciliation. Preserve database and external payment evidence together during restore.
