import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import Stripe from "stripe";
import { drizzleAdapter } from "../../src/drizzle.js";
import { brokeboy } from "../../src/index.js";
import { stripeProvider } from "../../src/stripe.js";
export const db = drizzle(
  new Pool({ connectionString: process.env.BILLING_DATABASE_URL }),
);
export const billing = brokeboy({
  database: drizzleAdapter(db, { dialect: "postgres" }),
  provider: stripeProvider({
    client: new Stripe(process.env.STRIPE_SECRET_KEY!),
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  }),
});
