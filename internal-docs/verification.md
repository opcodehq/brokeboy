# Verification and stable-release gates

Status: alpha implementation. This file distinguishes implemented behavior, local verification, and external qualification. No stable-release claim is made by a passing mock or fixture test.

## Local verification

- TypeScript strict checks, Biome, generated-schema drift checks and package compilation.
- Native Effect laziness, tagged failures, service/layer wiring, virtual clock deadlines, interrupted transactions, semaphore waiters, SQL command cancellation, rollback quarantine, HTTP stream cleanup, payment lease recovery and compatibility adapters.
- Shared behavioral contracts on memory, Bun SQLite, PostgreSQL 15 and the mysql2 adapter against MariaDB 10.5.
- Native Node SQLite restart/replay, backup/restore on a new connection and additive workflow-schema upgrades.
- Shared workflow contracts on memory, Bun SQLite, PostgreSQL and MySQL: concurrent claims, restart settlement, per-event batch replay and atomic rollback.
- Workflow dependency joins, expired leases, delayed retries, fencing, budget increases, cancellation, late actuals, explicit recovery funding, checkpoint limits, grant revocation, parent pools and migration replay.
- Administrative workflow authorization, actor auditing and customer-response isolation.
- D1 atomic batches, optimistic contention, rollback and replay through Miniflare/workerd.
- Actual Neon WebSocket driver through a local WebSocket-to-PostgreSQL protocol bridge; this is driver qualification, not a hosted Neon performance claim.
- Stripe SDK HTTP fixtures, signed webhook verification, delayed payment fulfillment, purchase deduplication, resource recovery, quantity-aware packs and cumulative monetary export.
- Account authorization, cross-origin rejection and public-response redaction.
- Browser demo: free-plan selection, cap editing, payment failure feedback, and WCAG A/AA audit with zero reported violations.
- Executable browser-targeted engine bundle; optional React/Stripe/Drizzle integrations do not enter the root bundle.

The dedicated Node and Bun test commands intentionally use different SQLite drivers. Do not run the Node-native addon test under Bun.

## Recorded alpha check (2026-10-28)

- `bun run check`: 127 Bun tests, three Node native-SQLite tests and one Neon WebSocket driver test passed, including real local PostgreSQL 15 and MariaDB 10.5.
- `bun run test:d1`: Two Miniflare/workerd tests passed: contention/rollback/replay with workflow claims and settlement, plus bundled Effect layers running inside workerd against a native D1 binding.
- Isolated `npm install` of the packed artifact: promise consumption, native Effect workflow execution, declaration type checks and CLI commands passed with none of React, Stripe or Drizzle installed.
- GitHub Actions [run 40654326007](https://github.com/opcodehq/brokeboy/actions/runs/40654326007) could not start either matrix job. GitHub reported an account payment/spending-limit restriction. This is not a passing hosted CI result; Node 22, PostgreSQL 16 and MySQL 8 still require that run.
- Merchant-authorized Stripe sandbox run passed after credentials were configured: Checkout creation, actual initial invoice payment, signed local ingestion of retrieved state, allowance provisioning, consumption, test-clock renewal payment, renewed allowance and ledger reconciliation. Checkout completion in a browser and public webhook delivery were not exercised. The run exposed and fixed required customer name/address updates for Checkout tax-ID collection.

## Required external qualification before stable

- Merchant-authorized Stripe sandbox flows: real Checkout completion, delayed payment methods, 3DS, tax, coupons, paid renewals, proration, pending updates, future schedules, partial refunds, disputes, and metered invoice closing.
- Delivery from a registered public Stripe webhook destination. Signing a fixture with real retrieved Stripe state does not establish delivery.
- Hosted Workers/Neon and Workers/MySQL connection binding qualification, including request lifetimes, reconnects and cancellation.
- MySQL 8 verification in the GitHub service matrix; local MariaDB compatibility is not a substitute for that result.
- Application-specific restore and migration rehearsal with financial-period cutover and external-state reconciliation.

`bun run test:stripe-sandbox` accepts only a test-mode `STRIPE_SECRET_KEY`. It creates disposable sandbox fixtures, verifies paid subscription state and local signed ingestion, and attempts cleanup. `STRIPE_TEST_CLOCK_ADVANCE=true` adds a renewal clock advance. It does not test every external gate above. The manual GitHub workflow uses a protected `stripe-sandbox` environment and a `STRIPE_TEST_SECRET_KEY` secret.

## Performance measurement

Run `bun run benchmark`. The harness reports engine bundle size, database statement count, and latency for 200 consumptions against one in-memory SQLite customer/grant. It labels that environment explicitly. These numbers are not a networked-database throughput guarantee or production SLA.

Alpha.2 measurement on this Linux x86_64 sandbox with Bun 1.3.10 (Node checks use 24.22.1): 200 in-memory SQLite consumptions, one customer/one grant, 21 SQL statements per consumption, p50 2.13 ms and p95 6.83 ms. The minified browser-targeted root bundle is 167,298 bytes (50,970 gzip).

The recorded alpha.1 figures were p50 0.40 ms, p95 1.11 ms and 67,472 bundle bytes (19,147 gzip). Effect introduces runtime and bundle overhead; this migration does not claim a latency improvement. These single-process microbenchmarks are not controlled production or networked-database comparisons. Backend subpath imports reduced an intermediate Effect bundle from roughly 408 KB to 167 KB. Re-run in the integrating application's environment before setting throughput or latency expectations.

The benchmark initially exposed an export-stripping issue with a package metadata optimization in Bun 1.3.10. The metadata was removed and an executable-bundle regression test protects the actual exports.

## Publication policy

The current package is `0.1.0-alpha.2`. Prerelease source and package artifacts can be reviewed and tested independently. Do not label a release stable while external gates remain open. There is no hosted billing service or paid feature edition.

## Rust native preview

The 0.2 implementation, frozen interoperability fixtures, native SDK/Stripe results, artifact measurements, commands and remaining release gates are recorded in [Rust port qualification](rust-port.md). The repository default entry point stays on 0.1 until those gates pass. Native artifacts are staged locally and by a manual seven-target qualification workflow; nothing is published automatically.
