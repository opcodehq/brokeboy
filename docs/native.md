# Native Rust billing (0.2 preview)

Brokeboy's native SDK executes billing in Rust inside your process. Rust applications use the engine directly; Node and Bun use an asynchronous NAPI addon. Both use the same database records and customer locks. No JavaScript runtime is needed by Rust applications, and no Brokeboy service is involved.

This is a source preview, not a published or fully qualified 0.2 release. The repository's default npm entry point remains 0.1 until the compatibility and platform release gates pass. Use `brokeboy/native` and `brokeboy/native/effect` to evaluate the Rust engine. Workers/D1 continue on `release/0.1`.

## Build and connect

Repository contributors need Rust 1.94 and Bun. Published native artifacts will not require a compiler; the seven platform packages are staged and tested before publication.

```sh
bun install --frozen-lockfile
bun run native:build
cargo build --locked -p brokeboy-cli
```

Generate and review SQL explicitly. Existing 0.1 billing tables are compatible; the Rust port does not require a schema rewrite.

```sh
cargo run -p brokeboy-cli -- schema sqlite > billing.sql
# Apply billing.sql through your application's migration workflow.
```

Keep Drizzle schema exports in your application for migration generation and inspection. Replace Drizzle/client injection with a connection configuration when opening the native engine:

```ts
import { Billing } from "brokeboy/native";

const billing = await Billing.open({
  database: {
    driver: "postgres",
    url: process.env.DATABASE_URL!,
    maxConnections: 10,
  },
  environment: "test",
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  },
});

try {
  await billing.customers.create({
    id: "organization-1",
    idempotencyKey: "create",
  });
  await billing.credits.grant({
    customerId: "organization-1",
    feature: "requests",
    amount: "10",
    idempotencyKey: "fund",
  });
  const receipt = await billing.usage.consume({
    customerId: "organization-1",
    feature: "requests",
    amount: "1.25",
    idempotencyKey: "request-1",
  });
  console.log(receipt);
} finally {
  await billing.close();
}
```

Use `driver: "mysql"` or `"sqlite"` for the other SQLx adapters. SQLite URLs point to existing database files. Startup never creates tables or Stripe resources. Configure separate connection limits for each application process, accounting for the combined database budget.

`catalog`, `customers`, `entities`, `credits`, `entitlements`, `usage`, `reservations`, `subscriptions`, `licenses`, `billingControls`, `commerce`, `operations`, `resources`, `events`, `migration`, `workflows`, and `maintenance` retain their promise-based method groups. Money and quantities remain decimal strings. Hashes retain decimal spelling, so a retry of `"1.00"` must use `"1.00"` again.

## Rust applications

Enable only the dependencies you use:

```toml
# In this source checkout; crates are not yet published.
brokeboy = { path = "../brokeboy/crates/brokeboy", features = ["postgres", "stripe", "http"] }
```

Applications with an existing SQLx pool can construct `SqlStorage::borrowed(pool.clone())`, wrap it in `Arc`, and call `Billing::from_storage(storage, options)`. Closing that engine does not close the application pool. `SqlStorage::owned` and `Billing::open_config` close their owned pools. Provider ownership is explicit through `BillingOptions::owns_provider`; custom providers are borrowed by default.

Use `billing.usage().consume(input).await?` and the other grouped methods, or `billing.call("usage.consume", input).await?` for extensible JSON inputs. Common results use shared Rust DTOs. Administrative reports and provider payloads retain extensible JSON fields. Custom storage, provider, clock, identifier, and event-delivery traits are object safe.

Run the standalone example after applying the schema:

```sh
BROKEBOY_DATABASE_URL=sqlite:///absolute/path/billing.sqlite cargo run -p brokeboy --features sqlite --example embedded
BROKEBOY_DATABASE_URL=sqlite:///absolute/path/billing.sqlite bun examples/native/index.ts
```

## HTTP, React, and Effect

The existing `toHandler` from `brokeboy/server` accepts the native handle. Resolve identity and authorize administrators on the server. Public HTTP routes never take the customer's identity from a browser-provided customer ID. React hooks/components continue using those HTTP contracts; `brokeboy/react` imports no native addon.

Rust applications can enable `http` and implement `brokeboy::http::Authorization` for the framework-independent `Handler`. It accepts raw `http::Request<Vec<u8>>` and produces JSON responses. Configure the application origin explicitly. Mount the webhook route with the original raw bytes; request parsing must not alter its body.

```ts
import { Effect } from "effect";
import { make } from "brokeboy/native/effect";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const billing = yield* make({
        database: {
          driver: "sqlite",
          url: "sqlite:///absolute/path/billing.sqlite",
        },
      });
      return yield* billing.customers.get("organization-1");
    }),
  ),
);
```

`make` acquires/releases the native handle in the Effect scope; `layer` provides `BillingService`. Domain, storage, provider, and integration failures use typed channels. Effect interruption and HTTP request aborts propagate to synchronously registered native cancellation handles. Interrupted financial work rolls back or quarantines the connection; ambiguous payment intents remain durable for reconciliation. Await close on application shutdown rather than relying on process-exit hooks.

## Maintenance and recovery

Call `maintenance.run({ limit: 100 })` from cron or a scheduled application job. Delivery callbacks run outside database transactions and must deduplicate event IDs. Neither renewal nor retries depend on a process timer staying alive.

The native CLI uses the same engine:

```sh
brokeboy-native init
brokeboy-native schema postgres
brokeboy-native --config brokeboy.json doctor
brokeboy-native catalog diff brokeboy.catalog.json
brokeboy-native catalog apply brokeboy.catalog.json
brokeboy-native customer inspect organization-1
brokeboy-native reconcile organization-1
brokeboy-native migrate export organization-1 --out customer-snapshot.json
```

Configuration can reference `database.urlEnv`, `stripe.secretKeyEnv`, and `stripe.webhookSecretEnv`. Prefer references to secrets in configuration files. Export files are created with restrictive permissions and never overwrite existing files. Catalog apply requires the exported `expectedRevision`; resolve conflicting edits explicitly.

Before enabling native writers, take a consistent backup, restore it to an isolated database with payments disabled, verify ledger reconciliation, and replay committed operation keys. The native test suite performs this SQLite receipt/restore exercise. Never enable payment execution independently in two migration destinations. Concurrent Rust and TypeScript processes sharing one database use the existing locks and operation identities; the native tests verify mixed-process spending and receipt replay.

See the repository's [Rust port status](https://github.com/opcodehq/brokeboy/blob/main/internal-docs/rust-port.md) for exact coverage and remaining release gates. MIT licensing applies to the engine, bindings, adapters, CLI, and UI.
