import type { Billing, BillingOptions } from "../src/billing.js";
export type OpenBilling = (
  options: BillingOptions,
) => Billing | Promise<Billing>;
