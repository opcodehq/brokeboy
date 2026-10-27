import { hash } from "../core/catalog.js";
import { assert, BillingError } from "../core/errors.js";
import type { ResourceRegistry } from "../core/types.js";
import { put, type Storage } from "./contract.js";

export type Resource = {
  id?: string;
  key?: string;
  resolution?: string;
  startedAt: number;
  owner: string;
  leaseUntil: number;
};
export interface ResourceManager extends ResourceRegistry {
  inspect(key: string): Promise<Resource | null>;
  resolve(key: string, id: string, reason: string): Promise<Resource>;
}
/** Durable mappings outlive the provider's short-lived request idempotency cache. */
export function resourceRegistry(
  storage: Storage,
  environment: string,
  now: () => number,
): ResourceManager {
  const scopeFor = async (key: string) =>
    `${environment}:r:${await hash({ environment, key })}`;
  return {
    async inspect(key) {
      return storage.read(
        await scopeFor(key),
        async (tx) =>
          (await tx.get<Resource>("resources", "mapping"))?.data ?? null,
      );
    },
    async resolve(key, id, reason) {
      assert(
        reason.trim().length > 0 && reason.length <= 500,
        "reason_required",
      );
      return storage.atomic(await scopeFor(key), async (tx) => {
        const old = (await tx.get<Resource>("resources", "mapping"))?.data;
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
        await put(tx, "resources", "mapping", next, "ready");
        return next;
      });
    },
    async getOrCreate(key, create) {
      const digest = await hash({ environment, key }),
        scope = `${environment}:r:${digest}`,
        owner = crypto.randomUUID();
      for (let attempt = 0; attempt < 100; attempt++) {
        const resource = await storage.atomic(scope, async (tx) => {
          const old = (await tx.get<Resource>("resources", "mapping"))?.data;
          if (old?.id) return old;
          if (old && now() - old.startedAt > 23 * 60 * 60_000)
            throw new BillingError(
              "reconciliation_required",
              "An ambiguous resource creation requires reconciliation before another attempt.",
              { resourceKey: key },
            );
          if (old && old.leaseUntil > now()) return null;
          const next: Resource = {
            key,
            startedAt: old?.startedAt ?? now(),
            owner,
            leaseUntil: now() + 120_000,
          };
          await put(tx, "resources", "mapping", next, "creating");
          return next;
        });
        if (resource?.id) return resource.id;
        if (!resource) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min((attempt + 1) * 10, 200)),
          );
          continue;
        }
        try {
          const id = await create(`bb:resource:${digest}`);
          await storage.atomic(scope, async (tx) => {
            const current = (await tx.get<Resource>("resources", "mapping"))
              ?.data;
            if (current?.owner !== owner) throw new BillingError("lease_lost");
            await put(
              tx,
              "resources",
              "mapping",
              { ...current, id, leaseUntil: 0 },
              "ready",
            );
          });
          return id;
        } catch (error) {
          await storage.atomic(scope, async (tx) => {
            const current = (await tx.get<Resource>("resources", "mapping"))
              ?.data;
            if (current?.owner === owner)
              await put(
                tx,
                "resources",
                "mapping",
                { ...current, leaseUntil: 0 },
                "creating",
              );
          });
          throw error;
        }
      }
      throw new BillingError(
        "resource_creation_in_progress",
        "Retry the operation with the same idempotency key.",
      );
    },
  };
}
