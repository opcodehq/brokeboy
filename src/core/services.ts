import type { BillingEffect } from "./effect.js";
import type { Customer, ProviderEvent } from "./types.js";
export interface EffectResourceRegistry {
  getOrCreate(
    key: string,
    create: (idempotencyKey: string) => BillingEffect<string>,
  ): BillingEffect<string>;
}
export type EffectPaymentCommand = {
  resources?: EffectResourceRegistry;
  id: string;
  kind: string;
  customer: Customer;
  input: Record<string, unknown>;
};
export interface EffectPaymentProvider {
  verifyResource?(key: string, id: string): BillingEffect<void>;
  execute(command: EffectPaymentCommand): BillingEffect<unknown>;
  verify(request: Request): BillingEffect<ProviderEvent | null>;
  reconcile(event: ProviderEvent): BillingEffect<ProviderEvent>;
}
export type EffectHooks = {
  onEvent?: (event: {
    id: string;
    type: string;
    customerId: string;
    data: unknown;
  }) => BillingEffect<void>;
};
