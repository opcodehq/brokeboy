import type { Customer } from "../generated/models.js";

export type * from "../generated/models.js";
export interface ResourceRegistry {
  getOrCreate(
    key: string,
    create: (idempotencyKey: string) => Promise<string>,
  ): Promise<string>;
}
export type PaymentCommand = {
  resources?: ResourceRegistry;
  id: string;
  kind: string;
  customer: Customer;
  input: Record<string, unknown>;
};
export type ProviderEvent = {
  id: string;
  type: string;
  customerId: string;
  data: Record<string, unknown>;
};
export interface PaymentProvider {
  verifyResource?(key: string, id: string): Promise<void>;
  execute(command: PaymentCommand): Promise<unknown>;
  verify(request: Request): Promise<ProviderEvent | null>;
  reconcile(event: ProviderEvent): Promise<ProviderEvent>;
}
export type Hooks = {
  onEvent?: (event: {
    id: string;
    type: string;
    customerId: string;
    data: unknown;
  }) => Promise<void>;
};
