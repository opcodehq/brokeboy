import type { Billing } from "./billing.js";
import type { EffectBilling } from "./core/engine.js";
import { type NativeTransport, nativeTransport } from "./native-bridge.js";
import { nativeEffects } from "./native-effect-bridge.js";

export const effectBackend = Symbol.for("@brokeboy/effect/backend");
// Transport adaptation has no dependency on either billing implementation.
export function effectBilling(billing: Billing | EffectBilling): EffectBilling {
  const transport = Reflect.get(billing, nativeTransport) as
    | NativeTransport
    | undefined;
  if (transport) return nativeEffects(transport);
  const backend = Reflect.get(billing, effectBackend) as
    | EffectBilling
    | undefined;
  if (!backend) throw new TypeError("Expected a Brokeboy billing instance");
  return backend;
}
