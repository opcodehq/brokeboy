# Changelog

## 0.1.0-alpha.2

Migrate backend execution to Effect 4.0.7. Add native services/layers, schema-backed errors, native storage/Stripe/HTTP APIs, scoped database finalization, semaphore locking, cancellation recovery and test-clock integration. Keep the promise SDK and custom integration contracts compatible. Include a native workflow example and workerd execution test. No additional database migration is required beyond alpha.1.

## 0.1.0-alpha.1

Durable billing workflows: dependency graphs, parallel stages, atomic prepaid budgets, worker fencing, heartbeats, explicit budget increases, cost settlement, safe retries, cancellation and audited reconciliation. Add atomic usage batches with per-event replay keys, dimensional receipt aggregation, workflow administration and CLI inspection. Workflow archives preserve checkpoints across customer migration. Requires an additive workflows-table migration.

## 0.1.0-alpha.0

Initial embedded billing implementation: transactional credits and reservations, versioned pricing, subscription and Stripe orchestration, Drizzle schemas and database adapters, customer/entity entitlements, spending controls, reconciliation, migration archives, CLI, and optional React toolkit.

This is a prerelease. External Stripe payment scenarios and hosted edge integrations must satisfy the qualification gates before a stable release.

- Stripe sandbox qualification: fix existing-customer Checkout tax-ID collection, use attached payment-method IDs, and verify paid test-clock renewals and renewed allowances.
