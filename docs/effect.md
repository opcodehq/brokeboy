# Effect backend

Brokeboy's engine, ledger, workflows, provider-resource registry, Stripe orchestration, storage operations, HTTP handler and CLI compose native Effect programs. The installed dependency is pinned to Effect **4.0.7**, the npm `latest` release selected for this migration. Pure fixed-point arithmetic and catalog policy functions remain synchronous.

The existing `brokeboy()` SDK returns ordinary promises. It converts Effects only at the application boundary. You can keep the existing integration or use `brokeboy/effect` to compose billing in an Effect application.

## Native services

```ts
import { Effect } from "effect";
import { BillingService, layer } from "brokeboy/effect";
import { drizzleStorage } from "brokeboy/drizzle";
import { stripeService } from "brokeboy/stripe";

const BillingLive = layer({
  database: drizzleStorage(db, { dialect: "postgres" }),
  environment: "test",
  provider: stripeService({ client: stripe, webhookSecret }),
});

const consume = Effect.gen(function* () {
  const billing = yield* BillingService;
  return yield* billing.usage.consume({
    customerId: "team_123",
    feature: "credits",
    amount: "3",
    idempotencyKey: "request_456",
  });
});

await Effect.runPromise(consume.pipe(Effect.provide(BillingLive)));
```

The application supplies the Drizzle client and Stripe client as before. Importing the core does not load those optional peer libraries. `memoryStorage()` supplies ephemeral native storage for tests and examples. `memoryAdapter()` and `drizzleAdapter()` retain their promise interfaces.

`BillingStorage` is a `Context.Service` for the storage contract. `BillingConfig` is a `Context.Reference` for environment, provider and hooks. `billingLayer` builds `BillingService` from those dependencies; `layer(options)` composes them for normal use. Native layers use Effect's `Clock`. Provide `TestClock.layer()` around layer construction for deterministic deadline and grant-period tests. Stripe test clocks are still needed for actual payment-renewal scenarios. Constructing `EffectBilling` directly also accepts a synchronous `now` callback for existing deterministic fixtures.

Methods return lazy `Effect<Success, BillingFailure>` values. Import `BillingFailure` and its schema-backed tagged errors from `brokeboy/effect`:

- `BillingError`: domain validation or policy failure; inspect `code`.
- `StorageError`: database or driver failure, with the original cause.
- `ProviderError`: payment-provider I/O failure, with the original cause.
- `IntegrationError`: application integration failure.

Use `Effect.catchTag` or `Effect.catchTags` to handle expected failures. Unexpected programming defects remain defects. Promise compatibility unwraps the failure at the boundary, preserving normal `BillingError` instances and codes.

Use native `stripeService()` with native billing, or `stripeProvider()` with the promise SDK. Native event hooks return Effects; promise hooks are lifted at the boundary. Existing custom promise storage and payment providers continue to work, including overridden methods. Native adapters avoid a runtime crossing for each database operation.

## Transactions and cancellation

Memory and SQLite serialization use Effect semaphores. Interrupted waiters release their permits, and interrupted memory transactions restore their snapshots. PostgreSQL/MySQL connections are acquired with `Effect.acquireUseRelease`. Success commits; failed or interrupted domain work rolls back. Failed transaction startup or rollback quarantines the connection instead of returning it to the pool.

Database driver promises cannot generally be aborted safely. Brokeboy waits for an in-flight driver command to settle before rolling back or releasing its connection. Configure connection and query timeouts in the application-owned driver. An Effect timeout cannot forcibly terminate a non-abortable driver call safely.

D1 continues to use primary-session reads and revision/token-guarded atomic batches. Every dependent write checks the same commit token. Submission of an atomic batch is observed through completion; contention backoff uses `Effect.sleep` and remains bounded.

Interruption is never converted into successful recovery. If cancellation occurs after an external payment intent has been saved, the processing lease remains durable. Maintenance recovers it with the same external idempotency identity after lease expiry. Provider-resource creation follows the same principle. Brokeboy does not blindly retry a payment outside its safe provider window.

Durable business retries still use persisted work and eligibility times. They are not replaced by in-process `Effect.retry` loops that vanish when a serverless invocation exits. Provider resource contention and D1 conflicts use Effect scheduling without requiring a long-lived timer.

Promise storage callbacks are a compatibility boundary and cannot be interrupted halfway through their transactions. Use native storage for native Effect composition. Database schema and historical operation/ledger formats are unchanged by this migration; the existing alpha.1 workflow-table migration is still required when upgrading from alpha.0.

## HTTP and CLI

`toHandler()` retains the Web Request/promise API and forwards `request.signal` into Effect execution. `effectHandler()` accepts an `EffectBilling` instance and Effect-valued identity/authorization callbacks. It returns a native Effect for each request. JSON bodies are size-bounded, decoded with `Schema`, and their stream readers are cancelled and released on interruption.

Both handlers enforce the same trusted identity, administrator authorization, Origin checks and public-response redaction. Native handlers preserve interruption rather than returning an artificial success or swallowing it as an HTTP error.

CLI configuration can export either a promise SDK or a native `EffectBilling` instance as `billing`. The CLI runs one Effect program at its process boundary. It lifts configuration/module and filesystem I/O, then uses the configured native backend. Domain writes expose `brokeboy.<operation>` tracing spans; they do not log secrets or customer payloads by default. Applications choose their telemetry exporter and retention policy.

## Reference checkout and verification

The local read-only reference lives at `.repos/effect`, excluded from Git, Biome, TypeScript inputs and package output. This migration used its `LLMS.md`, services, resource, error and runtime guides, plus the installed package's declarations/source. Reference checkout: `7ea1ea2ecfb1bb4808901c522259de44aaee6136`; package version: `4.0.7`. Runtime code imports the declared npm dependency, never `.repos` files.

Run `bun run examples/effect/index.ts` for a native workflow. Run `bun run check` for shared behavior and native cancellation tests. `bun run test:d1` additionally bundles an Effect worker and executes it inside workerd against a real D1 binding. External merchant and hosted-deployment qualification remain listed in [verification](../internal-docs/verification.md).
