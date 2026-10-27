# Embedded billing architecture

The engine has no network or runtime-specific imports. `core/catalog` owns validation, canonical versions, calendar arithmetic and rating; `core/ledger` owns allocation, movements, reservations and allowance materialization; `core/engine` composes customer, subscription and operation APIs. Integration entry points import their own optional peers.

Money, credit quantities and feature quantities remain different domain concepts. Storage uses decimal strings; arithmetic uses scaled integers. A grant records original allowance and provenance. Append-only movements record spending and reversals. Reservation allocations hold balances. Counter projections accelerate reads and can be compared against movements and held reservations.

A customer-scoped transaction atomically commits usage, movements, projections, operation replay results and durable work. PostgreSQL/MySQL serialize on a scope lock. Local SQLite uses a write transaction and connection serialization. D1 prepares a revision-checked batch; every write is conditional on the same commit token. Failed comparison retries the domain operation against current state. No network effects run inside these callbacks.

Stripe requests run outside database transactions under a customer payment lane. Work leases and stable external identities allow retries. Global provider-resource mappings persist each creation outcome and its first attempt time. They remain useful after the provider's request-idempotency cache expires. Ambiguous attempts older than 23 hours require reconciliation, not blind recreation.

Webhook handling verifies the original payload, resolves ownership and durably accepts an inbox event before acknowledging it. Maintenance reconciles against current provider state, handles duplicate events, applies grants and queues application callbacks. Checkout and invoice events share canonical purchase provenance. Event IDs and operation identities are durable; no automatic retention job currently deletes financial history.

Maintenance processes bounded customer and work batches with a persisted scan cursor. Grant materialization considers relevant recent periods and configured rollover history rather than replaying every historical period on each request. There is no required Redis, queue service, analytics database, process daemon or global edge cache.

The SQL adapter deliberately validates supported client capabilities. D1 does not emulate a PostgreSQL transaction callback. No cache authorizes spending. Storage errors propagate. An advisory entitlement check cannot promise funds remain available; use consumption or reservation for enforcement.

The package assumes an application's configured Stripe account and database belong to that application. Multi-merchant Stripe Connect routing is a separate future integration. Infrastructure resources and external usage evidence remain the integrating application's responsibility.

`core/workflows` owns bounded dependency graphs, customer-scoped atomic funding, worker fencing, checkpoints and reconciliation. It uses the same ledger reservation primitives as the standalone reservation APIs. External jobs execute in the application. Durable internal timeout work bypasses the payment-provider lane; no payment connectivity is needed to expire leases. Workflow state is persisted in its own table and included in customer archives.
