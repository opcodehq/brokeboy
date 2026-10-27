import type {
  D1Database,
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import Stripe from "stripe";
import { drizzleAdapter } from "../../src/drizzle.js";
import { brokeboy } from "../../src/index.js";
import { toHandler } from "../../src/server.js";
import { stripeProvider } from "../../src/stripe.js";

type Env = {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
};
function billingFor(env: Env) {
  return brokeboy({
    database: drizzleAdapter(drizzle(env.DB), { dialect: "d1" }),
    provider: stripeProvider({
      client: new Stripe(env.STRIPE_SECRET_KEY, {
        httpClient: Stripe.createFetchHttpClient(),
      }),
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      cryptoProvider: Stripe.createSubtleCryptoProvider(),
    }),
  });
}
export default {
  async fetch(request: Request, env: Env) {
    return toHandler({
      billing: billingFor(env),
      resolveCustomer: async () => null,
    })(request);
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _context: ExecutionContext,
  ) {
    await billingFor(env).maintenance.run({ limit: 100 });
  },
};
