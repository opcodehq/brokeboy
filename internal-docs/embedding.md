# Embedded billing integration and cutover

The Rust engine now supplies the generic monetary and capacity primitives needed by the reference cloud application. It is not a replacement for that application's resource ownership, provider observations, lifecycle fences, historical outboxes or HTTP authentication. No application files on the Mac were edited, no compatibility fixtures were regenerated, no default npm export was switched, and no package or tag was published.

## Reference audit

The audit read the Mac working tree at `/Users/whizzy/.zuse/worktrees/zuse/quiet-zuse/crates/cloud/src/billing.rs`, `billing/payments.rs`, the checkout/credits/events/hosted/meter modules, their tests, and the settlement/storage/exports modules and tests. Working changes included the credit implementation and newly added hosted-usage files. Application code was used as a behavior reference; the implementation remains independent MIT Rust code.

| Requested gap       | Finding before implementation                                                                           | Result                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Disputes            | Only creation was accepted and sent for review                                                          | Funds withdrawal and reinstatement adjust purchase credit by the dispute amount; reinstatement is terminal under reordered deliveries      |
| Partial refunds     | Only a complete refund reversed credit                                                                  | Canonical successful refunds are summed across every page; cumulative changes append debits or compensating credits                        |
| Prepaid credit      | Catalog packs existed; arbitrary-cent checkout and Stripe opening-balance transfer did not              | `prepaid.checkout` and `migration.importStripeBalance`, with durable payment intents and source transaction provenance                     |
| Adoption            | Customer/subscription linking existed, but webhook routing required metadata                            | Durable customer mapping takes precedence; missing mappings enter review; CLI backfill verifies first and defaults to dry run              |
| Cost periods        | Feature balances, reservations and spending controls existed, but the cumulative cost policy was absent | `periods` provides immutable terms, statuses, live cost holds and immutable settlement receipts                                            |
| Polar               | No native adapter                                                                                       | Optional `polar` adapter plus processor routing, checkout, portal, signed notifications, canonical subscriptions and rated usage ingestion |
| Streaming           | Atomic reserve/increase/settle/release already existed                                                  | Reused it; added explicit `onExpiry: "settle_estimate"`, recovery tests and a runnable Rust example                                        |
| Version coexistence | Owned connection-configured pools already existed                                                       | Added an executable PostgreSQL shared-database test and integration guidance rather than downgrading dependencies                          |
| Qualification       | Fixtures and some real payments were recorded; public delivery and merchant flows were open             | See the dated evidence in `rust-port.md`; passing fixtures alone never qualify a real payment flow                                         |

Two details differ from the request's description of the reference: its prepaid checkout accepts a configured set of amounts, and failed refunds are sent for reconciliation rather than automatically restored. Brokeboy supports arbitrary positive cent amounts within its explicit checkout limit and restores only credit it actually clawed back when canonical refund status changes.

## Rust dependency and pool ownership

The repository currently has no newly qualified prerelease tag. After an explicitly requested tagged release, use the following template with that real tag:

```toml
brokeboy = { git = "https://github.com/opcodehq/brokeboy", tag = "<qualified-prerelease-tag>", default-features = false, features = ["postgres", "stripe", "http"] }
```

Until then use a reviewed commit with `rev`, or a path dependency for local integration. Do not invent a tag. Add `polar` when retaining that processor; omit `http` if the application owns its HTTP layer. SQLx 0.9 and Reqwest 0.13 remain unchanged. A host on SQLx 0.8/Reqwest 0.12 keeps those dependencies and opens a separate Brokeboy pool using `Billing::open(DatabaseConnection, BillingOptions)`; its 0.8 pool cannot be passed to a 0.9 API. Cargo can retain both versions.

Apply the explicit billing DDL in a migration. Startup does not apply it. A PostgreSQL connection URL can set `options=-csearch_path=billing_schema`; use URL query encoding, as demonstrated in `tests/embedding.rs`. Brokeboy may also share the public schema: table names are prefixed. The test creates an application table in the same database/schema, opens and closes an independent Brokeboy pool, replays a debit, and verifies the application row and pool remain intact. It does not compile the host application or claim shared cross-version transactions.

Use a host outbox when one application transaction must record a resource transition and request a billing operation. Commit the host transaction, call Brokeboy with its stable source key, and acknowledge only after the receipt is durable. Do not hold an application transaction while waiting for an independent billing pool to acquire overlapping locks.

## Prepaid wallet and source transfer

`prepaid.checkout` accepts `customerId`, `feature`, positive `amountCents` (maximum 99,999,999), `successUrl`, optional `cancelUrl`, and `idempotencyKey`. It sells USD credit: 125 cents grants `"1.25"` wallet units. A completed but unpaid session does not grant credit. The adapter retrieves captured payment evidence before applying delayed payment success. The wallet is Brokeboy's ledger; subsequent consumption never writes Stripe customer balance transactions.

Opening import is a transfer, not a copy:

1. Fence the legacy writer and new request admission per customer. Drain or account for open streams, unsettled reservations, unsent debits, and ambiguous provider requests. Preserve the legacy receipts and take a verified backup.
2. Suspend automatic collection/advancement on affected old invoices/subscriptions while transferring. Confirm that no other process, scheduled job or Stripe collection can consume or alter the old customer balance. Keep billing identity and export ownership fences in the host application.
3. Adopt the existing customer and subscriptions using their existing Stripe IDs. Run `migration.importStripeBalance` without `dryRun: false` to inspect the source. Dry runs record administrative work, but do not move credit.
4. Apply with `dryRun: false`, `externalSpendingDisabled: true`, the inspected `expectedCreditCents`, and a stable idempotency key. The adapter uses a customer/environment-specific Stripe balance transaction to remove the source credit before granting it locally. It verifies the source transaction's amount, currency and zero ending balance. A concurrent source change produces reconciliation, not a second spendable grant.
5. Verify Stripe credit is zero, the Brokeboy source transaction ID and amount match, `credits.reconcile` is consistent, and retries return without another source debit or grant. Response loss is recovered by locating the existing source transaction. Ambiguous operations beyond safe retry windows require reconciliation.
6. Enable the Brokeboy writer and admission path. Keep the legacy balance writer disabled. Resume Stripe subscription collection only after confirming it no longer has the transferred credit available. Roll back by fencing the new writer, draining its operations and using audited compensating transfers; never restore the old balance while the local grant remains spendable.

The acknowledgement is a host assertion, not a mechanism for stopping another application. No library can fence a legacy process that ignores its ownership protocol. Positive Stripe debit balances and non-USD opening balances require manual migration. An aggregate opening balance does not reconstruct historical purchase provenance: keep legacy refund/dispute handling for pre-cutover purchases until their original charge/grant allocations are imported or explicitly reconciled.

## Customer and subscription backfill

```sh
brokeboy-native --config brokeboy.json migrate backfill customers.json
brokeboy-native --config brokeboy.json migrate backfill customers.json --apply
```

Input is an array of `{ customerId, stripeCustomerId, idempotencyKey, subscriptions?: [{ stripeSubscriptionId, planId, idempotencyKey }] }`. Dry run verifies provider ownership and configured plans without creating local customers or updating Stripe metadata. Apply adopts customers and imports subscriptions through durable operations. It updates billing metadata as needed but never replaces Stripe IDs or charges for adoption. A partially interrupted batch can be replayed. Inspect each returned operation; acceptance is not payment success.

`operations.unmatched` reads durably accepted notifications lacking an application mapping. After adoption, `operations.replayUnmatched({ eventId })` forwards the saved verified event for normal processing. It cannot substitute a caller-selected customer. The customer registry prevents two application customers from using the same processor customer for financial operations.

## Refunds and disputes

The Stripe adapter handles `charge.refunded`, `refund.updated`, `refund.failed`, `charge.dispute.funds_withdrawn` and `charge.dispute.funds_reinstated`. It retrieves the charge and all current refunds; stale notification payload totals do not determine the debit. Pending/failed/canceled refunds do not contribute to successful refunded value. Credit is prorated against the paid amount using checked integers at six-place precision. Both positive and compensating negative movements remain inspectable.

Repeated events and distinct notifications describing the same cumulative state do not add more movements. A reinstatement delivered before withdrawal prevents that late withdrawal from charging again. Money already spent or held cannot be clawed back into a negative grant: the unavailable portion becomes a durable `payment_adjustment` reconciliation item. Reversal restores only amounts actually removed, and clears or updates that case. Full financial reversal ends the purchase entitlement; reversal of that financial adjustment can restore it. Dispute creation remains reviewable, but does not itself invent a withdrawal amount.

Overlapping refunds and disputes exceeding the original purchase value create an additional reconciliation case for the uncovered monetary amount. The library caps credit removal at the purchase grant rather than inventing a negative grant or hiding that excess.

Provider work verifies its lease inside the financial transaction. A stale worker returning after takeover cannot overwrite a newer cumulative snapshot. Automatic top-ups wait for accepted payment notifications, refresh authoritative subscription state when supported, and recheck the balance before a new purchase. Once an external attempt may have started, retries preserve the original intent rather than silently canceling or issuing a fresh purchase.

## Cost periods and streams

`periods.create/get/check/set_status/reserve/settle/release` operate on existing additive counter records, with customer-scoped database serialization. Terms include `currency`, `start`, `end`, `included`, `markupBasisPoints`, and `overageCap`. Cost amounts are bounded integer units chosen consistently by the host (for example currency micros); they are separate from wallet decimal quantities. Terms and settlement source receipts are immutable. Status changes require an audited reason.

`active` and `pending` apply the allowance/cap rule; `grace`, `billing-hold` and `ended` block; `manual` bypasses the cap. A period must still cover the requested time. Live reservations reduce capacity. Checks retain recorded settled charges rather than rerating historical cost. `periods.reserve` enforces admission atomically; `periods.check` is advisory. Settling a provider cost does not silently deduct a prepaid wallet or issue an invoice: the host chooses the funding/export flow and must not bill both paths.

For streams, reserve a decimal estimate with a request-derived idempotency key and `expiresAt = openedAt + 3_600_000`, `onExpiry: "settle_estimate"`. Settle actual cost using another stable key. Increase the reservation explicitly before spending beyond its hold. The scheduler's bounded maintenance call settles a funded abandoned reservation at its estimate exactly once; unavailable or expired grant backing creates reconciliation instead. Late actuals become an explicit adjustment case. Normal reservations continue to release on expiry unless this policy is selected. `cargo run -p brokeboy --features sqlite --example streaming` demonstrates the complete sequence with a simulated clock.

## Processor routing and Polar

Construct `PolarOptions` with its access token, signing secret, environment and a product-ID-to-plan-ID map. Sandbox uses `https://sandbox-api.polar.sh/v1`; live configuration uses `https://api.polar.sh/v1`. No live requests were made for qualification. Standard Webhooks key decoding is the default; select `legacy_literal_secret` explicitly for old literal-secret endpoints. Signatures bind raw bytes and enforce a five-minute timestamp window.

`provider::Providers` accepts a default processor and registered adapters. Trusted server calls can select `provider`; queued work retains that choice. Subscription notifications retrieve canonical provider state, resolve configured products, and retain pinned catalog versions when no new version is specified. The browser does not choose arbitrary customers or administrative processors.

Polar meter configuration maps a feature to an event name aggregating currency minor units. The adapter exports Brokeboy's rated delta with a stable `external_id` and owner identity. It refuses late periods for reconciliation. Fixture tests cover the request shapes and stable identity; a real Polar account, ingestion deduplication, meter-summary reconciliation and merchant lifecycle qualification are still required. Unsupported commerce operations return an explicit error. Keep the existing Polar export/reconciliation lane until those checks pass.

## What the host application must keep

- Authentication, organization authorization, signed browser receipt tickets, allowed redirect policy, customer identity selection, feature rollout and billing/export writer fences.
- Resource attribution (including retired provider IDs), bring-your-own-connection exclusions, canonical provider report retrieval, report completeness checks, rotating closed-window selection, and immutable pricing evidence.
- Splitting usage windows across fully covering billing periods; rejecting gaps/overlaps; checking resource configuration and period terms have not changed between observation and settlement; finalization by provider event/execution identity.
- Snapshot retained/deleted timestamps, lifecycle and lease locks, price-version approval, fractional-duration remainder checkpoints, and retention/deletion policy. Brokeboy does not wake, delete or discover snapshots.
- Existing host financial and nonbillable telemetry outboxes, original delivery keys/receipts, cumulative-cent rounding and correction checkpoints, and reconciliation against provider meter totals. Do not replay an acknowledged old outbox item through a new Brokeboy operation key.
- Pre-cutover charge/refund/dispute provenance and any ambiguous old payment attempts. Opening-balance transfer is not a historical receipt migration.
- A scheduler for bounded maintenance, reconciliation operations, backup/restore and an integration exercise against the actual host. Run only the native maintenance engine for the new period/expiry policies; the 0.1 maintenance engine does not understand them. Rust and native TypeScript 0.2 services share the same rules.

The legacy application settlement/storage/export integration tests were inspected as reference but were not executed or claimed to pass against Brokeboy. Application-specific resource settlement remains an integration boundary, not code embedded in this library.
