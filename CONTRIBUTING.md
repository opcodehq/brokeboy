# Contributing

Use Bun 1.3.10 and Node 22.16 or newer. Install with `bun install`, then run `bun run check`. Database integration tests accept dedicated `TEST_POSTGRES_URL` and `TEST_MYSQL_URL` databases; CI provisions disposable PostgreSQL/MySQL services. Run `bun run test:d1` for the Workers adapter.

The engine must remain independent of its optional integrations. Keep pricing and arithmetic in core modules, atomicity in storage adapters, and payment network calls outside database transactions. Preserve original operations and append corrections; do not rewrite financial history.

Schemas are generated from the storage table manifest with `bun run schemas:generate`. Commit generated schema changes and review the corresponding application migration. `schemas:check` rejects drift. New adapters must pass the same behavioral contracts.

Keep public examples runnable, document actual verification limits, and use explicit prerelease versions until the stable-release gates pass. All contributions use the MIT license.
