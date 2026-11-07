import { Billing, defineCatalog } from "../../src/native.js";

const url = process.env.BROKEBOY_DATABASE_URL;
if (!url)
  throw new Error(
    "Set BROKEBOY_DATABASE_URL to an existing migrated SQLite database.",
  );
const billing = await Billing.open({
  database: { driver: "sqlite", url },
  environment: "test",
});
try {
  const catalog = defineCatalog({
    features: [{ id: "requests", kind: "consumable" }],
    plans: [
      {
        id: "free",
        name: "Free",
        kind: "free",
        items: [{ feature: "requests", included: "10" }],
      },
    ],
  });
  const current = await billing.catalog.export();
  if (current.revision === 0)
    await billing.catalog.publish({ catalog, expectedRevision: 0 });
  await billing.customers.create({
    id: "native-example",
    idempotencyKey: "create",
  });
  await billing.subscriptions.attach({
    customerId: "native-example",
    planId: "free",
    idempotencyKey: "attach",
  });
  console.log(
    await billing.usage.consume({
      customerId: "native-example",
      feature: "requests",
      amount: "1.25",
      idempotencyKey: "request-1",
    }),
  );
} finally {
  await billing.close();
}
