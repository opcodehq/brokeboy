// Dedicated compatibility fixture; never point this at an application database.
import { Database } from "bun:sqlite";
import { drizzleAdapter } from "../src/drizzle.js";
import { brokeboy } from "../src/index.js";

const [path, customerId, mode, key] = process.argv.slice(2);
if (!path || !customerId)
  throw new Error("Fixture database and customer are required");
const db = new Database(path);
const billing = brokeboy({
  database: drizzleAdapter(
    { $client: db },
    { dialect: "sqlite", busyTimeout: 30000 },
  ),
});
try {
  if (mode === "replay") {
    const receipt = await billing.usage.consume({
      customerId,
      feature: "budget",
      amount: "1.00",
      idempotencyKey: key!,
    });
    console.log(JSON.stringify(receipt));
  } else {
    let successes = 0;
    let first: unknown;
    for (let i = 0; i < 100; i++) {
      try {
        const receipt = await billing.usage.consume({
          customerId,
          feature: "budget",
          amount: "1.00",
          idempotencyKey: `legacy-${i}`,
        });
        successes++;
        first ??= receipt;
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "insufficient_balance"
          )
        )
          throw error;
      }
      if (i === 0) console.log("ready");
      await Bun.sleep(1);
    }
    console.log(JSON.stringify({ successes, first }));
  }
} finally {
  db.close();
}
