# Changelog

## 0.1.0-alpha.1

Durable billing workflows: dependency graphs, parallel stages, atomic prepaid budgets, worker fencing, heartbeats, explicit budget increases, cost settlement, safe retries, cancellation and audited reconciliation. Add atomic usage batches with per-event replay keys, dimensional receipt aggregation, workflow administration and CLI inspection. Workflow archives preserve checkpoints across customer migration. Requires an additive workflows-table migration.

## 0.1.0-alpha.0

Initial embedded billing implementation: transactional credits and reservations, versioned pricing, subscription and Stripe orchestration, Drizzle schemas and database adapters, customer/entity entitlements, spending controls, reconciliation, migration archives, CLI, and optional React toolkit.

This is a prerelease. External Stripe payment scenarios and hosted edge integrations must satisfy the qualification gates before a stable release.

- Stripe sandbox qualification: fix existing-customer Checkout tax-ID collection, use attached payment-method IDs, and verify paid test-clock renewals and renewed allowances.
