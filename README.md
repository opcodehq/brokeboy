# Brokeboy

**Billing, credits, and entitlements in your application and database.**

Brokeboy is an MIT-licensed TypeScript library with an Effect backend. It runs in your backend, stores billing data in your database, and uses your Stripe account for payments. There is no Brokeboy service, account, transaction fee, or required dashboard.

This repository is an **alpha**. The implementation includes the billing engine and integrations below; merchant-authorized Stripe sandbox and hosted-driver qualification are release gates, not claims made by the unit tests. See [verification](internal-docs/verification.md).

Upgrading from alpha.0: generate and apply the additive workflows-table migration before using the new workflow, admin-inspection or snapshot-export APIs. See [the recovery guide](internal-docs/recovery.md#workflow-upgrade-and-recovery).

## Try it

```sh
git clone https://github.com/opcodehq/brokeboy.git
cd brokeboy
bun install
bun run build
bun run examples/bun-sqlite/index.ts
```

To install the locally built library into another application:

```sh
npm pack
# From your application:
npm install /path/to/brokeboy/brokeboy-0.1.0-alpha.2.tgz
```

The default SDK returns promises. Effect applications can use the native services and layers in `brokeboy/effect`; see the [Effect integration guide](docs/effect.md). Effect 4.0.7 is installed as a runtime dependency.

The package has separate entry points. React, Drizzle, and Stripe are optional peers; importing `brokeboy` does not import them. Payment processing and your infrastructure still have their own costs.

## Connect your existing database

```ts
import { brokeboy } from "brokeboy";
import { drizzleAdapter } from "brokeboy/drizzle";
import { db } from "./db";

export const billing = brokeboy({
  database: drizzleAdapter(db, { dialect: "postgres" }),
  environment: "test",
});
```

Export the billing tables alongside your application's Drizzle schema:

```ts
export * from "brokeboy/schema/postgres";
// Or brokeboy/schema/mysql, brokeboy/schema/sqlite (including D1).
```

Generate, review, and apply migrations through your existing Drizzle workflow. Brokeboy never migrates a database or creates Stripe resources during initialization. `brokeboy schema --dialect postgres --sql` also prints the standalone initial SQL.

| Dialect               | Driver                                                             |
| --------------------- | ------------------------------------------------------------------ |
| PostgreSQL            | `pg.Pool`, including Drizzle `node-postgres`                       |
| PostgreSQL on Workers | Neon WebSocket `Pool` and Drizzle `neon-serverless`                |
| MySQL                 | `mysql2/promise` Pool                                              |
| SQLite on Node        | `better-sqlite3`                                                   |
| SQLite on Bun         | `bun:sqlite`                                                       |
| Cloudflare D1         | D1 binding with Drizzle schema support and an atomic-batch adapter |

Use a transactional driver. HTTP-only Postgres drivers and arbitrary Drizzle drivers are not interchangeable with this matrix. D1 requires its dedicated adapter path, not a simulated interactive transaction. On Workers, use the driver's documented connection binding and lifetime management.

## Define and publish pricing

```ts
import { defineCatalog } from "brokeboy";

export const catalog = defineCatalog({
  features: [
    { id: "credits", kind: "consumable" },
    { id: "messages", kind: "consumable" },
  ],
  plans: [
    {
      id: "free",
      name: "Free",
      kind: "free",
      items: [
        { feature: "credits", included: "100", reset: "month" },
        { feature: "messages", pool: "credits", rate: { amount: "2" } },
      ],
    },
  ],
});

// Run explicitly in your setup/deploy workflow, after reviewing the diff.
await billing.catalog.publish({ catalog, expectedRevision: 0 });
```

Plans are immutable published versions. SDK/admin edits and code-driven publication use the same revision checks. Existing customers stay on their original version. Omission does not delete plans or cancel subscriptions. `catalog.export()` includes current plans, features, and historical versions.

## Use billing directly from trusted server code

```ts
await billing.customers.create({ id: user.id, idempotencyKey: "signup" });
await billing.subscriptions.attach({
  customerId: user.id,
  planId: "free",
  idempotencyKey: "free-plan",
});

const receipt = await billing.usage.consume({
  customerId: user.id,
  feature: "messages",
  amount: "1",
  idempotencyKey: request.id,
});
```

Amounts are decimal strings with at most six fractional digits. Consumption is atomic. A read-only entitlement check is advisory; it is not a reservation. Identical idempotent requests replay their persisted result, and conflicting payloads fail explicitly.

For uncertain-cost work, reserve a credit amount, then settle the actual credits or release the hold. The returned reservation identifies the pool and expiry; settlement amounts are in that pool's units.

```ts
const hold = await billing.reservations.create({
  customerId: user.id,
  feature: "credits",
  amount: "20",
  idempotencyKey: `${request.id}:reserve`,
});
await billing.reservations.settle({
  customerId: user.id,
  reservationId: hold.id,
  amount: "12",
  idempotencyKey: `${request.id}:settle`,
});
```

Late or uncovered settlement records a reconciliation operation. It does not silently disappear or unexpectedly charge a card. Persist operation IDs in your own job state.

## Add payments

```ts
import Stripe from "stripe";
import { stripeProvider } from "brokeboy/stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const billing = brokeboy({
  database: drizzleAdapter(db, { dialect: "postgres" }),
  environment: "test",
  provider: stripeProvider({
    client: stripe,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    environment: "test",
  }),
});
```

`subscriptions.checkout`, `update`, `preview`, `cancel`, `pause`, `resume`, `schedule`, and `portal` persist their payment operation before execution. Inspect the returned `status`, `result`, and `error`; a recoverable operation is not equivalent to a completed payment. `operations.retry` retains the original provider identity.

Stripe products, prices, meters, and customers are created lazily during explicit payment operations. Their mappings are durable in your database, independently of Stripe's request-idempotency retention.

Mount the optional handler and connect your auth:

```ts
import { toHandler } from "brokeboy/server";

export const handler = toHandler({
  billing,
  resolveCustomer: async (request) => {
    const session = await verifyYourSession(request);
    return session?.userId ?? null;
  },
});
```

Mount it at `/api/billing/*` and register `/api/billing/webhook` in Stripe. Browser writes require a trusted Origin. Administrative routes require a separate `authorizeAdmin` callback. The handler derives identity server-side and does not expose credit-write methods to customers.

Call `await billing.maintenance.run({ limit: 100 })` from a durable scheduler, normally every minute. Each call advances a persisted customer cursor. On Workers, use a scheduled handler; do not rely on a background interval surviving serverless suspension.

## Features

- Recurring subscriptions, free plans, one-time/lifetime purchases, add-ons and custom customer deals.
- Flat, per-unit, graduated, volume and dimensional pricing; prepaid pools and postpaid overages.
- Credit grants, priority allocation, expiry, capped rollover, exact usage and atomic reservations.
- Entity balances, customer-shared pools, persistent quantities and license assignments.
- Trials with explicit allowances, spending caps, threshold events and bounded automatic top-ups.
- Checkout, payment portals, subscription changes, schedules, tax opt-in, discounts, invoices, refunds and credit notes through Stripe.
- Durable job workflows with dependency graphs, atomic stage budgets, worker leases, retries and audited recovery.
- Atomic multi-event usage ingestion and paginated dimensional usage aggregation.
- Durable webhook inbox, idempotent operations, resource mappings, work leases, audit events and reconciliation.
- Catalog revision checks, import/export, external subscription linking, CLI and optional React components.

Use `addOn: true` for independent subscription add-ons. Base plans share the default `base` group. Free plans are attached directly; paid plans require verified payment. Trial consumable allowances default to zero unless `trialIncluded` is configured. A trial is claimed once per application customer ID; your auth system owns identity verification.

See [complex workflows](docs/workflows.md), [API and policies](docs/api.md), [React toolkit](docs/react.md), [architecture](internal-docs/architecture.md), and [operations and recovery](internal-docs/recovery.md).

## Develop

```sh
bun run check
TEST_POSTGRES_URL=postgresql://... TEST_MYSQL_URL=mysql://... bun run test:integration
bun run test:d1
bun run benchmark
```

Tests use dedicated disposable databases. Do not point them at application or production databases. GitHub CI provisions PostgreSQL and MySQL services. [MIT license](LICENSE).
