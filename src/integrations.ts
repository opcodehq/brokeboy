import { external, integration, runPromise } from "./core/effect.js";
import type {
  EffectHooks,
  EffectPaymentProvider,
  EffectResourceRegistry,
} from "./core/services.js";
import type { Hooks, PaymentProvider, ResourceRegistry } from "./core/types.js";

const providers = new WeakMap<
  PaymentProvider,
  { native: EffectPaymentProvider; original: PaymentProvider }
>();
export const promiseRegistry = (
  registry: EffectResourceRegistry,
): ResourceRegistry => ({
  getOrCreate: (key, create) =>
    runPromise(registry.getOrCreate(key, (id) => external(() => create(id)))),
});
export const effectRegistry = (
  registry: ResourceRegistry,
): EffectResourceRegistry => ({
  getOrCreate: (key, create) =>
    external(() => registry.getOrCreate(key, (id) => runPromise(create(id)))),
});
export function effectProvider(
  provider: PaymentProvider,
): EffectPaymentProvider {
  const known = providers.get(provider);
  if (
    known &&
    (["execute", "verify", "reconcile", "verifyResource"] as const).every(
      (key) => known.original[key] === provider[key],
    )
  )
    return known.native;
  return {
    execute: (command) =>
      external(() =>
        provider.execute({
          ...command,
          resources: command.resources
            ? promiseRegistry(command.resources)
            : undefined,
        }),
      ),
    verify: (request) => external(() => provider.verify(request)),
    reconcile: (event) => external(() => provider.reconcile(event)),
    ...(provider.verifyResource
      ? {
          verifyResource: (key: string, id: string) =>
            external(() => provider.verifyResource!(key, id)),
        }
      : {}),
  };
}
export function promiseProvider(
  provider: EffectPaymentProvider,
): PaymentProvider {
  const facade: PaymentProvider = {
    execute: (command) =>
      runPromise(
        provider.execute({
          ...command,
          resources: command.resources
            ? effectRegistry(command.resources)
            : undefined,
        }),
      ),
    verify: (request) => runPromise(provider.verify(request)),
    reconcile: (event) => runPromise(provider.reconcile(event)),
    ...(provider.verifyResource
      ? {
          verifyResource: (key: string, id: string) =>
            runPromise(provider.verifyResource!(key, id)),
        }
      : {}),
  };
  providers.set(facade, { native: provider, original: { ...facade } });
  return facade;
}
export const effectHooks = (hooks?: Hooks): EffectHooks | undefined =>
  hooks?.onEvent
    ? {
        onEvent: (event) => integration(() => hooks.onEvent!(event)),
      }
    : undefined;
