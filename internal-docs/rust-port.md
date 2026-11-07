# Rust 0.2 port and qualification

The native billing implementation is available from source through `brokeboy/native`, `brokeboy/native/effect`, the Rust crates, and the native CLI. It has its own Rust execution path; native calls do not forward billing decisions to the TypeScript engine or a hosted service. The default npm root remains 0.1 during parity qualification. No crates, npm packages, or payment resources are published by the artifact workflows.

`release/0.1` preserves commit `26c5eb67e9e7eb7d017fd968556172877ab48296`, the `0.1.0-alpha.2` compatibility oracle. This commit has no matching local alpha.2 tag. Workers/D1 stay on that maintenance line until a Rust edge backend is qualified. Do not delete the TypeScript implementation or switch the default package entry point before the release gates below pass.

## Implementation

The Cargo workspace uses Rust 2024, MSRV 1.94, Tokio, and SQLx 0.9. All components are MIT licensed and currently have `publish = false`.

| Component       | Implemented responsibility                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `brokeboy-core` | Checked six-place fixed point, money/credit/quantity types, canonical JSON/hash compatibility, flat/graduated/volume/dimensional pricing, calendar arithmetic, shared wire DTOs and explicit schema generation                                               |
| `brokeboy`      | Async grouped SDK, catalog versions, customers/entities, ledger/grants, usage/batches/corrections, reservations, subscriptions/quantities/licenses, spending controls/top-ups, commerce, migrations, workflows, durable work and maintenance                 |
| SQL adapters    | PostgreSQL/MySQL customer locks, SQLite `BEGIN IMMEDIATE`, existing rows/tables/scopes, owned/borrowed pools, rollback and abandoned-connection quarantine                                                                                                   |
| Stripe          | Targeted Reqwest/Rustls HTTP adapter pinned to `2026-09-30.endive`; persistent resource identity/intents, checkout/portal/preview/changes/schedules, authoritative allowance confirmation, invoices/refunds/credit notes, metered exports and reconciliation |
| `brokeboy-node` | Async Arc-owned NAPI handle, synchronous request registration/cancellation, callback delivery/reentrancy, bounded/abortable raw webhooks, graceful shutdown and pure pricing/calendar helpers                                                                |
| TypeScript      | Promise SDK with `Billing.open`/`close`, connection configuration, Rust-generated DTOs, scoped Effect integration, shared authenticated HTTP/React contracts, clear unsupported-platform errors                                                              |
| Rust HTTP       | Framework-independent handler with application identity/admin callbacks, origin checks, public response redaction, audited administrative adjustments and raw webhook ingestion                                                                              |
| `brokeboy-cli`  | Init, explicit schemas, all-table doctor, catalog diff/apply/export, customer inspection, ledger reconciliation, operation recovery, migration export/import and generic SDK invocation                                                                      |
| Packaging       | Native platform manifests, binary checksums/sizes, root-package staging, compiler-free execution smoke checks, manual seven-target artifact workflow; no automatic publication                                                                               |

Rust domain/storage/provider traits are object safe. `brokeboy-core` imports neither Tokio nor SQLx. Database, Stripe, and HTTP dependencies are feature gated. Application-owned pools/providers are not closed unless ownership is explicitly transferred. Network calls and application callbacks run outside database transactions.

Published catalog versions remain immutable and customer subscriptions remain pinned. The engine hashes wire input before defaults and decimal normalization, preserves unknown stored data fields, and appends corrections instead of rewriting historical movements. Cancellation preserves durable payment intents/leases; safe retry windows and reconciliation remain explicit. Close stops acceptance, cancels requests, waits for cleanup, and releases owned resources.

## Frozen compatibility oracle

`test/fixtures/compatibility/v1.json` freezes hashing, decimal/range/currency behavior, pricing, calendars, identifiers, timestamps and exact dialect DDL. `engine-v1.json` freezes thirteen end-to-end operations, complete persisted records, and a full migration archive: customer/entity creation, versioned subscription attachment, pooled fractional usage, compensating correction, reservation settlement, and a completed dependent workflow.

Rust executes those operations and compares their receipts and full migration archive against the oracle on PostgreSQL, MySQL and SQLite. Array order for ID-addressed archive records is normalized for comparison; graph/dependency and allocation order retain their meaning. SQL contracts also load old saved operations and prove replay without executing their actions. Do not regenerate fixtures from Rust when a compatibility test fails.

The fixture generators must run against the unchanged oracle implementation. The mixed-process native tests execute the TypeScript 0.1 path and Rust against one SQLite file: 200 attempted debits against 50 units yield exactly 50 successful debits. They replay receipts in both directions and reject altered decimal spelling. Separate PostgreSQL/MySQL contracts verify mixed-process lock compatibility and independence between customers.

## Run qualification

```sh
bun install --frozen-lockfile
# Use dedicated, disposable fixture databases. Native engine tests create
# temporary PostgreSQL schemas/MySQL databases and clean them up.
export TEST_POSTGRES_URL=postgresql://localhost/brokeboy_test
export TEST_MYSQL_URL=mysql://localhost/brokeboy_test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
cargo check -p brokeboy --no-default-features --locked
cargo check -p brokeboy --no-default-features --features postgres --locked
cargo check -p brokeboy --no-default-features --features mysql --locked
cargo check -p brokeboy --no-default-features --features sqlite --locked
cargo check -p brokeboy --no-default-features --features stripe,http --locked
cargo doc --workspace --all-features --no-deps --locked
bun run types:check
bun run check
bun run test:d1
bun run native:build
bun run test:native:node
bun run test:native:bun
bun run test:native:parity
```

PostgreSQL/MySQL contracts print a qualification notice and skip their work if their URL is missing. Supply both variables when recording a driver qualification. Mixed-process tests use Bun as the old-engine oracle; applications using the Rust library need no JavaScript runtime.

The merchant-authorized sandbox script accepts test-mode credentials only. It creates disposable Stripe fixtures, closes/archives them during cleanup, and never logs the credential. `BROKEBOY_SANDBOX_ENGINE=rust STRIPE_TEST_CLOCK_ADVANCE=true bun scripts/stripe-sandbox.ts` exercises the native adapter. Its signature timestamp follows the injected test clock during simulated renewals. It does not verify browser checkout completion or registered public webhook delivery.

## Local results, 2026-11-07

- Rust 1.94: formatting, strict Clippy, feature matrix, documentation compilation, domain compatibility, lifecycle and SQL contracts pass on local Linux x64 GNU.
- PostgreSQL 15, MariaDB 10.5 and SQLite pass native execution/receipt/archive comparisons. SQL contracts pass concurrent writers, rollback, dropped-transaction quarantine, cancellation rollback, environment isolation, borrowed-pool ownership and legacy replay. MariaDB does not qualify MySQL 8.
- The shared 0.1 engine and workflow contracts also execute against Rust: 32 native SQLite scenarios pass, including seats, capped rollover, grandfathered catalog versions, fractional usage aggregation, imported workflow history, revoked grant backing, graph admission, safe retry fencing, late-cost recovery and checkpoint rollback. The contract runs the same assertions through both implementations rather than copying expected results.
- Node 22/24 and Bun 1.3.10 pass native bindings, event-loop responsiveness, blocked-I/O/early cancellation, reentrant callbacks, shutdown, mixed-engine financial spending, workflow recovery, public promise/Effect SDKs, HTTP authorization/redaction, snapshot restore and pure pricing/calendar fixtures.
- The local Stripe HTTP fixture passes transient failures and retained external keys, paid-state verification, duplicate/reordered purchase confirmations, ownership/resource checks, refunds, compensating adjustments and reconciliation. Its callback reenters a one-connection SQLite engine, demonstrating that provider networking holds no transaction.
- The real Stripe sandbox passes native checkout creation, actual initial payment, signed ingestion of retrieved authoritative state, allowance provisioning, consumption, test-clock paid renewal, renewed allowance and ledger reconciliation. Browser checkout and public webhook delivery remain untested.
- The 0.1 checks pass with PostgreSQL/MariaDB enabled: 129 Bun tests, three Node SQLite tests, a Neon WebSocket driver test, and two Miniflare/workerd D1 tests. Browser/React entry points remain independent of native bindings.
- Linux x64 GNU release addon and CLI pass compiler-free execution from staged platform packages. An isolated npm installation of the staged native root package and platform tarball executes promise consumption and scoped Effect without optional React/Stripe/Drizzle peers or a compiler.

## Artifact staging

```sh
cargo build --release --locked -p brokeboy-node -p brokeboy-cli
node scripts/stage-native.mjs --platform linux-x64-gnu --out target/npm/platform
node test/native.install.cjs target/npm/platform
bun run build
node scripts/stage-native.mjs --primary --out target/npm/brokeboy
npm pack ./target/npm/platform --pack-destination target/npm
npm pack ./target/npm/brokeboy --pack-destination target/npm
```

Choose a fresh output directory: staging refuses to overwrite artifacts. The primary staged 0.2 manifest points the root and Effect exports at Rust and declares optional native packages; it does not change the repository's production manifest. It excludes TypeScript financial runtime modules while retaining declaration files for API compatibility. Import-graph tests also ensure native/server exports do not load TypeScript billing rules, and React does not load the addon. The native CLI launcher selects a platform executable and never falls back to the old engine. Optional package names are staging identifiers until publication is qualified.

`.github/workflows/native-artifacts.yml` manually builds and executes Linux GNU/musl x64/arm64, macOS x64/arm64 and Windows x64 packages on matching runners/containers. It uploads review artifacts and has no publication step. The main Rust workflow runs Node 22/24 and Bun binding contracts on runner-native Linux/macOS/Windows. Hosted execution results must be inspected rather than inferred from workflow configuration.

## Controlled local measurements

A release build on this Linux x64 GNU VM, Node 24.22.1, kernel 6.18.56, Intel Xeon 2.90 GHz, local file SQLite, four SQLx connections, one customer/grant, 200 sequential consumptions measured 0.83 ms initialization, 0.97 ms median and 1.20 ms p95. A batch of 200 concurrent calls against that same customer completed in 283 ms. These are one-run local observations without provider networking, not throughput guarantees or a production comparison with 0.1.

The measured stripped thin-LTO addon was 16,173,240 bytes; the native CLI was 15,804,088 bytes. Rebuilds may change sizes. The recorded machine-readable result is `internal-docs/native-measurements.json`. Run `node scripts/benchmark-native.mjs target/npm/platform` and retain `measurements.json` from staging. Database statement/round-trip tracing is not yet qualified; the harness reports that measurement as unavailable rather than inventing a count.

## Remaining release gates

1. Extend executable native parity to every existing billing/payment scenario and all required fault cases; the thirteen frozen traces and targeted native scenarios are substantial coverage, not proof of the complete release matrix. In particular, qualify postpaid invoice finalization, top-up/renewal races, schedules/proration, partial refunds/disputes, provider-window ambiguity and process/connection loss across all databases.
2. Qualify every required native distribution target, and compiler-free installation under each supported Node/Bun runtime. The local VM qualifies Linux x64 GNU only. Hosted runner availability must be resolved before binaries can ship.
3. Complete database statement tracing and publish comparable contention/initialization/bundle measurements for the actual distribution artifacts. Rehearse application-specific backup/restore and migration with external-state cutover.
4. Exercise browser checkout, public Stripe webhook delivery, 3DS/delayed payment paths, tax/discounts and broader sandbox scenarios. Signing retrieved real provider state does not establish public delivery or every merchant flow.
5. After these gates pass, switch the default 0.2 package exports, remove TypeScript production billing rules from that line, qualify installation of the exact release archives, and publish crates/packages/docs/examples together. Retain 0.1 maintenance for Workers/D1.

## Hosted execution

Runner availability was restored for this change. [Check run 42423440991](https://github.com/opcodehq/brokeboy/actions/runs/42423440991) passed on Node 22 and 24, including the PostgreSQL 16/MySQL 8 services, D1 and the existing package checks. The contracts job of [Rust run 42423441018](https://github.com/opcodehq/brokeboy/actions/runs/42423441018) also passed against those real database versions; runner-native Linux/macOS binding jobs passed. The Windows Node 22 job passed. Windows Node 24 reached the Bun suite and exposed the harness's five-second default timeout plus a timer-resolution assumption. The revised test uses an explicitly held lock to prove JavaScript responsiveness during pending native I/O and gives bounded cross-runtime tests 30 seconds. That fix and the newly shared domain/workflow contract require a passing rerun before claiming complete qualification.

The initial [artifact run 42423448726](https://github.com/opcodehq/brokeboy/actions/runs/42423448726) passed Linux GNU x64/arm64, macOS arm64 and Windows x64 builds and execution. Its musl jobs exposed a default static-CRT setting that prevents cdylib output and GitHub's unsupported ARM Alpine JavaScript-action environment. macOS x64 also completed successfully. The corrected workflow checks out on the host, builds/executes in a matching Docker container, and disables static CRT for the dynamic addon. `musl_only` permits a targeted rerun. This correction requires a passing rerun; configuration alone is not qualification. The targeted corrected run is [42424037468](https://github.com/opcodehq/brokeboy/actions/runs/42424037468). The native/domain rerun is [42424038093](https://github.com/opcodehq/brokeboy/actions/runs/42424038093).

Earlier hosted runs were blocked by account payment/spending restrictions; they are not passing results. Stable release still requires the broader merchant/recovery qualification in `verification.md`.
