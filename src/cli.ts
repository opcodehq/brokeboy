#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";
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
async function main() {
  if (!command || command === "help" || command === "--help") {
    output(
      "brokeboy init | schema --dialect postgres|mysql|sqlite|d1 [--sql] | doctor | catalog diff|apply|export | customer <id> | workflows <customerId> [workflowId] [--entity id] | reconcile <id> | maintenance | export <id> | import <snapshot.json> [--apply]\nUse --config ./billing.config.ts. Config exports billing and optional catalog, expectedRevision.",
    );
    return;
  }
  if (command === "init") {
    await writeFile(
      resolve("billing.config.ts"),
      'import { brokeboy, defineCatalog } from "brokeboy";\nimport { drizzleAdapter } from "brokeboy/drizzle";\nimport { db } from "./db";\n\nexport const catalog = defineCatalog({ features: [], plans: [] });\nexport const expectedRevision = 0;\nexport const billing = brokeboy({ database: drizzleAdapter(db, { dialect: "postgres" }), environment: "test" });\n',
      { flag: "wx" },
    );
    output(
      "Created billing.config.ts. Connect your database, export billing schemas, apply migrations, and add your Stripe provider. No database or payment resources were modified.",
    );
    return;
  }
  if (command === "schema") {
    const dialect = flag("dialect") as Dialect;
    if (!["postgres", "mysql", "sqlite", "d1"].includes(dialect))
      throw new Error("Choose --dialect postgres|mysql|sqlite|d1.");
    output(
      args.includes("--sql")
        ? `${migrationSQL(dialect).join(";\n")};`
        : `export * from "brokeboy/schema/${dialect === "d1" ? "sqlite" : dialect}";`,
    );
    return;
  }
  const jiti = createJiti(import.meta.url);
  const config = await jiti.import<{
    billing: Billing;
    catalog?: unknown;
    expectedRevision?: number;
  }>(resolve(flag("config") ?? "billing.config.ts"));
  const billing = config.billing;
  if (!billing) throw new Error("Config must export billing.");
  const positionals = args.filter(
    (_, index) =>
      !args[index]?.startsWith("--") &&
      (index === 0 || !args[index - 1]?.startsWith("--")),
  );
  switch (command) {
    case "doctor": {
      const catalog = await billing.catalog.export();
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
        output(await billing.catalog.export());
        break;
      }
      if (!config.catalog) throw new Error("Config must export catalog.");
      if (action === "diff")
        output(
          await billing.catalog.diff(
            config.catalog as Parameters<Billing["catalog"]["diff"]>[0],
          ),
        );
      else if (action === "apply") {
        if (!args.includes("--yes"))
          throw new Error(
            "Review catalog diff, then supply --yes and an explicit expectedRevision in config.",
          );
        if (config.expectedRevision === undefined)
          throw new Error("Config must specify expectedRevision.");
        output(
          await billing.catalog.publish({
            catalog: config.catalog as Parameters<
              Billing["catalog"]["diff"]
            >[0],
            expectedRevision: config.expectedRevision,
          }),
        );
      } else throw new Error("Choose catalog diff|apply|export.");
      break;
    }
    case "workflows": {
      const customerId = positionals[0] ?? "";
      const workflowId = positionals[1];
      output(
        workflowId
          ? await billing.workflows.get({
              customerId,
              workflowId,
              entityId: flag("entity"),
            })
          : await billing.workflows.page({
              customerId,
              entityId: flag("entity"),
              cursor: flag("cursor"),
            }),
      );
      break;
    }
    case "customer":
      output(await billing.customers.get(positionals[0] ?? ""));
      break;
    case "reconcile":
      output(await billing.credits.reconcile(positionals[0] ?? ""));
      break;
    case "maintenance":
      output(
        await billing.maintenance.run({ limit: Number(flag("limit") ?? 100) }),
      );
      break;
    case "export":
      output(await billing.migration.export(positionals[0] ?? ""));
      break;
    case "import": {
      const snapshot = JSON.parse(
        await readFile(resolve(positionals[0] ?? ""), "utf8"),
      );
      output(
        await billing.migration.import({
          snapshot,
          idempotencyKey: flag("key") ?? `import:${snapshot.customer.id}`,
          dryRun: !args.includes("--apply"),
        }),
      );
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
});
