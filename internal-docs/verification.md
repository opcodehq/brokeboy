# Verification and stable-release gates

Status: alpha implementation. This file distinguishes implemented behavior, local verification, and external qualification. No stable-release claim is made by a passing mock or fixture test.

## Local verification

- TypeScript strict checks, Biome, generated-schema drift checks and package compilation.
- Shared behavioral contracts on memory, Bun SQLite, PostgreSQL 15 and the mysql2 adapter against MariaDB 10.5.
- Native Node SQLite restart/replay and backup/restore on a new connection.
- D1 atomic batches, optimistic contention, rollback and replay through Miniflare/workerd.
- Actual Neon WebSocket driver through a local WebSocket-to-PostgreSQL protocol bridge; this is driver qualification, not a hosted Neon performance claim.
- Stripe SDK HTTP fixtures, signed webhook verification, delayed payment fulfillment, purchase deduplication, resource recovery, quantity-aware packs and cumulative monetary export.
- Account authorization, cross-origin rejection and public-response redaction.
- Browser demo: free-plan selection, cap editing, payment failure feedback, and WCAG A/AA audit with zero reported violations.
- Executable browser-targeted engine bundle; optional React/Stripe/Drizzle integrations do not enter the root bundle.

The dedicated Node and Bun test commands intentionally use different SQLite drivers. Do not run the Node-native addon test under Bun.

## Recorded alpha check (2026-10-27)

- `bun run check`: 89 Bun tests, two Node native-SQLite tests and one Neon WebSocket driver test passed, including real local PostgreSQL 15 and MariaDB 10.5.
- `bun run test:d1`: Miniflare/workerd contention, rollback and replay passed.
- Isolated `npm install` of the packed artifact: core consumption and CLI SQL generation passed with none of React, Stripe or Drizzle installed.
- GitHub Actions [run 40482806769](https://github.com/opcodehq/brokeboy/actions/runs/40482806769) could not start either matrix job. GitHub reported an account payment/spending-limit restriction. This is not a passing hosted CI result; Node 22, PostgreSQL 16 and MySQL 8 still require that run.
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

Recorded on this sandbox with Bun 1.3.10: 200 in-memory SQLite consumptions, 21 SQL statements per consumption, p50 0.47 ms and p95 0.83 ms. The browser-targeted root bundle was 52,849 bytes (15,378 gzip). Re-run rather than extrapolating these figures to a networked database.

The benchmark initially exposed an export-stripping issue with a package metadata optimization in Bun 1.3.10. The metadata was removed and an executable-bundle regression test protects the actual exports.

## Publication policy

The current package is `0.1.0-alpha.0`. Prerelease source and package artifacts can be reviewed and tested independently. Do not label a release stable while external gates remain open. There is no hosted billing service or paid feature edition.
