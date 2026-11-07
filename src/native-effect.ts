import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { EffectBilling } from "./core/engine.js";
import { Billing, type BillingOptions } from "./native.js";
import { nativeTransport } from "./native-bridge.js";
import { nativeEffects, nativeFailure } from "./native-effect-bridge.js";
export class BillingService extends Context.Service<
  BillingService,
  EffectBilling
>()("brokeboy/NativeBilling") {}
export const make = (options: BillingOptions) =>
  Effect.map(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => Billing.open(options),
        catch: nativeFailure,
      }),
      (billing) =>
        Effect.orDie(
          Effect.tryPromise({
            try: () => billing.close(),
            catch: nativeFailure,
          }),
        ),
    ),
    (billing) => nativeEffects(billing[nativeTransport]),
  );
export const layer = (options: BillingOptions) =>
  Layer.effect(BillingService, make(options));
export { nativeFailure };
