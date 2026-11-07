// Generated from brokeboy-core::models. Do not edit by hand.
export type Decimal = string;
export type Metadata = Record<string, string>;
export type JsonValue =
  | number
  | string
  | boolean
  | Array<JsonValue>
  | { [key in string]: JsonValue }
  | null;
export type Dialect = "postgres" | "mysql" | "sqlite";
export type DatabaseConnection = {
  driver: Dialect;
  url: string;
  maxConnections?: number;
  acquireTimeoutMs?: number;
};
export type StripeConnection = {
  secretKey: string;
  webhookSecret?: string;
  apiBase?: string;
};
export type OpenConfig = {
  database: DatabaseConnection;
  environment?: Environment;
  stripe?: StripeConnection;
};
export type Environment = "test" | "live";
export type FeatureKind = "boolean" | "consumable" | "quantity";
export type TierMode = "graduated" | "volume";
export type Interval = "month" | "year";
export type Reset = "month" | "year" | "never";
export type PoolScope = "customer" | "entity";
export type PlanKind = "subscription" | "one_time" | "free";
export type SubscriptionStatus =
  | "pending"
  | "active"
  | "trialing"
  | "past_due"
  | "paused"
  | "ended";
export type GrantOrigin =
  | "manual"
  | "subscription"
  | "purchase"
  | "rollover"
  | "import";
export type ReservationStatus = "held" | "settled" | "released" | "expired";
export type WorkStatus =
  | "pending"
  | "processing"
  | "done"
  | "failed"
  | "reconciliation";
export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "reconciliation";
export type WorkflowStatus =
  | "active"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "reconciliation";
export type Feature = { id: string; kind: FeatureKind };
export type Tier = { upTo: string | null; amount: string; flat?: string };
export type Dimension = { match: { [key in string]: string }; amount: string };
export type Rate = {
  amount?: string;
  tiers?: Array<Tier>;
  mode?: TierMode;
  dimensions?: Array<Dimension>;
};
export type Rollover = { maximum: string; periods: number };
export type PlanItem = {
  feature: string;
  kind?: FeatureKind;
  included?: string;
  enabled?: boolean;
  pool?: string;
  poolScope?: PoolScope;
  rate?: Rate;
  overage?: boolean;
  reset?: Reset;
  rollover?: Rollover;
};
export type Plan = {
  id: string;
  name: string;
  items: Array<PlanItem>;
  public?: boolean;
  addOn?: boolean;
  group?: string;
  currency?: string;
  amount?: string;
  interval?: Interval;
  kind?: PlanKind;
  trialDays?: number;
  trialIncluded?: { [key in string]: string };
  graceDays?: number;
  graceIncluded?: { [key in string]: string };
  stripePriceId?: string;
  stripeMeterPriceIds?: { [key in string]: string };
  seatPriceId?: string;
};
export type Catalog = { features: Array<Feature>; plans: Array<Plan> };
export type PublishedPlan = {
  version: string;
  revision: number;
  id: string;
  name: string;
  items: Array<PlanItem>;
  public?: boolean;
  addOn?: boolean;
  group?: string;
  currency?: string;
  amount?: string;
  interval?: Interval;
  kind?: PlanKind;
  trialDays?: number;
  trialIncluded?: { [key in string]: string };
  graceDays?: number;
  graceIncluded?: { [key in string]: string };
  stripePriceId?: string;
  stripeMeterPriceIds?: { [key in string]: string };
  seatPriceId?: string;
};
export type Alert = { feature: string; remaining: string };
export type AutoTopUp = {
  feature: string;
  below: string;
  packPlan: string;
  maximumPurchases: number;
};
export type Controls = {
  overageLimits?: { [key in string]: string };
  alerts?: Array<Alert>;
  autoTopUp?: AutoTopUp;
};
export type Customer = {
  id: string;
  metadata: { [key in string]: string };
  controls: Controls;
  stripeCustomerId?: string;
};
export type Entity = { id: string; metadata: { [key in string]: string } };
export type ProvisioningOffset = {
  until: number;
  granted: { [key in string]: string };
};
export type ScheduledPlan = { plan: PublishedPlan; start: number; end: number };
export type Subscription = {
  id: string;
  plan: PublishedPlan;
  status: SubscriptionStatus;
  periodStart: number;
  periodEnd: number;
  paidThrough: number;
  quantity: string;
  entityId?: string;
  graceThrough?: number;
  stripeSubscriptionId?: string;
  purchaseId?: string;
  cancelAtPeriodEnd?: boolean;
  provisioningOffset?: ProvisioningOffset;
  nextPlan?: PublishedPlan;
  scheduledPlans?: Array<ScheduledPlan>;
};
export type Grant = {
  id: string;
  feature: string;
  amount: string;
  priority: number;
  origin: GrantOrigin;
  sourceId: string;
  createdAt: number;
  entityId?: string;
  expiresAt?: number;
};
export type Movement = {
  id: string;
  grantId: string;
  amount: string;
  operationId: string;
  createdAt: number;
  reason: string;
  reverses?: string;
};
export type Allocation = { grantId: string; amount: string };
export type Reservation = {
  id: string;
  feature: string;
  amount: string;
  allocations: Array<Allocation>;
  expiresAt: number;
  status: ReservationStatus;
  entityId?: string;
  poolScope?: PoolScope;
};
export type Usage = {
  id: string;
  feature: string;
  quantity: string;
  charged: string;
  allocations: Array<Allocation>;
  createdAt: number;
  properties: { [key in string]: string };
  entityId?: string;
  currency?: string;
  planVersion?: string;
  reverses?: string;
};
export type Balance = {
  feature: string;
  granted: string;
  spent: string;
  reserved: string;
  available: string;
};
export type Work = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: WorkStatus;
  attempts: number;
  availableAt: number;
  createdAt: number;
  leaseUntil?: number;
  leaseOwner?: string;
  result?: unknown;
  error?: string;
  details?: unknown;
};
export type ScopeInput = { customerId: string; entityId?: string };
export type WriteInput = {
  customerId: string;
  idempotencyKey: string;
  entityId?: string;
};
export type UsageInput = {
  customerId: string;
  idempotencyKey: string;
  feature: string;
  amount: string;
  entityId?: string;
  properties?: { [key in string]: string };
};
export type Budget = { feature: string; amount: string; poolScope?: PoolScope };
export type WorkflowStepDefinition = {
  id: string;
  budgets: Array<Budget>;
  dependsOn?: Array<string>;
  maxAttempts?: number;
};
export type ReservationRef = { feature: string; reservationId: string };
export type Lease = { token: string; workerId: string; until: number };
export type WorkflowStep = {
  status: StepStatus;
  attempts: number;
  availableAt: number;
  reservations: Array<ReservationRef>;
  lease?: Lease;
  result?: JsonValue;
  usageIds?: Array<string>;
  error?: string;
  reportedActuals?: { [key in string]: string };
  id: string;
  budgets: Array<Budget>;
  dependsOn?: Array<string>;
  maxAttempts?: number;
};
export type Workflow = {
  id: string;
  status: WorkflowStatus;
  revision: number;
  createdAt: number;
  expiresAt: number;
  steps: Array<WorkflowStep>;
  entityId?: string;
  cancellationRequested?: boolean;
};
