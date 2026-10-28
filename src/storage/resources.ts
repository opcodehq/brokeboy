import * as Effect from "effect/Effect";
import { hash } from "../core/catalog.js";
import {
  type BillingEffect,
  external,
  fail,
  recover,
  runPromise,
  task,
} from "../core/effect.js";
import { assert, BillingError } from "../core/errors.js";
import type { EffectResourceRegistry as ResourceRegistry } from "../core/services.js";
import { effectStorage } from "./bridge.js";
import { put, type Storage } from "./native.js";
export type Resource = {
  id?: string;
  key?: string;
  resolution?: string;
  startedAt: number;
  owner: string;
  leaseUntil: number;
};
export interface ResourceManager extends ResourceRegistry {
  inspect(key: string): BillingEffect<Resource | null>;
  resolve(key: string, id: string, reason: string): BillingEffect<Resource>;
}
/** Durable mappings outlive the provider's short-lived request idempotency cache. */
export function effectResourceRegistry(
  storage: Storage,
  environment: string,
  now: () => number,
): ResourceManager {
  const scopeFor = (key: string) => {
    return task(function* () {
      return `${environment}:r:${yield* hash({ environment, key })}`;
    });
  };
  return {
    inspect(key) {
      return task(function* () {
        return yield* storage.read(yield* scopeFor(key), (tx) => {
          return task(function* () {
            return (
              (yield* tx.get<Resource>("resources", "mapping"))?.data ?? null
            );
          });
        });
      });
    },
    resolve(key, id, reason) {
      return task(function* () {
        assert(
          reason.trim().length > 0 && reason.length <= 500,
          "reason_required",
        );
        return yield* storage.atomic(yield* scopeFor(key), (tx) => {
          return task(function* () {
            const old = (yield* tx.get<Resource>("resources", "mapping"))?.data;
            assert(old, "resource_not_found");
            assert(
              old.id === undefined || old.id === id,
              "resource_mapping_conflict",
            );
            assert(
              old.id || old.leaseUntil <= now(),
              "resource_creation_in_progress",
            );
            const next = { ...old, key, id, resolution: reason, leaseUntil: 0 };
            yield* put(tx, "resources", "mapping", next, "ready");
            return next;
          });
        });
      });
    },
    getOrCreate(key, create) {
      return task(function* () {
        const digest = yield* hash({ environment, key }),
          scope = `${environment}:r:${digest}`,
          owner = crypto.randomUUID();
        for (let attempt = 0; attempt < 100; attempt++) {
          const resource = yield* storage.atomic(scope, (tx) => {
            return task(function* () {
              const old = (yield* tx.get<Resource>("resources", "mapping"))
                ?.data;
              if (old?.id) return old;
              if (old && now() - old.startedAt > 23 * 60 * 60000)
                return yield* fail(
                  new BillingError(
                    "reconciliation_required",
                    "An ambiguous resource creation requires reconciliation before another attempt.",
                    { resourceKey: key },
                  ),
                );
              if (old && old.leaseUntil > now()) return null;
              const next: Resource = {
                key,
                startedAt: old?.startedAt ?? now(),
                owner,
                leaseUntil: now() + 120000,
              };
              yield* put(tx, "resources", "mapping", next, "creating");
              return next;
            });
          });
          if (resource?.id) return resource.id;
          if (!resource) {
            yield* Effect.sleep(Math.min((attempt + 1) * 10, 200));
            continue;
          }
          return yield* recover(
            task(function* () {
              const id = yield* create(`bb:resource:${digest}`);
              yield* storage.atomic(scope, (tx) => {
                return task(function* () {
                  const current = (yield* tx.get<Resource>(
                    "resources",
                    "mapping",
                  ))?.data;
                  if (current?.owner !== owner)
                    return yield* fail(new BillingError("lease_lost"));
                  yield* put(
                    tx,
                    "resources",
                    "mapping",
                    { ...current, id, leaseUntil: 0 },
                    "ready",
                  );
                });
              });
              return id;
            }),
            (error) =>
              task(function* () {
                yield* storage.atomic(scope, (tx) => {
                  return task(function* () {
                    const current = (yield* tx.get<Resource>(
                      "resources",
                      "mapping",
                    ))?.data;
                    if (current?.owner === owner)
                      yield* put(
                        tx,
                        "resources",
                        "mapping",
                        { ...current, leaseUntil: 0 },
                        "creating",
                      );
                  });
                });
                return yield* fail(error);
              }),
          );
        }
        return yield* fail(
          new BillingError(
            "resource_creation_in_progress",
            "Retry the operation with the same idempotency key.",
          ),
        );
      });
    },
  };
}
export function resourceRegistry(
  storage: import("./contract.js").Storage,
  environment: string,
  now: () => number,
) {
  const native = effectResourceRegistry(
    effectStorage(storage),
    environment,
    now,
  );
  return {
    inspect: (key: string) => runPromise(native.inspect(key)),
    resolve: (key: string, id: string, reason: string) =>
      runPromise(native.resolve(key, id, reason)),
    getOrCreate: (key: string, create: (id: string) => Promise<string>) =>
      runPromise(native.getOrCreate(key, (id) => external(() => create(id)))),
  };
}
