import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sync } from "./core/effect.js";
import { type BillingOptions, EffectBilling } from "./core/engine.js";
import type { EffectStorage } from "./storage/effect.js";

export class BillingStorage extends Context.Service<
  BillingStorage,
  EffectStorage
>()("brokeboy/Storage") {}
export const BillingConfig = Context.Reference<
  Omit<BillingOptions, "database" | "now">
>("brokeboy/Config", { defaultValue: () => ({}) });
export class BillingService extends Context.Service<
  BillingService,
  EffectBilling
>()("brokeboy/Billing") {}
export const make = Effect.gen(function* () {
  const database = yield* BillingStorage;
  const config = yield* BillingConfig;
  const clock = yield* Clock.Clock;
  return yield* sync(
    () =>
      new EffectBilling({
        ...config,
        database,
        now: () => clock.currentTimeMillisUnsafe(),
      }),
  );
});
export const billingLayer = Layer.effect(BillingService, make);
export type BillingLayerOptions = Omit<BillingOptions, "now">;
export const layer = (options: BillingLayerOptions) =>
  billingLayer.pipe(
    Layer.provide(Layer.succeed(BillingStorage, options.database)),
    Layer.provide(Layer.succeed(BillingConfig, options)),
  );
export type { BillingEffect, BillingFailure } from "./core/effect.js";
export {
  IntegrationError,
  ProviderError,
  StorageError,
} from "./core/effect.js";
export type { BillingOptions as EffectBillingOptions } from "./core/engine.js";
export { EffectBilling } from "./core/engine.js";
export { BillingError } from "./core/errors.js";
export type {
  EffectHooks,
  EffectPaymentCommand,
  EffectPaymentProvider,
  EffectResourceRegistry,
} from "./core/services.js";
export type { EffectStorage, EffectTransaction } from "./storage/effect.js";
