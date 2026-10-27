export type Decimal = string;
export type Environment = "test" | "live";
export type Metadata = Record<string, string>;
export type Feature = {
  id: string;
  kind: "boolean" | "consumable" | "quantity";
};
export type Tier = { upTo: Decimal | null; amount: Decimal; flat?: Decimal };
export type Rate = {
  amount?: Decimal;
  tiers?: Tier[];
  mode?: "graduated" | "volume";
  dimensions?: { match: Metadata; amount: Decimal }[];
};
export type PlanItem = {
  kind?: Feature["kind"];
  feature: string;
  included?: Decimal;
  enabled?: boolean;
  pool?: string;
  poolScope?: "customer" | "entity";
  rate?: Rate;
  overage?: boolean;
  reset?: "month" | "year" | "never";
  rollover?: { maximum: Decimal; periods: number };
};
export type Plan = {
  public?: boolean;
  addOn?: boolean;
  group?: string;
  id: string;
  name: string;
  currency?: string;
  amount?: Decimal;
  interval?: "month" | "year";
  kind?: "subscription" | "one_time" | "free";
  trialDays?: number;
  trialIncluded?: Record<string, Decimal>;
  graceDays?: number;
  graceIncluded?: Record<string, Decimal>;
  items: PlanItem[];
  stripePriceId?: string;
  stripeMeterPriceIds?: Record<string, string>;
  seatPriceId?: string;
};
export type Catalog = { features: Feature[]; plans: Plan[] };
export type PublishedPlan = Plan & { version: string; revision: number };
export type Customer = {
  id: string;
  metadata: Metadata;
  stripeCustomerId?: string;
  controls: Controls;
};
export type Controls = {
  overageLimits?: Record<string, Decimal>;
  alerts?: { feature: string; remaining: Decimal }[];
  autoTopUp?: {
    feature: string;
    below: Decimal;
    packPlan: string;
    maximumPurchases: number;
  };
};
export type Entity = { id: string; metadata: Metadata };
export type Subscription = {
  id: string;
  entityId?: string;
  plan: PublishedPlan;
  status: "pending" | "active" | "trialing" | "past_due" | "paused" | "ended";
  periodStart: number;
  periodEnd: number;
  paidThrough: number;
  graceThrough?: number;
  stripeSubscriptionId?: string;
  purchaseId?: string;
  quantity: Decimal;
  cancelAtPeriodEnd?: boolean;
  provisioningOffset?: { until: number; granted: Record<string, string> };
  nextPlan?: PublishedPlan;
  scheduledPlans?: { plan: PublishedPlan; start: number; end: number }[];
};
export type Grant = {
  id: string;
  feature: string;
  entityId?: string;
  amount: Decimal;
  expiresAt?: number;
  priority: number;
  origin: "manual" | "subscription" | "purchase" | "rollover" | "import";
  sourceId: string;
  createdAt: number;
};
export type Movement = {
  id: string;
  grantId: string;
  amount: Decimal;
  operationId: string;
  createdAt: number;
  reason: string;
  reverses?: string;
};
export type Allocation = { grantId: string; amount: Decimal };
export type Reservation = {
  id: string;
  feature: string;
  entityId?: string;
  amount: Decimal;
  allocations: Allocation[];
  poolScope?: "customer" | "entity";
  expiresAt: number;
  status: "held" | "settled" | "released" | "expired";
};
export type Usage = {
  id: string;
  feature: string;
  entityId?: string;
  quantity: Decimal;
  charged: Decimal;
  currency?: string;
  planVersion?: string;
  allocations: Allocation[];
  createdAt: number;
  properties: Metadata;
  reverses?: string;
};
export type Balance = {
  feature: string;
  granted: Decimal;
  spent: Decimal;
  reserved: Decimal;
  available: Decimal;
};
export type Work = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "done" | "failed" | "reconciliation";
  attempts: number;
  availableAt: number;
  leaseUntil?: number;
  leaseOwner?: string;
  createdAt: number;
  result?: unknown;
  error?: string;
  details?: unknown;
};
export type ScopeInput = { customerId: string; entityId?: string };
export type WriteInput = ScopeInput & { idempotencyKey: string };
export type UsageInput = WriteInput & {
  feature: string;
  amount: Decimal;
  properties?: Metadata;
};
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
