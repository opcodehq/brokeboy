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
cargo check -p brokeboy --no-default-features --features polar --locked
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

The downloaded portable GNU release build on this Linux x64 VM, Node 24.22.1, kernel 6.18.56, glibc 2.34, Intel Xeon 2.90 GHz, local file SQLite, four SQLx connections, one customer/grant, 200 sequential consumptions measured 1.35 ms addon loading, 0.84 ms native handle opening, 1.06 ms median and 1.26 ms p95. A batch of 200 concurrent calls against that customer completed in 432 ms. These are one-run observations without provider networking; the SDK platform loader is outside the measured initialization, and these are not production comparisons with 0.1.

The measured stripped thin-LTO addon was 16,358,224 bytes and its CLI was 15,989,208 bytes. The machine-readable observations are in `native-measurements.json`; every platform's binary sizes, SHA-256 checksums, source revisions and passing workflow links are in `native-artifacts.json`. Run `node scripts/benchmark-native.mjs target/npm/platform` to reproduce the procedure. Database statement/round-trip tracing remains unqualified and is reported as unavailable rather than inferred.

## Remaining release gates

1. Extend executable native parity to every existing billing/payment scenario and all required fault cases. The dated embedding qualification below adds real Stripe invoice finalization, top-up/renewal races, refunds/disputes, and PostgreSQL 16 transaction/process failures. Schedules/proration, ambiguous payment outcomes beyond provider retry windows, and external-payment failures across every database remain release work. The thirteen frozen traces and targeted scenarios do not establish the complete matrix.
2. All seven artifact targets pass their Node 24 native-addon/CLI execution check. Complete Node 22/Bun and packed-root installation qualification on the remaining architecture/libc combinations; the full Node 22/24/Bun source matrix currently covers Linux x64 GNU, macOS ARM64 and Windows x64. Runner availability is restored.
3. Complete database statement tracing and publish comparable contention/initialization/bundle measurements for the actual distribution artifacts. Rehearse application-specific backup/restore and migration with external-state cutover.
4. Extend the dated real prepaid checkout, public delivery, successful 3DS challenge, ACH, refund and dispute results below to declined/abandoned authentication, additional delayed payment methods, tax/discounts and the broader merchant matrix. Signing retrieved real provider state alone still does not establish public delivery; the new public tests use an actual registered endpoint.
5. After these gates pass, switch the default 0.2 package exports, remove TypeScript production billing rules from that line, qualify installation of the exact release archives, and publish crates/packages/docs/examples together. Retain 0.1 maintenance for Workers/D1.

## Hosted execution

Runner availability was restored for this change. [Check run 42423440991](https://github.com/opcodehq/brokeboy/actions/runs/42423440991) passed on Node 22 and 24, including the PostgreSQL 16/MySQL 8 services, D1 and the existing package checks. The contracts job of [Rust run 42423441018](https://github.com/opcodehq/brokeboy/actions/runs/42423441018) also passed against those real database versions; runner-native Linux/macOS binding jobs passed. The Windows Node 22 job passed. Windows Node 24 reached the Bun suite and exposed the harness's five-second default timeout plus a timer-resolution assumption. The revised test uses an explicitly held lock to prove JavaScript responsiveness during pending native I/O and gives bounded cross-runtime tests 30 seconds. The corrected [run 42424038093](https://github.com/opcodehq/brokeboy/actions/runs/42424038093) passed the contracts and every Linux/macOS/Windows Node 22/24/Bun job, including the 32 shared native scenarios.

The initial [artifact run 42423448726](https://github.com/opcodehq/brokeboy/actions/runs/42423448726) passed Linux GNU x64/arm64, macOS arm64 and Windows x64 builds and execution. Its musl jobs exposed a default static-CRT setting that prevents cdylib output and GitHub's unsupported ARM Alpine JavaScript-action environment. macOS x64 also completed successfully. The corrected workflow checks out on the host, builds/executes in a matching Docker container, and disables static CRT for the dynamic addon. `musl_only` permits a targeted rerun. The corrected musl rerun passed both architectures. The targeted corrected run is [42424037468](https://github.com/opcodehq/brokeboy/actions/runs/42424037468). The native/domain rerun is [42424038093](https://github.com/opcodehq/brokeboy/actions/runs/42424038093).

Earlier hosted runs were blocked by account payment/spending restrictions; they are not passing results. Stable release still requires the broader merchant/recovery qualification in `verification.md`.


## GNU deployment baseline

The seven-target run [42424524446](https://github.com/opcodehq/brokeboy/actions/runs/42424524446) passed build and execution on its own runner images, and [42424498980](https://github.com/opcodehq/brokeboy/actions/runs/42424498980) passed the full Rust/Node/Bun qualification matrix for the webhook hardening change. Additional cross-distribution validation found that Ubuntu 24.04's GNU artifact imports `GLIBC_2.38` and fails on this Amazon Linux 2023 VM (`glibc 2.34`). Those GNU artifacts are not suitable for that deployment despite passing on Ubuntu.

The GNU jobs now build and execute on matching manylinux/glibc 2.28 containers and also execute the same artifact on the current GNU host. `gnu_only` permits targeted rebuilding. The [portable GNU run 42425641416](https://github.com/opcodehq/brokeboy/actions/runs/42425641416) passed both architectures. Both addons import no glibc symbol newer than 2.28. The downloaded x64 addon and CLI, and an isolated installation of the packed promise/Effect SDK, also executed successfully on this Amazon Linux 2023/glibc 2.34 VM. The earlier Ubuntu GNU artifacts should not be used for that deployment. macOS, Windows and musl remain covered by their own jobs. This does not change billing rules or introduce a compiler requirement for consumers.

## Embedding qualification, 2026-11-08

[Embedding and cutover](embedding.md) records the working-tree reference audit, each requested gap, new Rust APIs, source-balance transfer protocol, processor routing and the exact application responsibilities retained at the integration boundary. No Mac application code was edited. Frozen compatibility fixtures, schema DDL, dependency versions and default package exports remain unchanged. No tag, crate or npm package was published.

Local qualification ran with PostgreSQL **16.14** on a new isolated data directory, the existing MariaDB **10.5.29** fixture directory, SQLite, Node **24.22.1**, Bun **1.3.10**, and Rust **1.94**. The PostgreSQL 15 data directory was left intact. MariaDB is not a MySQL 8 qualification; the hosted contracts and package checks below passed against MySQL 8. Disk availability was checked before builds and remained over 30 GB.

- Formatting, strict workspace Clippy, workspace tests, documentation compilation, no-default-feature checks for each SQL adapter, `stripe,http`, and independent `polar` all pass. Thirty-one Rust harness tests pass, including the subprocess helper used by the real PostgreSQL fault test.
- Generated DTO/schema checks, Biome, TypeScript checks, the existing 129 Bun tests, three Node SQLite tests, the Neon WebSocket test and both D1 tests pass. The complete `check` command initially found an unformatted documentation table; it passes after formatting.
- Native Node tests pass **12/12**. Native Bun passes **79/79**, including the shared 0.1/native engine and workflow assertions. Frozen receipts/hashes/archives still pass against all three local SQL integrations. The compatibility fixtures were read, never regenerated.
- New engine scenarios cover cumulative partial/failed refunds, duplicate/reordered disputes, spent/held-credit shortfalls, adopted/unmatched customers, immutable cost-period receipts and status/cap boundaries, concurrent streams, estimate settlement on abandonment, late actuals, stale provider-worker fencing, and canceling an unstarted top-up after an accepted replenishment. Source debit response loss in the Stripe HTTP fixture retains one external key and one source transaction.
- A real PostgreSQL 16 test terminates the connection before a financial commit, then kills a separate process while it holds an unfinished debit. Both leave the original balance intact; retry records one debit and replay returns the same receipt. Another test uses an independently owned Brokeboy pool alongside an application table and verifies that table and the application's pool survive billing shutdown.
- The Rust streaming example runs and reports `4.945` available after a `0.025` actual cost and one `0.03` abandoned estimate from a five-unit grant.

### Hosted qualification of the embedding changes

Source revision `909d1e0d417690a36173ca34d158540615d3dc27` passed [Check run 42474301741](https://github.com/opcodehq/brokeboy/actions/runs/42474301741) on Node 22/24 and [Rust qualification run 42474301773](https://github.com/opcodehq/brokeboy/actions/runs/42474301773). The Rust contracts job passed against PostgreSQL 16 and MySQL 8, including strict Clippy, documentation and feature checks. Every Linux, macOS and Windows Node 22/24 native job passed, including its Bun contracts. These are source-build results; they do not qualify new seven-platform release archives or establish the remaining merchant cases.

After archiving the public delivery and ledger evidence, cleanup verified that the temporary Stripe webhook endpoint no longer exists and every public-checkout fixture customer is deleted. The receiver, tunnel and browser session were stopped. No reusable public webhook service is left running.

### Real Stripe evidence

All calls used the merchant-authorized test-mode key from the ignored environment. No live key or live payment was used. Test customers, clocks, prices, products, checkout sessions and the temporary registered webhook destination are fixture resources with explicit cleanup.

| Flow                     | Actual evidence                                                                                                                                                                                                                                   | Boundary                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Prepaid browser checkout | A real browser completed the Rust-created checkout; Stripe delivered `checkout.session.completed` to the registered public HTTPS receiver; PostgreSQL wallet gained exactly one dollar                                                            | Prepaid checkout, not browser qualification of every subscription variant                                    |
| 3DS                      | Browser completed the challenge; retrieved charge reports `authentication_flow: challenge`, `result: authenticated`, version 2.1.0; public delivery provisioned one dollar                                                                        | Declines and abandonment remain separate cases                                                               |
| ACH                      | Browser connected a sandbox bank account and submitted payment; actual completion preceded `checkout.session.async_payment_succeeded`; credit was provisioned on confirmed success                                                                | Other asynchronous methods remain unqualified                                                                |
| Partial refund           | Rust issued a 25-cent refund; real `charge.refunded` and `refund.updated` deliveries moved the wallet from 1.00 to 0.75 once                                                                                                                      | Not a simulation of a refund payload                                                                         |
| Failed refund            | A real refund initially succeeded, then Stripe changed it to failed and delivered `refund.updated` plus `refund.failed`; the 25-cent clawback was compensated once                                                                                | Additional cancellation/reversal mechanisms remain fixtures or merchant work                                 |
| Disputes                 | Real test-card disputes emitted creation, funds withdrawn and funds reinstated; submitting documented winning evidence restored the disputed value; official Stripe CLI redelivery preserved the balance                                          | New code does not reconstruct pre-cutover purchase allocations                                               |
| Opening balance          | Native dry run inspected 375 cents; apply created one source debit, verified a zero Stripe balance and granted 3.75 locally; same-key and different-key replays did not duplicate either side                                                     | Requires a host fence; no real application cutover was performed                                             |
| Metered invoice          | Rust exported a five-cent rated amount; the real renewed invoice contained quantity 5 and amount 5 for the meter; after finalization, the remaining two-cent export entered reconciliation                                                        | Invoice was finalized open; this does not qualify every collection/tax scenario                              |
| Top-up/renewal races     | Twenty concurrent consumptions and eight competing maintenance calls produced one paid top-up invoice; duplicate paid-invoice notifications granted one pack; competing paid-renewal notifications refreshed the allowance without another top-up | Real Stripe state with locally signed renewal notifications; public delivery is established separately above |

The race exercise initially exposed an unnecessary second top-up before paid renewal state was synchronized. The engine now refreshes authoritative subscription state before an unstarted automatic purchase, rechecks the balance, durably records a skip or external-start decision, and keeps uncertain external attempts recoverable. The corrected real exercise passes. An earlier one-shot allowance assertion also failed without a saved provider diagnostic; a diagnostic was added and the later complete run passed. That earlier failure is not a passing result.

Rebuilding the debug addon in place while the test receiver was running caused a Bun segmentation fault. The build script now copies to a fresh file and atomically renames it, retaining the inode mapped by an existing process. The receiver resumed against its existing PostgreSQL state; the official Stripe CLI redelivered the missed and duplicate reinstatement notifications, and the ledgers reconciled. Subsequent native rebuilds left the receiver running. This is a development build/recovery observation, not a claim that every runtime crash path is qualified.

Reproduce real exercises explicitly, outside ordinary CI:

```sh
# Create a temporary public HTTPS tunnel to the receiver port first.
STRIPE_QUALIFICATION_PUBLIC_URL=https://your-test-receiver.example \
  TEST_POSTGRES_URL=postgresql://localhost/disposable_billing \
  bun scripts/stripe-public-qualification.ts
# Browser sessions use checkout URLs in target/stripe-public-qualification/state.json.
# Supported follow-up actions: inspect, refund, add-dispute, win-dispute,
# add-delayed, add-refundfailure, refund-failure, opening, maintain, status, resume.
bun scripts/stripe-meter-qualification.ts
BROKEBOY_SANDBOX_ENGINE=rust STRIPE_TEST_RACES=true \
  STRIPE_TEST_CLOCK_ADVANCE=true bun scripts/stripe-sandbox.ts
```

The receiver has no administrative HTTP endpoint. Credentials are never printed; its recoverable webhook secret is kept only in the ignored target directory with mode 0600. Stop it normally to remove its webhook destination and fixture customers. Preserve evidence before cleaning local fixtures. `target/stripe-meter-evidence.json` records the real invoice assertion; public receiver state records actual event IDs and observed balances.

### Remaining integration and release work

The host keeps resource observation/attribution, lifecycle ownership and snapshot leases, cost-window splitting and fractional checkpoints, existing financial versus telemetry outboxes, original historical receipts, and pre-cutover adjustment provenance. Its original integration tests were not run against a substituted host implementation. The new period/expiry policies require native maintenance; the 0.1 maintenance engine does not implement them.

Polar is fixture-qualified for signatures, HTTPS URL checks, checkout/portal requests, canonical subscription ownership and stable rated usage identity. No real Polar credential or merchant flow was available. Provider meter-summary reconciliation remains on the host until qualified. SQLx 0.8/Reqwest 0.12 coexistence is documented using independent pools; the actual host build is still unverified.

Other open release work includes loss after a real provider-side financial commit, expired provider idempotency windows, failure matrices on every database and native platform, more subscription/schedule/tax/discount cases, round-trip tracing, new artifact measurements and exact distribution-archive installation. Prior seven-platform artifacts and measurements describe their earlier source revisions, not these new billing capabilities. No new performance claim is made.
