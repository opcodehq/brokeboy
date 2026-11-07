import * as Effect from "effect/Effect";
import { effectBackend } from "./billing-bridge.js";
import { runPromise } from "./core/effect.js";
import { EffectBilling } from "./core/engine.js";
import type { Environment, Hooks, PaymentProvider } from "./core/types.js";
import { effectHooks, effectProvider } from "./integrations.js";

export { effectBilling } from "./billing-bridge.js";

import { effectStorage } from "./storage/bridge.js";
import type { Storage } from "./storage/contract.js";
export type BillingOptions = {
  database: Storage;
  environment?: Environment;
  provider?: PaymentProvider;
  now?: () => number;
  hooks?: Hooks;
};
export type PromiseSurface<T> = T extends (...args: infer P) => infer R
  ? (...args: P) => R extends Effect.Effect<infer A, any, any> ? Promise<A> : R
  : T extends object
    ? { [K in keyof T]: PromiseSurface<T[K]> }
    : T;
function surface<T extends object>(target: T): PromiseSurface<T> {
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(object, key) {
      if (cache.has(key)) return cache.get(key);
      const value = Reflect.get(object, key, object);
      const wrapped =
        typeof value === "function"
          ? (...args: unknown[]) => {
              const result = value.apply(object, args);
              return Effect.isEffect(result)
                ? runPromise(result as Effect.Effect<unknown, unknown>)
                : result;
            }
          : value !== null && typeof value === "object"
            ? surface(value)
            : value;
      cache.set(key, wrapped);
      return wrapped;
    },
  }) as PromiseSurface<T>;
}
export class Billing {
  readonly environment: Environment;
  readonly catalog: PromiseSurface<EffectBilling["catalog"]>;
  readonly customers: PromiseSurface<EffectBilling["customers"]>;
  readonly entities: PromiseSurface<EffectBilling["entities"]>;
  readonly credits: PromiseSurface<EffectBilling["credits"]>;
  readonly entitlements: PromiseSurface<EffectBilling["entitlements"]>;
  readonly usage: PromiseSurface<EffectBilling["usage"]>;
  readonly reservations: PromiseSurface<EffectBilling["reservations"]>;
  readonly billingControls: PromiseSurface<EffectBilling["billingControls"]>;
  readonly subscriptions: PromiseSurface<EffectBilling["subscriptions"]>;
  readonly commerce: PromiseSurface<EffectBilling["commerce"]>;
  readonly licenses: PromiseSurface<EffectBilling["licenses"]>;
  readonly operations: PromiseSurface<EffectBilling["operations"]>;
  readonly events: PromiseSurface<EffectBilling["events"]>;
  readonly webhook: PromiseSurface<EffectBilling["webhook"]>;
  readonly maintenance: PromiseSurface<EffectBilling["maintenance"]>;
  readonly migration: PromiseSurface<EffectBilling["migration"]>;
  readonly resources: PromiseSurface<EffectBilling["resources"]>;
  readonly workflows: PromiseSurface<EffectBilling["workflows"]>;
  constructor(options: BillingOptions) {
    const native = new EffectBilling({
      ...options,
      database: effectStorage(options.database),
      provider: options.provider ? effectProvider(options.provider) : undefined,
      hooks: effectHooks(options.hooks),
    });
    Object.defineProperty(this, effectBackend, { value: native });
    const api = surface(native);
    this.environment = native.environment;
    this.catalog = api.catalog;
    this.customers = api.customers;
    this.entities = api.entities;
    this.credits = api.credits;
    this.entitlements = api.entitlements;
    this.usage = api.usage;
    this.reservations = api.reservations;
    this.billingControls = api.billingControls;
    this.subscriptions = api.subscriptions;
    this.commerce = api.commerce;
    this.licenses = api.licenses;
    this.operations = api.operations;
    this.events = api.events;
    this.webhook = api.webhook;
    this.maintenance = api.maintenance;
    this.migration = api.migration;
    this.resources = api.resources;
    this.workflows = api.workflows;
  }
}
export const brokeboy = (options: BillingOptions) => new Billing(options);
