import * as Effect from "effect/Effect";
import {
  IntegrationError,
  ProviderError,
  StorageError,
} from "./core/effect.js";
import type { EffectBilling } from "./core/engine.js";
import { BillingError } from "./core/errors.js";
import { type NativeTransport, nativeGroups } from "./native-bridge.js";
export function nativeFailure(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const message = error instanceof Error ? error.message : error.code;
    if (error.code === "storage_error")
      return new StorageError({ message, cause: error });
    if (error.code === "provider_error")
      return new ProviderError({ message, cause: error });
    return new BillingError(
      error.code,
      message,
      "details" in error ? error.details : undefined,
    );
  }
  return new IntegrationError({
    message: "Native billing integration failed.",
    cause: error,
  });
}
export function nativeEffects(transport: NativeTransport): EffectBilling {
  const result: Record<string, unknown> = {
    environment: transport.environment,
    webhook: (request: Request) =>
      Effect.tryPromise({
        try: (signal) => transport.webhook(request, signal),
        catch: nativeFailure,
      }),
  };
  for (const group of nativeGroups) {
    const cache = new Map<string, unknown>();
    result[group] = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (typeof key !== "string") return undefined;
          if (!cache.has(key))
            cache.set(
              key,
              group === "catalog" && key === "validate"
                ? (catalog: unknown) => transport.validate(catalog)
                : (...args: unknown[]) =>
                    Effect.tryPromise({
                      try: (signal) =>
                        transport.invoke(`${group}.${key}`, args, signal),
                      catch: nativeFailure,
                    }),
            );
          return cache.get(key);
        },
      },
    );
  }
  return result as unknown as EffectBilling;
}
