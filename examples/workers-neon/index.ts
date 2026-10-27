import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { drizzleAdapter } from "../../src/drizzle.js";
import { brokeboy } from "../../src/index.js";
import { toHandler } from "../../src/server.js";

type Env = { BILLING_DATABASE_URL: string };
export default {
  async fetch(request: Request, env: Env) {
    const pool = new Pool({ connectionString: env.BILLING_DATABASE_URL });
    try {
      return await toHandler({
        billing: brokeboy({
          database: drizzleAdapter(drizzle(pool), { dialect: "postgres" }),
        }),
        resolveCustomer: async () => null,
      })(request);
    } finally {
      await pool.end();
    }
  },
  async scheduled(_controller: unknown, env: Env) {
    const pool = new Pool({ connectionString: env.BILLING_DATABASE_URL });
    try {
      await brokeboy({
        database: drizzleAdapter(drizzle(pool), { dialect: "postgres" }),
      }).maintenance.run();
    } finally {
      await pool.end();
    }
  },
};
