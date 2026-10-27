# API and billing policy

## SDK groups

| Group             | Methods                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `catalog`         | `validate`, `diff`, `publish`, `get`, `custom`, `migrate`, `export`                                  |
| `customers`       | `create`, `get`, `update`                                                                            |
| `entities`        | `create`, `list`, `update`                                                                           |
| `credits`         | `grant`, `balance`, `list`, `adjust`, `reconcile`                                                    |
| `entitlements`    | `check`, `list`                                                                                      |
| `usage`           | `consume`, `record`, `list`, `correct`, `setQuantity`                                                |
| `reservations`    | `create`, `increase`, `settle`, `release`, `list`                                                    |
| `subscriptions`   | `attach`, `list`, `checkout`, `preview`, `update`, `cancel`, `pause`, `resume`, `schedule`, `portal` |
| `licenses`        | `assign`, `release`, `list`                                                                          |
| `billingControls` | `get`, `update`                                                                                      |
| `commerce`        | `invoices`, `invoice`, `refund`, `creditNote`                                                        |
| `operations`      | `get`, `list`, `retry`, `resolve`                                                                    |
| `events`          | `list`                                                                                               |
| `migration`       | `export`, `import`, `linkSubscription`                                                               |
| `maintenance`     | `run`                                                                                                |

`resources.inspect` and `resources.reconcile` expose provider-resource recovery to trusted server code. Reconciliation verifies the resource in the provider account before accepting its identity.

History `list` methods return the first 100 records. Use `page` with `limit` and the returned `nextCursor` to continue.

Published TypeScript declarations specify the argument and return types. Server-side methods trust the application's customer/actor context. Do not forward raw browser bodies into them.

## Decimal values and pricing

Use strings such as `"20"`, `"0.000001"`, or `"12.50"`. Values have up to six fractional digits and a signed-64-bit scaled range. `usage.consume` requires a positive quantity; `setQuantity` accepts zero. Money uses decimal major currency units, and Stripe amounts are converted to the currency's minor units at the provider boundary.

Rates support a flat `amount`, ordered `tiers` (last `upTo: null`), or exact-match `dimensions`. Multiple matching dimension rules are an error. Overage included usage is shared across all event properties. Tier/rate versions are preserved in receipts. Meter exports use differences of cumulatively rounded totals rather than independently rounding every event.

A feature can be boolean, consumable, or a persistent quantity. Exported table variables use a `billing` prefix, such as `billingCustomers` and `billingGrants`, to avoid colliding with application models.

Use `usage.setQuantity` or `licenses.assign` for quantities, not `usage.consume`. Quantity allowances do not reset. Assignment and explicit quantity occupancy share capacity checks.

## Grants, reservations and correction

Smaller numeric priority wins; equal priority consumes earliest expiry, then creation time and ID. Purchased packs are priority 10; recurring grants are priority 0. Expired, revoked, and review-held grants cannot fund new usage. Rollover caps apply to the aggregate active rollover balance, with a maximum configured lifetime of 120 periods.

Reservations default to 15 minutes and cannot outlive their allocated grants. `increase.amount` adds credits to an existing reservation. `settle.amount` is the actual amount in the returned pool's units, not a token count that needs re-rating. Settling beyond the hold or after release/expiry records reconciliation. Release and settlement are idempotent.

`usage.correct` reverses an entire prepaid receipt with append-only movements. Postpaid corrections create an adjustment case because a finalized invoice must not be silently rewritten. Grant adjustments require a reason; positive adjustment amounts debit a grant and negative amounts restore previously spent credit. New promotional credit uses `credits.grant`.

## Subscription policy

- Plans default to one mutually exclusive `base` group; additional groups and `addOn: true` support independent products. One-time purchases do not occupy a recurring base-plan slot.
- Use `checkout` for a new paid subscription and `update` for an existing one. An unexpired same-plan Checkout attempt is reused, including when a new application retry key is supplied.
- `update` defaults to the end of the current period. Pass `effective: "now"` for an immediate change with Stripe proration. Upgrade allowances are the additional current-period amount, not a second full grant.
- Cancellation defaults to period end. Pause suspends access while Stripe collection is paused. Resume restores access only within verified payment coverage.
- Annual collection and monthly allowances are separate settings: `interval: "year"`, item `reset: "month"`.
- `trialDays` enables a single claimed trial per application customer. `trialIncluded` explicitly specifies consumable trial allowances; the default is zero. A customer identity change is the application's responsibility.
- Failed payment grants no new normal paid allowance. Optional `graceDays` (1–30) and `graceIncluded` explicitly define grace access; grace does not change verified payment evidence.
- Stripe refunds revoke unspent purchased entitlements and retain consumed-usage cases for review. Partial refunds and disputes freeze matching purchase grants pending reconciliation. They do not erase usage history.

`poolScope: "customer"` draws a child entity's configured pool from the parent customer's balance. Otherwise grants and allowances are entity-specific. License assignments consume parent quantity capacity and require a previously created entity.

## Spending controls

`overageLimits` are monetary amounts per feature and billing period. Alerts are credit balance thresholds; event delivery is an application callback with a durable outbox. Register `hooks.onEvent` and use the supplied event ID to deduplicate downstream delivery.

An auto-top-up specifies feature, threshold, one-time pack plan, and a maximum number of purchase attempts in a UTC calendar month. It requires saved payment credentials. Attempts are serialized and credits arrive only after paid evidence. A failed or ambiguous charge can leave top-up coordination pending for review; never clear that state by deleting database rows.

## Schema and configuration

The exported schemas include separate customers, entities, catalog versions, subscriptions, grants, movements, reservations, usage, operations, inbox, work, events, audit, counters and resource-mapping tables. Rows use scope, ID, state and serialized typed domain data. Work additionally indexes its next eligible execution time. State indexes keep live operational paths separate from historical records. Applications can inspect these tables through Drizzle Studio, but writes must go through the SDK.

`catalog.publish({catalog,expectedRevision})` is explicit. Retrying the same catalog is a no-op. Conflicting revisions fail; users choose whether to pull the database version or publish a reviewed update. `catalog.custom` publishes a private plan. Omitting plans leaves them and existing subscribers intact. Export includes current definitions and historical versions.

The initial schema is version 1. Review generated database migrations in source control. Never auto-apply migrations on request startup.
