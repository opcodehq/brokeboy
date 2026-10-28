#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import { effectBilling } from "./billing.js";
import { fail, integration, runPromise, task } from "./core/effect.js";
import type { EffectBilling } from "./core/engine.js";
import { type Dialect, migrationSQL } from "./drizzle.js";
import type { Billing } from "./index.js";

const args = process.argv.slice(2),
  command = args.shift();
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const output = (value: unknown) =>
  process.stdout.write(
    `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`,
  );
function main() {
  return task(function* () {
    if (!command || command === "help" || command === "--help") {
      output(
        "brokeboy init | schema --dialect postgres|mysql|sqlite|d1 [--sql] | doctor | catalog diff|apply|export | customer <id> | workflows <customerId> [workflowId] [--entity id] | reconcile <id> | maintenance | export <id> | import <snapshot.json> [--apply]\nUse --config ./billing.config.ts. Config exports billing and optional catalog, expectedRevision.",
      );
      return;
    }
    if (command === "init") {
      yield* integration(() =>
        writeFile(
          resolve("billing.config.ts"),
          'import { brokeboy, defineCatalog } from "brokeboy";\nimport { drizzleAdapter } from "brokeboy/drizzle";\nimport { db } from "./db";\n\nexport const catalog = defineCatalog({ features: [], plans: [] });\nexport const expectedRevision = 0;\nexport const billing = brokeboy({ database: drizzleAdapter(db, { dialect: "postgres" }), environment: "test" });\n',
          { flag: "wx" },
        ),
      );
      output(
        "Created billing.config.ts. Connect your database, export billing schemas, apply migrations, and add your Stripe provider. No database or payment resources were modified.",
      );
      return;
    }
    if (command === "schema") {
      const dialect = flag("dialect") as Dialect;
      if (!["postgres", "mysql", "sqlite", "d1"].includes(dialect))
        return yield* fail(
          new Error("Choose --dialect postgres|mysql|sqlite|d1."),
        );
      output(
        args.includes("--sql")
          ? `${migrationSQL(dialect).join(";\n")};`
          : `export * from "brokeboy/schema/${dialect === "d1" ? "sqlite" : dialect}";`,
      );
      return;
    }
    const jiti = createJiti(import.meta.url);
    const config = yield* integration(() =>
      jiti.import<{
        billing: Billing | EffectBilling;
        catalog?: unknown;
        expectedRevision?: number;
      }>(resolve(flag("config") ?? "billing.config.ts")),
    );
    const configuredBilling = config.billing;
    if (!configuredBilling)
      return yield* fail(new Error("Config must export billing."));
    const billing = effectBilling(configuredBilling);
    const positionals = args.filter(
      (_, index) =>
        !args[index]?.startsWith("--") &&
        (index === 0 || !args[index - 1]?.startsWith("--")),
    );
    switch (command) {
      case "doctor": {
        const catalog = yield* billing.catalog.export();
        output({
          environment: billing.environment,
          catalogRevision: catalog.revision,
          plans: catalog.plans.length,
          storage: "reachable",
          note: "This checks database access. Verify webhook registration and run maintenance through your scheduler.",
        });
        break;
      }
      case "catalog": {
        const action = positionals[0];
        if (action === "export") {
          output(yield* billing.catalog.export());
          break;
        }
        if (!config.catalog)
          return yield* fail(new Error("Config must export catalog."));
        if (action === "diff")
          output(
            yield* billing.catalog.diff(
              config.catalog as Parameters<Billing["catalog"]["diff"]>[0],
            ),
          );
        else if (action === "apply") {
          if (!args.includes("--yes"))
            return yield* fail(
              new Error(
                "Review catalog diff, then supply --yes and an explicit expectedRevision in config.",
              ),
            );
          if (config.expectedRevision === undefined)
            return yield* fail(
              new Error("Config must specify expectedRevision."),
            );
          output(
            yield* billing.catalog.publish({
              catalog: config.catalog as Parameters<
                Billing["catalog"]["diff"]
              >[0],
              expectedRevision: config.expectedRevision!,
            }),
          );
        } else
          return yield* fail(new Error("Choose catalog diff|apply|export."));
        break;
      }
      case "workflows": {
        const customerId = positionals[0] ?? "";
        const workflowId = positionals[1];
        output(
          workflowId
            ? yield* billing.workflows.get({
                customerId,
                workflowId,
                entityId: flag("entity"),
              })
            : yield* billing.workflows.page({
                customerId,
                entityId: flag("entity"),
                cursor: flag("cursor"),
              }),
        );
        break;
      }
      case "customer":
        output(yield* billing.customers.get(positionals[0] ?? ""));
        break;
      case "reconcile":
        output(yield* billing.credits.reconcile(positionals[0] ?? ""));
        break;
      case "maintenance":
        output(
          yield* billing.maintenance.run({
            limit: Number(flag("limit") ?? 100),
          }),
        );
        break;
      case "export":
        output(yield* billing.migration.export(positionals[0] ?? ""));
        break;
      case "import": {
        const snapshot = JSON.parse(
          yield* integration(() =>
            readFile(resolve(positionals[0] ?? ""), "utf8"),
          ),
        );
        output(
          yield* billing.migration.import({
            snapshot,
            idempotencyKey: flag("key") ?? `import:${snapshot.customer.id}`,
            dryRun: !args.includes("--apply"),
          }),
        );
        break;
      }
      default:
        return yield* fail(new Error(`Unknown command: ${command}`));
    }
  });
}
runPromise(main()).catch((error) => {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
});
