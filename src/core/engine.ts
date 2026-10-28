import * as Effect from "effect/Effect";
import {
  put,
  type Row,
  type Storage,
  type Table,
  type Transaction,
} from "../storage/native.js";
import {
  effectResourceRegistry,
  type ResourceManager,
} from "../storage/resources.js";
import {
  addInterval,
  canonical,
  hash,
  normalizePlan,
  rateUsage,
  validateCatalog,
} from "./catalog.js";
import { decimal, minimum, nonnegative, positive, units } from "./decimal.js";
import { type BillingEffect, fail, recover, task } from "./effect.js";
import { assert, BillingError, identifier, timestamp } from "./errors.js";
import {
  allocationEntity,
  isEntitled,
  Ledger,
  registerFeatures,
} from "./ledger.js";
import type { EffectHooks, EffectPaymentProvider } from "./services.js";
import type {
  Allocation,
  Balance,
  Catalog,
  Controls,
  Customer,
  Entity,
  Environment,
  Grant,
  Metadata,
  Plan,
  PlanItem,
  ProviderEvent,
  PublishedPlan,
  Reservation,
  ScopeInput,
  Subscription,
  Usage,
  UsageInput,
  Work,
  WriteInput,
} from "./types.js";
import { returnUrl } from "./urls.js";
import { Workflows } from "./workflows.js";
export type BillingOptions = {
  database: Storage;
  environment?: Environment;
  provider?: EffectPaymentProvider;
  now?: () => number;
  hooks?: EffectHooks;
};
type SavedOperation = {
  hash: string;
  result: unknown;
  createdAt: number;
};
export function makeEffectBilling(options: BillingOptions) {
  return new EffectBilling(options);
}
export class EffectBilling {
  private readonly store: Storage;
  private readonly now: () => number;
  private readonly ledger: Ledger;
  private readonly resourceStore: ResourceManager;
  readonly environment: Environment;
  readonly workflows: Workflows;
  constructor(private readonly options: BillingOptions) {
    this.store = options.database;
    this.now = options.now ?? Date.now;
    this.ledger = new Ledger(this.now);
    this.environment = options.environment ?? "test";
    this.resourceStore = effectResourceRegistry(
      this.store,
      this.environment,
      this.now,
    );
    assert(["test", "live"].includes(this.environment), "invalid_environment");
    this.workflows = new Workflows({
      now: this.now,
      ledger: this.ledger,
      write: this.write.bind(this),
      read: (customerId, run) => this.store.read(this.scope(customerId), run),
      event: this.event.bind(this),
      enqueue: this.enqueue.bind(this),
      afterUsage: this.afterUsage.bind(this),
    });
  }
  private scope(customerId: string) {
    return `${this.environment}:c:${identifier(customerId)}`;
  }
  private catalogScope() {
    return `${this.environment}:catalog`;
  }
  private write<T>(
    input: WriteInput,
    method: string,
    payload: unknown,
    run: (tx: Transaction, operation: string) => BillingEffect<T>,
    create = false,
  ): BillingEffect<T> {
    return task({ self: this }, function* () {
      const digest = yield* hash({ method, payload });
      identifier(input.idempotencyKey);
      return yield* this.store.atomic(this.scope(input.customerId), (tx) => {
        return task({ self: this }, function* () {
          return yield* this.applyWrite(tx, input, digest, run, create);
        });
      });
    }).pipe(Effect.withSpan(`brokeboy.${method}`));
  }
  private applyWrite<T>(
    tx: Transaction,
    input: WriteInput,
    digest: string,
    run: (tx: Transaction, operation: string) => BillingEffect<T>,
    create = false,
  ): BillingEffect<T> {
    return task({ self: this }, function* () {
      const key = identifier(input.idempotencyKey);
      const previous = yield* tx.get<SavedOperation>("operations", key);
      if (previous) {
        assert(previous.data.hash === digest, "idempotency_conflict");
        return previous.data.result as T;
      }
      if (!create)
        assert(
          yield* tx.get("customers", input.customerId),
          "customer_not_found",
        );
      if (input.entityId)
        assert(
          yield* tx.get("entities", identifier(input.entityId)),
          "entity_not_found",
        );
      const result = JSON.parse(JSON.stringify(yield* run(tx, key))) as T;
      yield* put(tx, "operations", key, {
        hash: digest,
        result,
        createdAt: this.now(),
      });
      return result;
    });
  }
  private customer(tx: Transaction, id: string) {
    return task(function* () {
      const row = yield* tx.get<Customer>("customers", id);
      assert(row, "customer_not_found");
      return row.data;
    });
  }
  private event(
    tx: Transaction,
    customerId: string,
    type: string,
    data: unknown,
  ) {
    return task({ self: this }, function* () {
      const id = crypto.randomUUID();
      const event = {
        id,
        type,
        customerId,
        data,
        createdAt: this.now(),
      };
      yield* put(tx, "events", id, event);
      yield* put(tx, "audit", id, {
        id,
        type,
        customerId,
        createdAt: this.now(),
        data,
      });
      if (this.options.hooks?.onEvent)
        yield* this.enqueue(tx, `event:${id}`, "event", event);
    });
  }
  private enqueue(
    tx: Transaction,
    id: string,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    return task({ self: this }, function* () {
      if (yield* tx.get("work", id)) return;
      yield* put(
        tx,
        "work",
        id,
        {
          id,
          kind,
          payload,
          status: "pending",
          attempts: 0,
          availableAt: this.now(),
          createdAt: this.now(),
        } satisfies Work,
        "pending",
      );
    });
  }
  readonly resources = {
    inspect: (key: string) => this.resourceStore.inspect(key),
    reconcile: (input: { key: string; id: string; reason: string }) => {
      return task({ self: this }, function* () {
        assert(
          this.options.provider?.verifyResource,
          "resource_verification_required",
        );
        yield* this.options.provider.verifyResource(input.key, input.id);
        return yield* this.resourceStore.resolve(
          input.key,
          input.id,
          input.reason,
        );
      });
    },
  };
  readonly catalog = {
    validate: (catalog: Catalog) => validateCatalog(catalog),
    export: () => {
      return task({ self: this }, function* () {
        return yield* this.store.atomic(this.catalogScope(), (tx) => {
          return task(function* () {
            const versions = (yield* tx.list<PublishedPlan>(
              "catalog",
              "published",
            )).map((row) => row.data);
            const pointers = new Set(
              (yield* tx.list<{
                version: string;
              }>("catalog", "pointer")).map((row) => row.data.version),
            );
            return {
              revision:
                (yield* tx.get<{
                  revision: number;
                }>("catalog", "head"))?.data.revision ?? 0,
              features:
                (yield* tx.get<Catalog["features"]>("catalog", "features"))
                  ?.data ?? [],
              plans: versions.filter((plan) => pointers.has(plan.version)),
              versions,
            };
          });
        });
      });
    },
    diff: (catalog: Catalog) => {
      return task({ self: this }, function* () {
        validateCatalog(catalog);
        const current = yield* this.catalog.export();
        const changes = [];
        for (const plan of catalog.plans) {
          const previous = current.plans
            .filter((p) => p.id === plan.id)
            .sort((a, b) => b.revision - a.revision)[0];
          const {
            version: _,
            revision: __,
            ...old
          } = previous ?? { version: "", revision: 0 };
          if (
            canonical(old) !== canonical(normalizePlan(plan, catalog.features))
          )
            changes.push({
              planId: plan.id,
              action: previous ? "version" : "create",
            });
        }
        return { expectedRevision: current.revision, changes };
      });
    },
    publish: (input: { catalog: Catalog; expectedRevision: number }) => {
      return task({ self: this }, function* () {
        validateCatalog(input.catalog);
        const digest = yield* hash({
          ...input.catalog,
          plans: input.catalog.plans.map((plan) =>
            normalizePlan(plan, input.catalog.features),
          ),
        });
        return yield* this.store.atomic(this.catalogScope(), (tx) => {
          return task(function* () {
            const head = (yield* tx.get<{
              revision: number;
              hash: string;
            }>("catalog", "head"))?.data;
            if (head?.hash === digest) return { revision: head.revision };
            assert(
              (head?.revision ?? 0) === input.expectedRevision,
              "catalog_conflict",
            );
            const revision = input.expectedRevision + 1;
            for (const plan of input.catalog.plans) {
              const normalized = normalizePlan(plan, input.catalog.features);
              const version = yield* hash(normalized);
              if (!(yield* tx.get("catalog", version)))
                yield* put(
                  tx,
                  "catalog",
                  version,
                  { ...normalized, version, revision },
                  "published",
                );
              yield* put(
                tx,
                "catalog",
                `plan:${plan.id}`,
                { version },
                "pointer",
              );
            }
            yield* put(
              tx,
              "catalog",
              "features",
              input.catalog.features,
              "features",
            );
            yield* put(
              tx,
              "catalog",
              "head",
              { revision, hash: digest },
              "head",
            );
            return { revision };
          });
        });
      });
    },
    get: (id: string, version?: string): BillingEffect<PublishedPlan> => {
      return task({ self: this }, function* () {
        return yield* this.store.read(this.catalogScope(), (tx) => {
          return task(function* () {
            const target =
              version ??
              (yield* tx.get<{
                version: string;
              }>("catalog", `plan:${identifier(id)}`))?.data.version;
            assert(target, "plan_not_found");
            const plan = yield* tx.get<PublishedPlan>("catalog", target);
            assert(plan?.data.id === id, "plan_not_found");
            return plan.data;
          });
        });
      });
    },
    migrate: (
      input: WriteInput & {
        subscriptionId: string;
        planId: string;
        effective?: "now" | "period_end";
      },
    ) => {
      return task({ self: this }, function* () {
        return yield* this.subscriptions.update(input);
      });
    },
    custom: (input: { plan: Plan; expectedRevision: number }) => {
      return task({ self: this }, function* () {
        const existing = yield* this.store.read(this.catalogScope(), (tx) => {
          return task(function* () {
            return (
              (yield* tx.get<Catalog["features"]>("catalog", "features"))
                ?.data ?? []
            );
          });
        });
        return yield* this.catalog.publish({
          catalog: {
            features: existing,
            plans: [{ ...input.plan, public: false }],
          },
          expectedRevision: input.expectedRevision,
        });
      });
    },
  };
  readonly customers = {
    create: (input: {
      id: string;
      metadata?: Metadata;
      stripeCustomerId?: string;
      idempotencyKey: string;
    }) =>
      this.write(
        { customerId: input.id, idempotencyKey: input.idempotencyKey },
        "customers.create",
        input,
        (tx) => {
          return task(function* () {
            const existing = yield* tx.get<Customer>("customers", input.id);
            if (existing) return existing.data;
            const customer: Customer = {
              id: input.id,
              metadata: input.metadata ?? {},
              stripeCustomerId: input.stripeCustomerId,
              controls: {},
            };
            yield* put(tx, "customers", input.id, customer);
            return customer;
          });
        },
        true,
      ),
    get: (customerId: string) =>
      this.store.read(this.scope(customerId), (tx) =>
        this.customer(tx, customerId),
      ),
    update: (
      input: WriteInput & {
        metadata?: Metadata;
        stripeCustomerId?: string;
      },
    ) =>
      this.write(input, "customers.update", input, (tx) => {
        return task({ self: this }, function* () {
          const customer = yield* this.customer(tx, input.customerId);
          assert(
            !input.stripeCustomerId ||
              !customer.stripeCustomerId ||
              customer.stripeCustomerId === input.stripeCustomerId,
            "customer_mapping_conflict",
          );
          const updated = {
            ...customer,
            metadata: input.metadata ?? customer.metadata,
            stripeCustomerId:
              input.stripeCustomerId ?? customer.stripeCustomerId,
          };
          yield* put(tx, "customers", customer.id, updated);
          return updated;
        });
      }),
  };
  readonly entities = {
    create: (
      input: WriteInput & {
        id: string;
        metadata?: Metadata;
      },
    ) =>
      this.write(
        { ...input, entityId: undefined },
        "entities.create",
        input,
        (tx) => {
          return task(function* () {
            const entity = {
              id: identifier(input.id),
              metadata: input.metadata ?? {},
            };
            assert(!(yield* tx.get("entities", input.id)), "entity_exists");
            yield* put(tx, "entities", input.id, entity);
            return entity;
          });
        },
      ),
    list: (customerId: string) =>
      this.store.read(this.scope(customerId), (tx) => {
        return task(function* () {
          return (yield* tx.list<Entity>("entities")).map((row) => row.data);
        });
      }),
    update: (
      input: WriteInput & {
        id: string;
        metadata: Metadata;
      },
    ) =>
      this.write(input, "entities.update", input, (tx) => {
        return task(function* () {
          assert(yield* tx.get("entities", input.id), "entity_not_found");
          const entity = { id: input.id, metadata: input.metadata };
          yield* put(tx, "entities", input.id, entity);
          return entity;
        });
      }),
  };
  private subscriptionsIn(tx: Transaction, entityId?: string) {
    return task({ self: this }, function* () {
      return (yield* tx.list<Subscription>("subscriptions", "active"))
        .map((row) => row.data)
        .filter((s) => s.entityId === entityId && isEntitled(s, this.now()));
    });
  }
  private item(
    tx: Transaction,
    feature: string,
    entityId?: string,
  ): BillingEffect<
    | {
        item: PlanItem;
        subscription: Subscription;
      }
    | undefined
  > {
    return task({ self: this }, function* () {
      const found = (yield* this.subscriptionsIn(tx, entityId)).flatMap(
        (subscription) =>
          subscription.plan.items
            .filter((item) => item.feature === feature)
            .map((item) => ({ item, subscription })),
      );
      const priced = found.filter(
        (f) => f.item.rate || f.item.overage || f.item.pool,
      );
      assert(
        new Set(
          priced.map((f) =>
            canonical({
              rate: f.item.rate,
              pool: f.item.pool,
              poolScope: f.item.poolScope,
              overage: f.item.overage,
            }),
          ),
        ).size <= 1,
        "ambiguous_feature_rate",
      );
      return (
        priced[0] ?? found.find((f) => f.item.enabled === true) ?? found[0]
      );
    });
  }
  readonly credits = {
    grant: (
      input: WriteInput & {
        feature: string;
        amount: string;
        expiresAt?: number;
        priority?: number;
        sourceId?: string;
        origin?: Grant["origin"];
      },
    ) =>
      this.write(input, "credits.grant", input, (tx, key) => {
        return task({ self: this }, function* () {
          positive(input.amount);
          assert(Number.isSafeInteger(input.priority ?? 0), "invalid_priority");
          identifier(input.feature);
          if (input.expiresAt !== undefined)
            assert(timestamp(input.expiresAt) > this.now(), "invalid_expiry");
          const grant: Grant = {
            id: yield* hash({ key, feature: input.feature }),
            feature: input.feature,
            entityId: input.entityId,
            amount: input.amount,
            expiresAt: input.expiresAt,
            priority: input.priority ?? 0,
            origin: input.origin ?? "manual",
            sourceId: input.sourceId ?? key,
            createdAt: this.now(),
          };
          yield* this.ledger.grant(tx, grant);
          yield* this.event(tx, input.customerId, "credits.granted", grant);
          return grant;
        });
      }),
    balance: (
      input: ScopeInput & {
        feature: string;
      },
    ) =>
      this.store.atomic(this.scope(input.customerId), (tx) => {
        return task({ self: this }, function* () {
          yield* this.customer(tx, input.customerId);
          yield* this.ledger.materialize(tx);
          const mapped = yield* this.item(tx, input.feature, input.entityId);
          return yield* this.balanceFor(
            tx,
            mapped?.item.pool ?? input.feature,
            allocationEntity(mapped?.item, input.entityId),
          );
        });
      }),
    list: (input: ScopeInput) =>
      this.store.read(this.scope(input.customerId), (tx) => {
        return task(function* () {
          return (yield* tx.list<Grant>("grants"))
            .map((r) => r.data)
            .filter((g) => g.entityId === input.entityId);
        });
      }),
    adjust: (
      input: WriteInput & {
        grantId: string;
        amount: string;
        reason: string;
      },
    ) =>
      this.write(input, "credits.adjust", input, (tx, key) => {
        return task({ self: this }, function* () {
          assert(input.reason.trim().length > 0, "reason_required");
          const grant = (yield* tx.get<Grant>("grants", input.grantId))?.data;
          assert(grant, "grant_not_found");
          const amount = units(input.amount);
          const p = yield* this.ledger.position(tx, grant.id);
          assert(
            units(p.spent) + amount >= 0n &&
              units(p.spent) + units(p.held) + amount <= units(grant.amount),
            "invalid_adjustment",
          );
          yield* this.ledger.movement(tx, grant.id, amount, key, input.reason);
          yield* this.event(tx, input.customerId, "credits.adjusted", {
            grantId: grant.id,
            amount: input.amount,
            reason: input.reason,
          });
          return yield* this.ledger.balance(tx, grant.feature, grant.entityId);
        });
      }),
    reconcile: (customerId: string) =>
      this.store.atomic(this.scope(customerId), (tx) =>
        this.ledger.reconcile(tx),
      ),
  };
  readonly entitlements = {
    check: (
      input: ScopeInput & {
        feature: string;
        amount?: string;
        properties?: Metadata;
      },
    ) => {
      return task({ self: this }, function* () {
        return yield* this.store.atomic(this.scope(input.customerId), (tx) => {
          return task({ self: this }, function* () {
            yield* this.customer(tx, input.customerId);
            yield* this.ledger.materialize(tx);
            const mapped = yield* this.item(tx, input.feature, input.entityId);
            const balance = yield* this.balanceFor(
              tx,
              mapped?.item.pool ?? input.feature,
              allocationEntity(mapped?.item, input.entityId),
            );
            const required =
              mapped?.item.pool && mapped.item.rate
                ? units(rateUsage(mapped.item.rate, input.amount ?? "1"))
                : nonnegative(input.amount ?? "1");
            const payerEntity = allocationEntity(mapped?.item, input.entityId),
              target = mapped?.item.pool ?? input.feature;
            const funding = mapped?.item.overage
              ? mapped
              : mapped?.item.pool
                ? yield* this.item(tx, target, payerEntity)
                : undefined;
            if (funding?.item.overage) {
              return yield* recover(
                task({ self: this }, function* () {
                  yield* this.quoteOverage(
                    tx,
                    {
                      ...input,
                      feature: target,
                      entityId: payerEntity,
                      amount: decimal(required),
                      idempotencyKey: "advisory",
                    },
                    funding,
                  );
                  return { allowed: true, balance };
                }),
                (error) =>
                  task(function* () {
                    if (
                      error instanceof BillingError &&
                      [
                        "spend_limit_exceeded",
                        "payment_setup_required",
                      ].includes(error.code)
                    )
                      return { allowed: false, balance, reason: error.code };
                    return yield* fail(error);
                  }),
              );
            }
            return {
              allowed:
                mapped?.item.enabled === true ||
                units(balance.available) >= required,
              balance,
            };
          });
        });
      });
    },
    list: (input: ScopeInput) =>
      this.store.read(this.scope(input.customerId), (tx) => {
        return task({ self: this }, function* () {
          return (yield* this.subscriptionsIn(tx, input.entityId)).flatMap(
            (s) =>
              s.plan.items.map((item) => ({
                ...item,
                planVersion: s.plan.version,
              })),
          );
        });
      }),
  };
  private afterUsage(
    tx: Transaction,
    customerId: string,
    feature: string,
    entityId?: string,
  ) {
    return task({ self: this }, function* () {
      const customer = yield* this.customer(tx, customerId);
      const balance = yield* this.balanceFor(tx, feature, entityId);
      for (const alert of customer.controls.alerts ?? [])
        if (
          alert.feature === feature &&
          units(balance.available) <= units(alert.remaining)
        ) {
          const id = `alert:${feature}:${alert.remaining}:${new Date(this.now()).toISOString().slice(0, 10)}`;
          if (!(yield* tx.get("counters", id))) {
            yield* put(tx, "counters", id, { sent: true });
            yield* this.event(tx, customerId, "balance.threshold", balance);
          }
        }
      const topup = customer.controls.autoTopUp;
      if (
        topup?.feature === feature &&
        units(balance.available) < units(topup.below)
      ) {
        const period = new Date(this.now()).toISOString().slice(0, 7),
          counter = `topup:${period}`;
        const previous = (yield* tx.get<{
          count: number;
          pending?: string;
        }>("counters", counter))?.data ?? { count: 0 };
        const pending = (yield* tx.get<{
          operationId?: string;
        }>("counters", "topup-pending"))?.data.operationId;
        if (
          !pending &&
          !previous.pending &&
          previous.count < topup.maximumPurchases
        ) {
          const id = crypto.randomUUID();
          yield* put(tx, "counters", "topup-pending", { operationId: id });
          yield* put(tx, "counters", counter, {
            count: previous.count + 1,
            pending: id,
          });
          yield* this.enqueue(tx, id, "auto_topup", {
            planId: topup.packPlan,
            counter,
            customerId,
          });
        }
      }
    });
  }
  private quoteOverage(
    tx: Transaction,
    input: UsageInput,
    mapped: {
      item: PlanItem;
      subscription: Subscription;
    },
  ) {
    return task({ self: this }, function* () {
      const sub = mapped.subscription,
        quantity = nonnegative(input.amount);
      const dimensions = mapped.item.rate?.dimensions?.filter((d) =>
        Object.entries(d.match).every(
          ([key, value]) => input.properties?.[key] === value,
        ),
      );
      if (dimensions)
        assert(
          dimensions.length === 1,
          dimensions.length ? "ambiguous_rate" : "missing_rate",
        );
      const counterId = yield* hash({
        feature: input.feature,
        entityId: input.entityId,
        sub: sub.id,
        start: sub.periodStart,
        dimension: dimensions?.[0]?.match ?? {},
        version: sub.plan.version,
      });
      const previous = (yield* tx.get<{
        quantity: string;
        cost: string;
      }>("counters", counterId))?.data ?? { quantity: "0", cost: "0" };
      const budgetKey = yield* hash({
        feature: input.feature,
        entityId: input.entityId,
        sub: sub.id,
        start: sub.periodStart,
      });
      const meterKey = yield* hash({ budgetKey, version: sub.plan.version });
      const versionAggregate = (yield* tx.get<{
        total: string;
        generation: number;
      }>("counters", `meter-version:${meterKey}`))?.data ?? {
        total: "0",
        generation: 0,
      };
      const aggregate = (yield* tx.get<{
        total: string;
        quantity: string;
        generation: number;
      }>("counters", `meter-total:${budgetKey}`))?.data ?? {
        total: "0",
        quantity: "0",
        generation: 0,
      };
      const available = units(
        (yield* this.ledger.balance(tx, input.feature, input.entityId))
          .available,
      );
      const covered = minimum(quantity, available),
        billable = quantity - covered,
        next = units(previous.quantity) + billable;
      const total = rateUsage(
          mapped.item.rate!,
          decimal(next),
          input.properties,
        ),
        charge = decimal(units(total) - units(previous.cost));
      const aggregateTotal = decimal(units(aggregate.total) + units(charge)),
        versionTotal = decimal(units(versionAggregate.total) + units(charge));
      const customer = yield* this.customer(tx, input.customerId),
        limit = customer.controls.overageLimits?.[input.feature];
      if (limit !== undefined)
        assert(units(aggregateTotal) <= units(limit), "spend_limit_exceeded");
      if (units(charge) !== 0n)
        assert(
          sub.stripeSubscriptionId &&
            sub.plan.stripeMeterPriceIds?.[input.feature],
          "payment_setup_required",
        );
      return {
        sub,
        counterId,
        next,
        total,
        budgetKey,
        meterKey,
        versionAggregate,
        aggregate,
        aggregateTotal,
        versionTotal,
        charge,
        covered,
      };
    });
  }
  private consume(
    tx: Transaction,
    input: UsageInput,
    key: string,
  ): BillingEffect<Usage> {
    return task({ self: this }, function* () {
      yield* this.ledger.materialize(tx);
      const quantity = positive(input.amount);
      assert(
        (yield* this.quantityCapacity(tx, input.feature, input.entityId)) ===
          undefined,
        "quantity_requires_assignment",
      );
      const mapped = yield* this.item(tx, input.feature, input.entityId);
      const target = mapped?.item.pool ?? input.feature;
      const payerEntity = allocationEntity(mapped?.item, input.entityId);
      const funding = mapped?.item.overage
        ? mapped
        : mapped?.item.pool
          ? yield* this.item(tx, target, payerEntity)
          : undefined;
      const cost =
        mapped?.item.pool && mapped.item.rate
          ? units(rateUsage(mapped.item.rate, input.amount, input.properties))
          : quantity;
      let charge = decimal(cost),
        currency: string | undefined,
        allocations: Allocation[] = [];
      if (funding?.item.overage) {
        const rated = {
          ...input,
          feature: target,
          entityId: payerEntity,
          amount: decimal(cost),
        };
        const q = yield* this.quoteOverage(tx, rated, funding);
        charge = q.charge;
        currency = q.sub.plan.currency ?? "usd";
        if (q.covered > 0n)
          allocations = yield* this.ledger.allocate(
            tx,
            target,
            q.covered,
            payerEntity,
            false,
            key,
          );
        yield* put(tx, "counters", q.counterId, {
          quantity: decimal(q.next),
          cost: q.total,
        });
        yield* put(tx, "counters", `meter-total:${q.budgetKey}`, {
          total: q.aggregateTotal,
          quantity: decimal(units(q.aggregate.quantity) + cost),
          generation: q.aggregate.generation + 1,
        });
        yield* put(tx, "counters", `meter-version:${q.meterKey}`, {
          total: q.versionTotal,
          generation: q.versionAggregate.generation + 1,
        });
        if (units(charge) !== 0n)
          yield* this.enqueue(tx, `usage:${key}`, "meter", {
            customerId: input.customerId,
            subscriptionId: q.sub.stripeSubscriptionId,
            feature: target,
            delta: charge,
            total: q.versionTotal,
            meterKey: q.meterKey,
            generation: q.versionAggregate.generation + 1,
            currency,
            periodStart: q.sub.periodStart,
            periodEnd: q.sub.periodEnd,
            priceId: q.sub.plan.stripeMeterPriceIds?.[target],
          });
      } else
        allocations = yield* this.ledger.allocate(
          tx,
          target,
          cost,
          payerEntity,
          false,
          key,
        );
      const usage: Usage = {
        id: crypto.randomUUID(),
        feature: input.feature,
        entityId: input.entityId,
        quantity: input.amount,
        charged: charge,
        currency,
        planVersion: mapped?.subscription.plan.version,
        allocations,
        createdAt: this.now(),
        properties: input.properties ?? {},
      };
      yield* put(tx, "usage", usage.id, usage);
      yield* this.afterUsage(
        tx,
        input.customerId,
        target,
        allocationEntity(mapped?.item, input.entityId),
      );
      return usage;
    });
  }
  private page<T>(
    customerId: string,
    table: Table,
    input: {
      cursor?: string;
      limit?: number;
    } = {},
  ) {
    return task({ self: this }, function* () {
      const limit = input.limit ?? 100;
      assert(
        Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
        "invalid_limit",
      );
      return yield* this.store.read(this.scope(customerId), (tx) => {
        return task(function* () {
          const rows = yield* tx.page<T>(table, {
            after: input.cursor,
            limit: limit + 1,
          });
          return {
            items: rows.slice(0, limit).map((r) => r.data),
            nextCursor: rows.length > limit ? rows[limit - 1]!.id : undefined,
          };
        });
      });
    });
  }
  readonly usage = {
    page: (
      input: ScopeInput & {
        cursor?: string;
        limit?: number;
      },
    ) => {
      return task({ self: this }, function* () {
        const page = yield* this.page<Usage>(input.customerId, "usage", input);
        return {
          ...page,
          items: page.items.filter((u) => u.entityId === input.entityId),
        };
      });
    },
    aggregate: (
      input: ScopeInput & {
        from: number;
        to: number;
        cursor?: string;
        limit?: number;
        groupBy?: string[];
      },
    ) => {
      return task({ self: this }, function* () {
        assert(
          timestamp(input.from) < timestamp(input.to),
          "invalid_usage_window",
        );
        const groupBy = input.groupBy ?? [];
        assert(
          groupBy.length <= 8 && new Set(groupBy).size === groupBy.length,
          "invalid_usage_grouping",
        );
        for (const key of groupBy) identifier(key);
        const page = yield* this.page<Usage>(input.customerId, "usage", input);
        const totals = new Map<
          string,
          {
            feature: string;
            currency?: string;
            planVersion?: string;
            properties: Record<string, string | null>;
            quantity: string;
            charged: string;
            records: number;
          }
        >();
        for (const receipt of page.items) {
          if (
            receipt.entityId !== input.entityId ||
            receipt.createdAt < input.from ||
            receipt.createdAt >= input.to
          )
            continue;
          const properties = Object.fromEntries(
            groupBy.map((key) => [key, receipt.properties[key] ?? null]),
          );
          const identity = {
            feature: receipt.feature,
            currency: receipt.currency,
            planVersion: receipt.planVersion,
            properties,
          };
          const key = canonical(identity),
            previous = totals.get(key);
          totals.set(key, {
            ...identity,
            quantity: decimal(
              units(previous?.quantity ?? "0") + units(receipt.quantity),
            ),
            charged: decimal(
              units(previous?.charged ?? "0") + units(receipt.charged),
            ),
            records: (previous?.records ?? 0) + 1,
          });
        }
        return {
          totals: [...totals.values()],
          scanned: page.items.length,
          nextCursor: page.nextCursor,
          complete: page.nextCursor === undefined,
          window: { from: input.from, to: input.to },
        };
      });
    },
    batch: (input: {
      customerId: string;
      idempotencyKey: string;
      events: Omit<UsageInput, "customerId">[];
    }) =>
      this.write(input, "usage.batch", input, (tx) => {
        return task({ self: this }, function* () {
          assert(
            input.events.length > 0 && input.events.length <= 100,
            "invalid_batch_size",
          );
          assert(
            new Set(input.events.map((e) => e.idempotencyKey)).size ===
              input.events.length &&
              input.events.every(
                (e) => e.idempotencyKey !== input.idempotencyKey,
              ),
            "duplicate_batch_key",
          );
          const receipts: Usage[] = [];
          for (const event of input.events) {
            const usageInput = { ...event, customerId: input.customerId };
            receipts.push(
              yield* this.applyWrite(
                tx,
                usageInput,
                yield* hash({ method: "usage.consume", payload: usageInput }),
                (tx, key) => this.consume(tx, usageInput, key),
              ),
            );
          }
          return { receipts };
        });
      }),
    consume: (input: UsageInput) =>
      this.write(input, "usage.consume", input, (tx, key) =>
        this.consume(tx, input, key),
      ),
    record: (input: UsageInput) =>
      this.write(input, "usage.record", input, (tx, key) =>
        this.consume(tx, input, key),
      ),
    list: (input: ScopeInput) => {
      return task({ self: this }, function* () {
        return (yield* this.usage.page(input)).items;
      });
    },
    correct: (
      input: WriteInput & {
        usageId: string;
        reason: string;
      },
    ) =>
      this.write(input, "usage.correct", input, (tx, key) => {
        return task({ self: this }, function* () {
          assert(input.reason.trim(), "reason_required");
          const original = yield* tx.get<Usage>("usage", input.usageId);
          assert(original, "usage_not_found");
          assert(original.state !== "reversed", "already_corrected");
          if (original.data.currency && units(original.data.charged) !== 0n) {
            const workId = crypto.randomUUID();
            yield* this.enqueue(tx, workId, "adjustment", {
              usage: original.data,
              reason: input.reason,
            });
            const work = (yield* tx.get<Work>("work", workId))!.data;
            work.status = "reconciliation";
            yield* put(tx, "work", workId, work, "reconciliation");
            return { status: "reconciliation", operationId: workId };
          }
          for (const allocation of original.data.allocations)
            yield* this.ledger.movement(
              tx,
              allocation.grantId,
              -units(allocation.amount),
              key,
              input.reason,
              original.data.id,
            );
          const correction = {
            ...original.data,
            id: crypto.randomUUID(),
            quantity: decimal(-units(original.data.quantity)),
            charged: decimal(-units(original.data.charged)),
            allocations: original.data.allocations.map((a) => ({
              ...a,
              amount: decimal(-units(a.amount)),
            })),
            reverses: original.data.id,
            createdAt: this.now(),
          };
          yield* put(tx, "usage", correction.id, correction);
          yield* put(tx, "usage", original.id, original.data, "reversed");
          yield* this.event(
            tx,
            input.customerId,
            "usage.corrected",
            correction,
          );
          return { status: "corrected", usage: correction };
        });
      }),
    setQuantity: (input: UsageInput) =>
      this.write(input, "usage.setQuantity", input, (tx, key) => {
        return task({ self: this }, function* () {
          yield* this.ledger.materialize(tx);
          nonnegative(input.amount);
          const capacity = yield* this.quantityCapacity(
            tx,
            input.feature,
            input.entityId,
          );
          if (capacity !== undefined)
            assert(
              units(input.amount) +
                (input.entityId
                  ? 0n
                  : BigInt(
                      (yield* tx.list<{
                        feature: string;
                      }>("licenses", "active")).filter(
                        (r) => r.data.feature === input.feature,
                      ).length,
                    ) * 1000000n) <=
                capacity,
              "quantity_limit_exceeded",
            );
          const id = yield* hash({
            feature: input.feature,
            entity: input.entityId,
          });
          const previous = (yield* tx.get<{
            amount: string;
            allocations: Allocation[];
          }>("counters", `quantity:${id}`))?.data ?? {
            amount: "0",
            allocations: [],
          };
          let allocations = [...previous.allocations];
          const delta = units(input.amount) - units(previous.amount);
          if (delta > 0n)
            allocations.push(
              ...(yield* this.ledger.allocate(
                tx,
                input.feature,
                delta,
                input.entityId,
                false,
                key,
              )),
            );
          else {
            let left = -delta;
            for (const allocation of [...allocations].reverse()) {
              const give = minimum(units(allocation.amount), left);
              if (give > 0n) {
                yield* this.ledger.movement(
                  tx,
                  allocation.grantId,
                  -give,
                  key,
                  "quantity_release",
                );
                allocation.amount = decimal(units(allocation.amount) - give);
                left -= give;
              }
            }
            allocations = allocations.filter((a) => units(a.amount) > 0n);
          }
          yield* put(tx, "counters", `quantity:${id}`, {
            amount: input.amount,
            allocations,
          });
          return { amount: input.amount };
        });
      }),
  };
  private occupied(
    tx: Transaction,
    feature: string,
    entityId?: string,
  ): BillingEffect<bigint> {
    return task(function* () {
      const id = yield* hash({ feature, entity: entityId });
      const quantity =
        (yield* tx.get<{
          amount: string;
        }>("counters", `quantity:${id}`))?.data.amount ?? "0";
      const assignments = (yield* tx.list<{
        feature: string;
      }>("licenses", "active")).filter(
        (r) => r.data.feature === feature,
      ).length;
      return units(quantity) + (entityId ? 0n : BigInt(assignments) * 1000000n);
    });
  }
  private balanceFor(
    tx: Transaction,
    feature: string,
    entityId?: string,
  ): BillingEffect<Balance> {
    return task({ self: this }, function* () {
      const capacity = yield* this.quantityCapacity(tx, feature, entityId);
      if (capacity === undefined)
        return yield* this.ledger.balance(tx, feature, entityId);
      const used = yield* this.occupied(tx, feature, entityId);
      return {
        feature,
        granted: decimal(capacity),
        spent: decimal(used),
        reserved: "0",
        available: decimal(capacity - used),
      };
    });
  }
  private quantityCapacity(
    tx: Transaction,
    feature: string,
    entityId?: string,
  ): BillingEffect<bigint | undefined> {
    return task({ self: this }, function* () {
      const kind = (yield* tx.get<{
        kind: string;
      }>("counters", `feature-kind:${feature}`))?.data.kind;
      if (kind !== "quantity") return undefined;
      let capacity = 0n;
      for (const sub of yield* this.subscriptionsIn(tx, entityId)) {
        const item = sub.plan.items.find((i) => i.feature === feature);
        if (item)
          capacity +=
            (units(item.included ?? "0") * units(sub.quantity)) / 1000000n;
      }
      for (const grant of yield* this.ledger.usableGrants(
        tx,
        feature,
        entityId,
      ))
        if (
          grant.origin === "manual" ||
          (grant.origin === "purchase" &&
            !(yield* this.subscriptionsIn(tx, entityId)).some(
              (sub) => sub.purchaseId === grant.sourceId,
            ))
        )
          capacity += units(grant.amount);
      return capacity;
    });
  }
  readonly reservations = {
    create: (
      input: UsageInput & {
        expiresAt?: number;
      },
    ) =>
      this.write(input, "reservations.create", input, (tx, key) => {
        return task({ self: this }, function* () {
          yield* this.ledger.materialize(tx);
          positive(input.amount);
          const mapped = yield* this.item(tx, input.feature, input.entityId);
          assert(
            !mapped?.item.overage,
            "reservation_overage_unsupported",
            "Reserve a prepaid credit pool for uncertain-cost work.",
          );
          const feature = mapped?.item.pool ?? input.feature;
          const amount =
            mapped?.item.pool && mapped.item.rate
              ? rateUsage(mapped.item.rate, input.amount, input.properties)
              : input.amount;
          return yield* this.ledger.reserve(
            tx,
            {
              feature,
              amount,
              entityId: input.entityId,
              poolScope: mapped?.item.poolScope,
              expiresAt: input.expiresAt ?? this.now() + 15 * 60000,
            },
            key,
          );
        });
      }),
    increase: (
      input: WriteInput & {
        reservationId: string;
        amount: string;
      },
    ) =>
      this.write(input, "reservations.increase", input, (tx, key) => {
        return task({ self: this }, function* () {
          yield* this.ledger.materialize(tx);
          const row = yield* tx.get<Reservation>(
            "reservations",
            input.reservationId,
          );
          assert(row?.state === "held", "reservation_not_held");
          return yield* this.ledger.increaseReservation(
            tx,
            row.data,
            input.amount,
            key,
          );
        });
      }),
    release: (
      input: WriteInput & {
        reservationId: string;
      },
    ) =>
      this.write(input, "reservations.release", input, (tx) => {
        return task({ self: this }, function* () {
          yield* this.ledger.materialize(tx);
          const row = yield* tx.get<Reservation>(
            "reservations",
            input.reservationId,
          );
          assert(row, "reservation_not_found");
          if (row.state !== "held") return row.data;
          return yield* this.ledger.finishReservation(tx, row.data, "released");
        });
      }),
    settle: (
      input: WriteInput & {
        reservationId: string;
        amount: string;
      },
    ) =>
      this.write(input, "reservations.settle", input, (tx, key) => {
        return task({ self: this }, function* () {
          yield* this.ledger.materialize(tx);
          const row = yield* tx.get<Reservation>(
            "reservations",
            input.reservationId,
          );
          assert(row, "reservation_not_found");
          nonnegative(input.amount);
          const r = row.data;
          if (
            row.state !== "held" ||
            !(yield* this.ledger.reservationFunded(tx, r)) ||
            units(input.amount) > units(r.amount)
          ) {
            const id = crypto.randomUUID();
            yield* this.enqueue(tx, id, "reservation_adjustment", {
              reservationId: r.id,
              amount: input.amount,
            });
            const work = (yield* tx.get<Work>("work", id))!.data;
            work.status = "reconciliation";
            yield* put(tx, "work", id, work, "reconciliation");
            return { status: "reconciliation" as const, operationId: id };
          }
          const usage = yield* this.ledger.settleReservation(
            tx,
            r,
            input.amount,
            key,
          );
          const next = { ...r, status: "settled" as const };
          yield* this.afterUsage(
            tx,
            input.customerId,
            r.feature,
            r.poolScope === "customer" ? undefined : r.entityId,
          );
          return { status: "settled" as const, reservation: next, usage };
        });
      }),
    list: (customerId: string) =>
      this.store.read(this.scope(customerId), (tx) => {
        return task(function* () {
          return (yield* tx.list<Reservation>("reservations")).map(
            (r) => r.data,
          );
        });
      }),
  };
  readonly billingControls = {
    get: (customerId: string) => {
      return task({ self: this }, function* () {
        return (yield* this.customers.get(customerId)).controls;
      });
    },
    update: (
      input: WriteInput & {
        controls: Controls;
      },
    ) => {
      return task({ self: this }, function* () {
        const topup = input.controls.autoTopUp;
        if (topup) {
          const pack = yield* this.catalog.get(topup.packPlan);
          assert(
            pack.kind === "one_time" &&
              pack.items.some(
                (item) =>
                  (item.pool ?? item.feature) === topup.feature &&
                  units(item.included ?? "0") > 0n,
              ),
            "invalid_topup_pack",
          );
        }
        return yield* this.write(input, "controls.update", input, (tx) => {
          return task({ self: this }, function* () {
            for (const value of Object.values(
              input.controls.overageLimits ?? {},
            ))
              nonnegative(value);
            for (const alert of input.controls.alerts ?? [])
              nonnegative(alert.remaining);
            if (topup) {
              nonnegative(topup.below);
              assert(
                Number.isSafeInteger(topup.maximumPurchases) &&
                  topup.maximumPurchases > 0,
                "invalid_topup_limit",
              );
            }
            const customer = yield* this.customer(tx, input.customerId);
            customer.controls = input.controls;
            yield* put(tx, "customers", customer.id, customer);
            if (topup)
              yield* this.afterUsage(tx, input.customerId, topup.feature);
            return customer.controls;
          });
        });
      });
    },
  };
  private providerIdentity(scope: string, operation: string) {
    return hash({ environment: this.environment, scope, operation });
  }
  private payment(
    input: WriteInput,
    kind: string,
    parameters: Record<string, unknown>,
  ) {
    return task({ self: this }, function* () {
      const saved = yield* this.write(
        input,
        `payment.${kind}`,
        parameters,
        (tx, key) => {
          return task({ self: this }, function* () {
            const id = `payment:${key}`;
            if (
              kind === "checkout" &&
              (parameters.plan as PublishedPlan).kind !== "one_time"
            ) {
              const plan = parameters.plan as PublishedPlan;
              const slot = yield* hash({
                group: plan.addOn ? plan.id : (plan.group ?? "base"),
                entity: input.entityId,
              });
              const current = (yield* tx.get<{
                operationId: string;
                version: string;
                quantity: string;
                expiresAt: number;
              }>("counters", `checkout:${slot}`))?.data;
              if (current && current.expiresAt > this.now()) {
                assert(
                  current.version === plan.version &&
                    current.quantity === String(parameters.quantity ?? "1"),
                  "checkout_in_progress",
                );
                return { operationId: current.operationId };
              }
              yield* put(tx, "counters", `checkout:${slot}`, {
                operationId: id,
                entityId: input.entityId,
                version: plan.version,
                quantity: String(parameters.quantity ?? "1"),
                expiresAt: this.now() + 24 * 60 * 60000,
              });
            }
            const payload = { ...parameters, customerId: input.customerId };
            const plan = parameters.plan as PublishedPlan | undefined;
            if (kind === "checkout" && plan && plan.kind !== "one_time") {
              const existing = (yield* this.subscriptionsIn(
                tx,
                input.entityId,
              )).find(
                (s) =>
                  s.plan.kind !== "free" &&
                  s.plan.kind !== "one_time" &&
                  (s.plan.id === plan.id ||
                    (!s.plan.addOn &&
                      !plan.addOn &&
                      (s.plan.group ?? "base") === (plan.group ?? "base"))),
              );
              assert(
                !existing,
                "subscription_exists",
                "Use subscriptions.update for existing subscriptions.",
              );
            }
            if (kind === "checkout" && plan?.trialDays) {
              const used = yield* tx.get("counters", "trial-claimed");
              Object.assign(payload, { trialAllowed: !used });
              if (!used)
                yield* put(tx, "counters", "trial-claimed", {
                  operationId: id,
                  createdAt: this.now(),
                });
            }
            yield* this.enqueue(tx, id, kind, payload);
            return { operationId: id };
          });
        },
      );
      yield* this.runWork(this.scope(input.customerId), saved.operationId);
      return yield* this.operations.get(input.customerId, saved.operationId);
    });
  }
  private subscriptionCommand(
    input: WriteInput & {
      subscriptionId: string;
    },
    kind: string,
    payload: Record<string, unknown>,
  ): BillingEffect<Work> {
    return task({ self: this }, function* () {
      const existing = yield* this.store.read(
        this.scope(input.customerId),
        (tx) => {
          return task(function* () {
            return (yield* tx.get<Subscription>(
              "subscriptions",
              input.subscriptionId,
            ))?.data;
          });
        },
      );
      if (!existing || existing.stripeSubscriptionId)
        return yield* this.payment(input, kind, payload);
      return yield* this.write(input, `local.${kind}`, payload, (tx, key) => {
        return task({ self: this }, function* () {
          const row = yield* tx.get<Subscription>(
            "subscriptions",
            input.subscriptionId,
          );
          assert(row, "subscription_not_found");
          const sub = row.data;
          if (payload.plan)
            yield* registerFeatures(tx, payload.plan as PublishedPlan);
          assert(sub.plan.kind === "free", "payment_required");
          const plan = payload.plan as PublishedPlan | undefined;
          if (plan) assert(plan.kind === "free", "payment_required");
          let end = sub.periodEnd;
          let i = 1;
          while (end <= this.now() && i < 1200) {
            end = addInterval(
              sub.periodStart,
              sub.plan.interval ?? "month",
              i++,
            );
          }
          assert(end > this.now(), "period_reconciliation_required");
          switch (kind) {
            case "preview":
              break;
            case "subscription_update": {
              if (payload.quantity !== undefined) {
                positive(String(payload.quantity));
                sub.quantity = String(payload.quantity);
              }
              if (plan && payload.effective !== "now")
                sub.scheduledPlans = [
                  {
                    plan,
                    start: end,
                    end: addInterval(end, plan.interval ?? "month"),
                  },
                ];
              else if (plan) {
                const granted: Record<string, string> = Object.create(null);
                let until = end;
                for (const { data: g } of yield* tx.list<Grant>(
                  "grants",
                  "active",
                ))
                  if (
                    g.sourceId === sub.id &&
                    g.origin === "subscription" &&
                    (g.expiresAt ?? Infinity) > this.now()
                  ) {
                    granted[g.feature] = decimal(
                      units(granted[g.feature] ?? "0") + units(g.amount),
                    );
                    until = Math.min(until, g.expiresAt ?? Infinity);
                  }
                sub.provisioningOffset = { until, granted };
                sub.plan = plan;
              }
              break;
            }
            case "subscription_cancel":
              sub.cancelAtPeriodEnd = !payload.immediately;
              sub.periodEnd = end;
              sub.paidThrough = payload.immediately ? this.now() : end;
              sub.scheduledPlans = [];
              if (payload.immediately) sub.status = "ended";
              break;
            case "subscription_pause":
              sub.status = "paused";
              break;
            case "subscription_resume":
              sub.status = "active";
              sub.cancelAtPeriodEnd = false;
              sub.paidThrough = Number.MAX_SAFE_INTEGER;
              break;
            case "subscription_schedule": {
              const phases = payload.phases as {
                plan: PublishedPlan;
                iterations: number;
              }[];
              assert(
                phases.length > 0 && phases.length <= 10,
                "invalid_schedule",
              );
              let start = end;
              sub.scheduledPlans = [];
              for (const phase of phases) {
                assert(
                  phase.plan.kind === "free" &&
                    Number.isSafeInteger(phase.iterations) &&
                    phase.iterations > 0 &&
                    phase.iterations <= 120,
                  "invalid_schedule",
                );
                const until = addInterval(
                  start,
                  phase.plan.interval ?? "month",
                  phase.iterations,
                );
                sub.scheduledPlans.push({
                  plan: phase.plan,
                  start,
                  end: until,
                });
                start = until;
              }
              break;
            }
            default:
              return yield* fail(
                new BillingError("unsupported_subscription_operation"),
              );
          }
          if (kind !== "preview") {
            yield* put(
              tx,
              "subscriptions",
              sub.id,
              sub,
              ["active", "trialing"].includes(sub.status)
                ? "active"
                : sub.status,
            );
            yield* this.ledger.materialize(tx);
            yield* this.event(tx, input.customerId, kind, {
              subscriptionId: sub.id,
            });
          }
          const work: Work = {
            id: `local:${key}`,
            kind,
            payload,
            status: "done",
            attempts: 1,
            availableAt: this.now(),
            createdAt: this.now(),
            result:
              kind === "preview"
                ? {
                    amountDue: "0",
                    currency: plan?.currency ?? "usd",
                    effectiveAt: end,
                  }
                : sub,
          };
          yield* put(tx, "work", work.id, work, "done");
          return work;
        });
      });
    });
  }
  readonly subscriptions = {
    attach: (
      input: WriteInput & {
        planId: string;
        version?: string;
        quantity?: string;
      },
    ) => {
      return task({ self: this }, function* () {
        const plan = yield* this.catalog.get(input.planId, input.version);
        const free = plan.kind === "free";
        assert(
          free,
          "payment_required",
          "Use subscriptions.checkout for paid plans.",
        );
        return yield* this.write(input, "subscriptions.attach", input, (tx) => {
          return task({ self: this }, function* () {
            const previous = (yield* this.subscriptionsIn(
              tx,
              input.entityId,
            )).find(
              (s) =>
                (s.plan.kind !== "one_time" &&
                  !s.plan.addOn &&
                  !plan.addOn &&
                  (s.plan.group ?? "base") === (plan.group ?? "base")) ||
                s.plan.id === plan.id,
            );
            if (previous) {
              assert(previous.plan.id === plan.id, "subscription_exists");
              return previous;
            }
            const id = yield* hash({ plan: plan.id, entity: input.entityId }),
              now = this.now();
            const end = addInterval(now, plan.interval ?? "month");
            const sub: Subscription = {
              id,
              entityId: input.entityId,
              plan,
              status: "active",
              periodStart: now,
              periodEnd: end,
              paidThrough: plan.kind === "free" ? Number.MAX_SAFE_INTEGER : end,
              quantity: input.quantity ?? "1",
            };
            positive(sub.quantity);
            yield* registerFeatures(tx, plan);
            yield* put(tx, "subscriptions", id, sub);
            yield* this.ledger.materialize(tx);
            return sub;
          });
        });
      });
    },
    list: (customerId: string) =>
      this.store.read(this.scope(customerId), (tx) => {
        return task(function* () {
          return (yield* tx.list<Subscription>("subscriptions")).map(
            (r) => r.data,
          );
        });
      }),
    checkout: (
      input: WriteInput & {
        planId: string;
        version?: string;
        quantity?: string;
        successUrl: string;
        cancelUrl?: string;
        discountId?: string;
        automaticTax?: boolean;
      },
    ) => {
      return task({ self: this }, function* () {
        const plan = yield* this.catalog.get(input.planId, input.version);
        if (input.quantity !== undefined)
          assert(
            positive(input.quantity) % 1000000n === 0n,
            "invalid_seat_quantity",
          );
        returnUrl(input.successUrl);
        if (input.cancelUrl) returnUrl(input.cancelUrl);
        return yield* this.payment(input, "checkout", {
          ...input,
          plan,
        });
      });
    },
    preview: (
      input: WriteInput & {
        subscriptionId: string;
        planId: string;
      },
    ) => {
      return task({ self: this }, function* () {
        return yield* this.subscriptionCommand(input, "preview", {
          ...input,
          plan: yield* this.catalog.get(input.planId),
        });
      });
    },
    update: (
      input: WriteInput & {
        subscriptionId: string;
        planId?: string;
        quantity?: string;
        effective?: "now" | "period_end";
      },
    ) => {
      return task({ self: this }, function* () {
        return yield* this.subscriptionCommand(input, "subscription_update", {
          ...input,
          plan: input.planId
            ? yield* this.catalog.get(input.planId)
            : undefined,
        });
      });
    },
    cancel: (
      input: WriteInput & {
        subscriptionId: string;
        immediately?: boolean;
      },
    ) => this.subscriptionCommand(input, "subscription_cancel", input),
    pause: (
      input: WriteInput & {
        subscriptionId: string;
      },
    ) => this.subscriptionCommand(input, "subscription_pause", input),
    resume: (
      input: WriteInput & {
        subscriptionId: string;
      },
    ) => this.subscriptionCommand(input, "subscription_resume", input),
    schedule: (
      input: WriteInput & {
        subscriptionId: string;
        phases: {
          planId: string;
          iterations: number;
        }[];
      },
    ) => {
      return task({ self: this }, function* () {
        return yield* this.subscriptionCommand(input, "subscription_schedule", {
          ...input,
          phases: yield* Effect.all(
            input.phases.map((phase) => {
              return task({ self: this }, function* () {
                return {
                  ...phase,
                  plan: yield* this.catalog.get(phase.planId),
                };
              });
            }),
            { concurrency: 1 },
          ),
        });
      });
    },
    portal: (
      input: WriteInput & {
        returnUrl: string;
      },
    ) => this.payment(input, "portal", input),
  };
  readonly commerce = {
    invoices: (input: WriteInput) => this.payment(input, "invoices", input),
    invoice: (
      input: WriteInput & {
        amount: string;
        currency: string;
        description: string;
        daysUntilDue?: number;
      },
    ) => this.payment(input, "invoice", input),
    refund: (
      input: WriteInput & {
        paymentIntentId: string;
        amount?: string;
        currency?: string;
        reason: string;
      },
    ) => this.payment(input, "refund", input),
    creditNote: (
      input: WriteInput & {
        invoiceId: string;
        amount: string;
        currency: string;
        reason: string;
      },
    ) => this.payment(input, "credit_note", input),
  };
  readonly licenses = {
    assign: (
      input: WriteInput & {
        feature: string;
        entityId: string;
      },
    ) =>
      this.write(input, "licenses.assign", input, (tx, key) => {
        return task({ self: this }, function* () {
          const id = yield* hash({
            feature: input.feature,
            entity: input.entityId,
          });
          assert(
            (yield* tx.get("licenses", id))?.state !== "active",
            "license_already_assigned",
          );
          yield* this.ledger.materialize(tx);
          const capacity = yield* this.quantityCapacity(tx, input.feature);
          if (capacity !== undefined) {
            assert(
              (yield* this.occupied(tx, input.feature)) + 1000000n <= capacity,
              "quantity_limit_exceeded",
            );
          }
          const allocations = yield* this.ledger.allocate(
            tx,
            input.feature,
            1000000n,
            undefined,
            false,
            key,
          );
          yield* put(tx, "licenses", id, {
            id,
            entityId: input.entityId,
            feature: input.feature,
            allocations,
          });
          return { id };
        });
      }),
    release: (
      input: WriteInput & {
        licenseId: string;
      },
    ) =>
      this.write(input, "licenses.release", input, (tx, key) => {
        return task({ self: this }, function* () {
          const row = yield* tx.get<{
            allocations: Allocation[];
          }>("licenses", input.licenseId);
          assert(row?.state === "active", "license_not_found");
          for (const a of row.data.allocations)
            yield* this.ledger.movement(
              tx,
              a.grantId,
              -units(a.amount),
              key,
              "license_release",
            );
          yield* put(tx, "licenses", row.id, row.data, "released");
          return { released: true };
        });
      }),
    list: (customerId: string) =>
      this.store.read(this.scope(customerId), (tx) => {
        return task(function* () {
          return (yield* tx.list("licenses", "active")).map((r) => r.data);
        });
      }),
  };
  readonly operations = {
    reconcile: (
      input: WriteInput & {
        operationId: string;
        resolution: string;
        result?: unknown;
        outcome?: "completed" | "not_executed";
      },
    ): BillingEffect<{
      resolved: boolean;
    }> => {
      return task({ self: this }, function* () {
        return yield* this.operations.resolve(input);
      });
    },
    page: (
      customerId: string,
      input: {
        cursor?: string;
        limit?: number;
      } = {},
    ) => this.page<Work>(customerId, "work", input),
    get: (customerId: string, id: string) =>
      this.store.read(this.scope(customerId), (tx) => {
        return task(function* () {
          const row = yield* tx.get<Work>("work", id);
          assert(row, "operation_not_found");
          return row.data;
        });
      }),
    list: (customerId: string) => {
      return task({ self: this }, function* () {
        return (yield* this.operations.page(customerId)).items;
      });
    },
    retry: (
      input: WriteInput & {
        operationId: string;
      },
    ) => {
      return task({ self: this }, function* () {
        yield* this.write(input, "operations.retry", input, (tx) => {
          return task({ self: this }, function* () {
            const row = yield* tx.get<Work>("work", input.operationId);
            assert(row, "operation_not_found");
            assert(row.state !== "reconciliation", "reconciliation_required");
            assert(
              row.state !== "processing" ||
                (row.data.leaseUntil ?? 0) <= this.now(),
              "operation_in_progress",
            );
            if (row.state !== "done")
              yield* put(
                tx,
                "work",
                row.id,
                {
                  ...row.data,
                  status: "pending",
                  availableAt: this.now(),
                },
                "pending",
              );
            return { id: row.id };
          });
        });
        yield* this.runWork(this.scope(input.customerId), input.operationId);
        return yield* this.operations.get(input.customerId, input.operationId);
      });
    },
    resolve: (
      input: WriteInput & {
        operationId: string;
        resolution: string;
        result?: unknown;
        outcome?: "completed" | "not_executed";
      },
    ) =>
      this.write(input, "operations.resolve", input, (tx) => {
        return task({ self: this }, function* () {
          assert(input.resolution.trim(), "reason_required");
          const row = yield* tx.get<Work>("work", input.operationId);
          assert(row?.state === "reconciliation", "operation_not_reconcilable");
          yield* put(
            tx,
            "work",
            row.id,
            {
              ...row.data,
              status: "done",
              result: input.result ?? {
                resolution: input.resolution,
                outcome: input.outcome ?? "completed",
              },
            },
            "done",
          );
          for (const intent of yield* tx.list<{
            operationId?: string;
            expiresAt?: number;
          }>("counters"))
            if (
              input.outcome === "not_executed" &&
              intent.id.startsWith("checkout:") &&
              intent.data.operationId === row.id
            )
              yield* put(tx, "counters", intent.id, {
                ...intent.data,
                expiresAt: 0,
              });
          if (
            input.outcome === "not_executed" &&
            row.data.kind === "auto_topup"
          ) {
            const counter = String(row.data.payload.counter);
            const current = (yield* tx.get<{
              pending?: string;
              count: number;
            }>("counters", counter))?.data;
            if (current?.pending === row.id) {
              yield* put(tx, "counters", counter, { count: current.count });
              yield* put(tx, "counters", "topup-pending", {});
            }
          }
          yield* this.event(tx, input.customerId, "operation.resolved", input);
          return { resolved: true };
        });
      }),
  };
  readonly events = {
    page: (
      customerId: string,
      input: {
        cursor?: string;
        limit?: number;
      } = {},
    ) => this.page<unknown>(customerId, "events", input),
    list: (customerId: string) => {
      return task({ self: this }, function* () {
        return (yield* this.events.page(customerId)).items;
      });
    },
  };
  readonly webhook = (request: Request) => {
    return task({ self: this }, function* () {
      assert(this.options.provider, "provider_missing");
      const event = yield* this.options.provider.verify(request);
      if (!event) return { accepted: true };
      identifier(event.customerId);
      const scope = this.scope(event.customerId);
      yield* this.store.atomic(scope, (tx) => {
        return task({ self: this }, function* () {
          if (yield* tx.get("inbox", event.id)) return;
          yield* this.customer(tx, event.customerId);
          yield* put(tx, "inbox", event.id, event, "pending");
          yield* this.enqueue(tx, `webhook:${event.id}`, "webhook", {
            event,
          });
        });
      });
      return { accepted: true };
    });
  };
  private runWork(scope: string, id: string): BillingEffect<boolean> {
    return task({ self: this }, function* () {
      const token = crypto.randomUUID();
      const work = yield* this.store.atomic(scope, (tx) => {
        return task({ self: this }, function* () {
          const row = yield* tx.get<Work>("work", id);
          if (
            !row ||
            row.state === "done" ||
            row.state === "reconciliation" ||
            row.data.availableAt > this.now() ||
            (row.state === "processing" &&
              (row.data.leaseUntil ?? 0) > this.now())
          )
            return null;
          const lane = (yield* tx.get<{
            owner: string;
            until: number;
            operationId?: string;
          }>("counters", "provider-lane"))?.data;
          if (!["event", "workflow_timeout"].includes(row.data.kind) && lane) {
            if (lane.until > this.now()) return null;
            if (lane.operationId && lane.operationId !== id) {
              const interrupted = yield* tx.get<Work>("work", lane.operationId);
              if (interrupted?.state === "processing") return null;
            }
          }
          if (row.data.kind === "subscription_update") {
            const outstanding = (yield* Effect.all(
              [
                tx.list<Work>("work", "meter_pending"),
                tx.list<Work>("work", "meter_failed"),
                tx.list<Work>("work", "pending"),
                tx.list<Work>("work", "failed"),
                tx.list<Work>("work", "processing"),
                tx.list<Work>("work", "reconciliation"),
              ],
              { concurrency: 1 },
            ))
              .flat()
              .some(
                (w) =>
                  w.data.kind === "meter" &&
                  w.data.payload.subscriptionId ===
                    row.data.payload.subscriptionId,
              );
            if (outstanding) return null;
          }
          if (!["event", "workflow_timeout"].includes(row.data.kind))
            yield* put(tx, "counters", "provider-lane", {
              owner: token,
              operationId: id,
              until: this.now() + 120000,
            });
          const next = {
            ...row.data,
            status: "processing" as const,
            attempts: row.data.attempts + 1,
            leaseOwner: token,
            leaseUntil: this.now() + 120000,
          };
          yield* put(tx, "work", id, next, "processing");
          return next;
        });
      });
      if (!work) return false;
      let result: unknown;
      return yield* recover(
        task({ self: this }, function* () {
          const customerId = scope.slice(`${this.environment}:c:`.length);
          if (work.kind === "event") {
            yield* this.options.hooks?.onEvent?.(
              work.payload as unknown as Parameters<
                NonNullable<EffectHooks["onEvent"]>
              >[0],
            ) ?? Effect.void;
            result = { delivered: true };
          } else if (work.kind === "workflow_timeout") {
            yield* this.store.atomic(scope, (tx) => {
              return task({ self: this }, function* () {
                yield* this.ledger.materialize(tx);
                yield* this.workflows.timeout(
                  tx,
                  customerId,
                  String(work.payload.workflowId),
                  work.payload.token as string | undefined,
                );
              });
            });
            result = { checked: true };
          } else if (work.kind === "webhook") {
            assert(this.options.provider, "provider_missing");
            const reconciled = yield* this.options.provider.reconcile(
              work.payload.event as ProviderEvent,
            );
            yield* this.applyProviderEvent(scope, reconciled);
            result = { applied: true };
          } else {
            assert(this.options.provider, "provider_missing");
            if (this.now() - work.createdAt > 23 * 60 * 60000)
              return yield* fail(
                new BillingError(
                  "reconciliation_required",
                  "Provider operation is outside the safe retry window.",
                ),
              );
            let input = work.payload;
            if (work.kind === "auto_topup")
              input = {
                ...input,
                plan: yield* this.catalog.get(String(input.planId)),
              };
            const customer = yield* this.customers.get(customerId);
            if (work.kind === "meter") {
              const checkpoint = yield* this.store.read(scope, (tx) => {
                return task(function* () {
                  return (
                    (yield* tx.get<{
                      minor: string;
                      generation: number;
                    }>("counters", `meter-export:${String(input.meterKey)}`))
                      ?.data ?? { minor: "0", generation: 0 }
                  );
                });
              });
              input = { ...input, previousMinor: checkpoint.minor };
              if (Number(input.generation) <= checkpoint.generation)
                result = { skipped: true };
              else
                result = yield* this.options.provider.execute({
                  id: yield* this.providerIdentity(scope, work.id),
                  kind: work.kind,
                  resources: this.resourceStore,
                  customer,
                  input,
                });
            } else
              result = yield* this.options.provider.execute({
                id: yield* this.providerIdentity(scope, work.id),
                kind: work.kind,
                resources: this.resourceStore,
                customer,
                input,
              });
          }
          if (result && typeof result === "object" && "providerEvent" in result)
            yield* this.applyProviderEvent(
              scope,
              result.providerEvent as ProviderEvent,
            );
          yield* this.store.atomic(scope, (tx) => {
            return task({ self: this }, function* () {
              const current = (yield* tx.get<Work>("work", id))!.data;
              assert(current.leaseOwner === token, "lease_lost");
              if (!["event", "workflow_timeout"].includes(work.kind))
                yield* put(tx, "counters", "provider-lane", {
                  owner: token,
                  until: 0,
                });
              if (
                work.kind === "meter" &&
                result &&
                typeof result === "object" &&
                "exportedMinor" in result
              )
                yield* put(
                  tx,
                  "counters",
                  `meter-export:${String(work.payload.meterKey)}`,
                  {
                    minor: String(result.exportedMinor),
                    generation: Number(work.payload.generation),
                  },
                );
              yield* put(
                tx,
                "work",
                id,
                { ...current, status: "done", result, leaseUntil: undefined },
                "done",
              );
              if (
                result &&
                typeof result === "object" &&
                "stripeCustomerId" in result
              ) {
                const c = yield* this.customer(tx, customerId);
                const linked = String(result.stripeCustomerId);
                assert(
                  !c.stripeCustomerId || c.stripeCustomerId === linked,
                  "customer_mapping_conflict",
                );
                yield* put(tx, "customers", c.id, {
                  ...c,
                  stripeCustomerId: linked,
                });
              }
              if (work.kind === "webhook") {
                const event = work.payload.event as ProviderEvent;
                yield* put(tx, "inbox", event.id, event, "done");
              }
            });
          });
          return true;
        }),
        (error) =>
          task({ self: this }, function* () {
            yield* this.store.atomic(scope, (tx) => {
              return task({ self: this }, function* () {
                const current = (yield* tx.get<Work>("work", id))!.data;
                if (current.leaseOwner !== token) return;
                if (!["event", "workflow_timeout"].includes(work.kind))
                  yield* put(tx, "counters", "provider-lane", {
                    owner: token,
                    until: 0,
                  });
                const reconciliation =
                  error instanceof BillingError &&
                  error.code === "reconciliation_required";
                const status = reconciliation ? "reconciliation" : "failed";
                yield* put(
                  tx,
                  "work",
                  id,
                  {
                    ...current,
                    status,
                    error:
                      error instanceof BillingError
                        ? error.code
                        : "provider_error",
                    availableAt:
                      this.now() +
                      Math.min(2 ** current.attempts * 1000, 3600000),
                    leaseUntil: undefined,
                  },
                  status,
                );
              });
            });
            return false;
          }),
      );
    });
  }
  private applyProviderEvent(scope: string, event: ProviderEvent) {
    return task({ self: this }, function* () {
      const planData = event.data.plan as PublishedPlan | undefined;
      const plan =
        planData ??
        (event.data.planId
          ? yield* this.catalog.get(
              String(event.data.planId),
              event.data.planVersion as string | undefined,
            )
          : undefined);
      yield* this.store.atomic(scope, (tx) => {
        return task({ self: this }, function* () {
          if (yield* tx.get("counters", `applied:${event.id}`)) return;
          if (event.data.subscription && plan) {
            const subscription = event.data.subscription as Omit<
              Subscription,
              "plan"
            >;
            const existing = (yield* tx.get<Subscription>(
              "subscriptions",
              subscription.id,
            ))?.data;
            yield* registerFeatures(tx, plan);
            const effectivePlan =
              event.data.pending && existing ? existing.plan : plan;
            const next: Subscription = {
              ...subscription,
              plan: {
                ...effectivePlan,
                stripeMeterPriceIds:
                  (event.data.meterPriceIds as
                    | Record<string, string>
                    | undefined) ?? effectivePlan.stripeMeterPriceIds,
              },
            };
            if (existing?.periodStart === next.periodStart) {
              next.provisioningOffset = existing.provisioningOffset;
              if (
                (existing.plan.version !== next.plan.version ||
                  existing.quantity !== next.quantity) &&
                next.paidThrough > this.now()
              ) {
                let until = next.periodEnd;
                const granted: Record<string, string> = Object.create(null);
                for (const { data: g } of yield* tx.list<Grant>(
                  "grants",
                  "active",
                )) {
                  if (
                    g.sourceId === next.id &&
                    g.origin === "subscription" &&
                    (g.expiresAt ?? Infinity) > this.now()
                  ) {
                    granted[g.feature] = decimal(
                      units(granted[g.feature] ?? "0") + units(g.amount),
                    );
                    until = Math.min(until, g.expiresAt ?? Infinity);
                  }
                }
                next.provisioningOffset = { until, granted };
              }
            }
            // Reconciliation reads current provider state. Preserve verified payment evidence.
            if (existing)
              next.paidThrough = Math.max(
                existing.paidThrough,
                next.paidThrough,
              );
            if (
              next.status === "past_due" &&
              existing?.paidThrough &&
              next.plan.graceDays
            )
              next.graceThrough =
                existing.paidThrough + next.plan.graceDays * 86400000;
            if (existing?.status === "trialing" && next.status === "active")
              for (const grant of yield* tx.list<Grant>("grants", "active"))
                if (
                  grant.data.sourceId === next.id &&
                  grant.data.origin === "subscription"
                )
                  yield* put(tx, "grants", grant.id, grant.data, "expired");
            if (
              ["active", "trialing"].includes(next.status) &&
              !next.plan.addOn
            )
              for (const row of yield* tx.list<Subscription>(
                "subscriptions",
                "active",
              ))
                if (
                  row.id !== next.id &&
                  row.data.entityId === next.entityId &&
                  !row.data.plan.addOn &&
                  (row.data.plan.group ?? "base") ===
                    (next.plan.group ?? "base")
                )
                  yield* put(
                    tx,
                    "subscriptions",
                    row.id,
                    { ...row.data, status: "ended" },
                    "ended",
                  );
            yield* put(
              tx,
              "subscriptions",
              next.id,
              next,
              isEntitled(next, this.now()) ? "active" : next.status,
            );
            yield* this.ledger.materialize(tx);
          }
          if (event.type === "purchase.paid" && plan) {
            assert(plan.kind === "one_time", "invalid_purchase_plan");
            const id = yield* hash({ purchaseId: event.data.purchaseId });
            const existing = yield* tx.get<Subscription>("subscriptions", id);
            const quantity = String(event.data.quantity ?? "1");
            positive(quantity);
            if (existing)
              assert(
                existing.data.quantity === quantity &&
                  existing.data.plan.version === plan.version,
                "purchase_conflict",
              );
            else {
              const purchase: Subscription = {
                id,
                purchaseId: String(event.data.purchaseId),
                entityId: event.data.entityId as string | undefined,
                plan,
                status: "active",
                periodStart: this.now(),
                periodEnd: Number.MAX_SAFE_INTEGER,
                paidThrough: Number.MAX_SAFE_INTEGER,
                quantity,
              };
              yield* registerFeatures(tx, plan);
              yield* put(tx, "subscriptions", id, purchase);
            }
            yield* this.ledger.materialize(tx);
            const counter = event.data.topupCounter as string | undefined;
            if (counter) {
              const old = (yield* tx.get<{
                count: number;
                pending?: string;
              }>("counters", counter))?.data;
              if (
                old?.pending &&
                (yield* this.providerIdentity(scope, old.pending)) ===
                  event.data.purchaseId
              ) {
                yield* put(tx, "counters", counter, { count: old.count });
                const pending = (yield* tx.get<{
                  operationId?: string;
                }>("counters", "topup-pending"))?.data.operationId;
                if (pending === old.pending)
                  yield* put(tx, "counters", "topup-pending", {});
              }
            }
          }
          if (event.type === "payment.reconciliation") {
            if (event.data.purchaseId)
              for (const row of yield* tx.list<Grant>("grants", "active"))
                if (row.data.sourceId === event.data.purchaseId)
                  yield* put(tx, "grants", row.id, row.data, "review");
            const id = crypto.randomUUID();
            yield* this.enqueue(tx, id, "payment_adjustment", event.data);
            const w = (yield* tx.get<Work>("work", id))!.data;
            yield* put(
              tx,
              "work",
              id,
              { ...w, status: "reconciliation" },
              "reconciliation",
            );
          }
          if (event.type === "purchase.reversed") {
            for (const row of yield* tx.list<Subscription>(
              "subscriptions",
              "active",
            ))
              if (row.data.purchaseId === event.data.purchaseId)
                yield* put(
                  tx,
                  "subscriptions",
                  row.id,
                  { ...row.data, status: "ended" },
                  "ended",
                );
            for (const row of yield* tx.list<Grant>("grants", "active"))
              if (row.data.sourceId === event.data.purchaseId) {
                const p = yield* this.ledger.position(tx, row.id);
                const unused =
                  units(row.data.amount) - units(p.spent) - units(p.held);
                if (unused > 0n)
                  yield* this.ledger.movement(
                    tx,
                    row.id,
                    unused,
                    event.id,
                    "purchase_refunded",
                  );
                yield* put(tx, "grants", row.id, row.data, "revoked");
                if (units(p.spent) > 0n) {
                  const id = crypto.randomUUID();
                  yield* this.enqueue(tx, id, "refund_adjustment", {
                    purchaseId: event.data.purchaseId,
                    spent: p.spent,
                  });
                  const w = (yield* tx.get<Work>("work", id))!.data;
                  yield* put(
                    tx,
                    "work",
                    id,
                    { ...w, status: "reconciliation" },
                    "reconciliation",
                  );
                }
              }
          }
          yield* put(tx, "counters", `applied:${event.id}`, {
            appliedAt: this.now(),
          });
          yield* this.event(tx, event.customerId, event.type, {
            providerEventId: event.id,
          });
        });
      });
    });
  }
  readonly maintenance = {
    run: (
      input: { limit?: number; customerId?: string; cursor?: string } = {},
    ) => {
      return task({ self: this }, function* () {
        const limit = input.limit ?? 100;
        assert(
          Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
          "invalid_limit",
        );
        const cursor =
          input.cursor ??
          (yield* this.store.read(this.catalogScope(), (tx) => {
            return task(function* () {
              return (yield* tx.get<{
                cursor: string;
              }>("counters", "maintenance-cursor"))?.data.cursor;
            });
          })) ??
          "";
        const scopes = input.customerId
          ? [this.scope(input.customerId)]
          : yield* this.store.scopes(cursor, limit, `${this.environment}:c:`);
        let processed = 0,
          more = false,
          lastScope = cursor;
        for (const scope of scopes) {
          lastScope = scope;
          yield* this.store.atomic(scope, (tx) => {
            return task({ self: this }, function* () {
              yield* this.ledger.materialize(tx);
              const customerId = scope.slice(`${this.environment}:c:`.length);
              const customer = (yield* tx.get<Customer>(
                "customers",
                customerId,
              ))?.data;
              if (customer?.controls.autoTopUp)
                yield* this.afterUsage(
                  tx,
                  customerId,
                  customer.controls.autoTopUp.feature,
                );
            });
          });
          const candidates = yield* this.store.read(scope, (tx) => {
            return task({ self: this }, function* () {
              return (yield* Effect.all(
                [
                  "processing",
                  "internal_pending",
                  "internal_failed",
                  "meter_pending",
                  "meter_failed",
                  "pending",
                  "failed",
                ].map((state) =>
                  tx.page<Work>("work", {
                    state,
                    limit,
                    dueBefore: this.now(),
                  }),
                ),
                { concurrency: 1 },
              ))
                .flat()
                .filter(
                  (r) =>
                    ["pending", "failed", "processing"].includes(
                      r.data.status,
                    ) &&
                    r.data.availableAt <= this.now() &&
                    (r.data.leaseUntil ?? 0) <= this.now(),
                )
                .map((r) => r.id);
            });
          });
          for (const id of candidates) {
            if (processed >= limit) {
              more = true;
              break;
            }
            yield* this.runWork(scope, id);
            processed++;
          }
          if (processed >= limit) {
            more = true;
            break;
          }
        }
        const nextCursor = scopes.length === limit || more ? lastScope : "";
        if (!input.customerId && input.cursor === undefined)
          yield* this.store.atomic(this.catalogScope(), (tx) =>
            put(tx, "counters", "maintenance-cursor", { cursor: nextCursor }),
          );
        return {
          processed,
          more: more || scopes.length === limit,
          cursor: nextCursor,
        };
      });
    },
  };
  readonly migration = {
    linkSubscription: (
      input: WriteInput & {
        stripeSubscriptionId: string;
        planId: string;
      },
    ) => {
      return task({ self: this }, function* () {
        return yield* this.payment(input, "subscription_import", {
          ...input,
          plan: yield* this.catalog.get(input.planId),
        });
      });
    },
    export: (customerId: string): BillingEffect<ExportSnapshot> => {
      return task({ self: this }, function* () {
        return yield* this.store.atomic(this.scope(customerId), (tx) => {
          return task({ self: this }, function* () {
            const subscriptions = (yield* tx.list<Subscription>(
              "subscriptions",
            )).map((r) => r.data);
            const grantRows = yield* tx.list<Grant>("grants");
            const grants = grantRows.map((r) => r.data);
            const work = (yield* tx.list<Work>("work")).map((r) => r.data);
            const workflows = yield* tx.list<{
              status: string;
            }>("workflows");
            const usage = (yield* tx.list<Usage>("usage"))
              .filter((r) => r.state !== "reversed")
              .map((r) => r.data);
            const blockers = work
              .filter(
                (w) =>
                  w.status !== "done" &&
                  !["event", "workflow_timeout"].includes(w.kind),
              )
              .map((w) => `operation:${w.id}`);
            for (const row of workflows)
              if (["active", "reconciliation"].includes(row.state))
                blockers.push(`active_workflow:${row.id}`);
            if (
              usage.some(
                (u) =>
                  u.currency &&
                  units(u.charged) !== 0n &&
                  subscriptions.some(
                    (sub) =>
                      u.createdAt >= sub.periodStart &&
                      u.createdAt < sub.periodEnd,
                  ),
              )
            )
              blockers.push("open_postpaid_period");
            const policyCounters = (yield* tx.list<unknown>("counters")).filter(
              (r) =>
                r.id === "trial-claimed" ||
                r.id.startsWith("topup:") ||
                r.id === "topup-pending",
            );
            if (
              (yield* tx.get<{
                operationId?: string;
              }>("counters", "topup-pending"))?.data.operationId
            )
              blockers.push("pending_topup_confirmation");
            const archive: Partial<Record<Table, Row[]>> = {};
            for (const table of [
              "customers",
              "entities",
              "subscriptions",
              "grants",
              "movements",
              "reservations",
              "usage",
              "operations",
              "inbox",
              "work",
              "events",
              "audit",
              "counters",
              "licenses",
              "workflows",
            ] as const)
              archive[table] = yield* tx.list(table);
            return {
              archive,
              grantStates: Object.fromEntries(
                grantRows.map((row) => [row.id, row.state]),
              ),
              policyCounters,
              format: 1 as const,
              environment: this.environment,
              customer: yield* this.customer(tx, customerId),
              entities: (yield* tx.list<Entity>("entities")).map((r) => r.data),
              grants,
              positions: yield* Effect.all(
                grants.map((g) => {
                  return task({ self: this }, function* () {
                    return {
                      grantId: g.id,
                      ...(yield* this.ledger.position(tx, g.id)),
                    };
                  });
                }),
                { concurrency: 1 },
              ),
              subscriptions,
              reservations: (yield* tx.list<Reservation>(
                "reservations",
                "held",
              )).map((r) => r.data),
              licenses: (yield* tx.list<ImportedLicense>(
                "licenses",
                "active",
              )).map((r) => r.data),
              quantities: (yield* tx.list<ImportedQuantity["data"]>("counters"))
                .filter((r) => r.id.startsWith("quantity:"))
                .map((r) => ({ id: r.id, data: r.data })),
              blockers,
            };
          });
        });
      });
    },
    import: (input: {
      snapshot: ExportSnapshot;
      idempotencyKey: string;
      dryRun?: boolean;
    }) => {
      return task({ self: this }, function* () {
        const s = input.snapshot;
        assert(
          s.format === 1 && s.environment === this.environment,
          "invalid_snapshot",
        );
        identifier(s.customer.id);
        assert(
          new Set(s.grants.map((g) => g.id)).size === s.grants.length &&
            s.positions.length === s.grants.length,
          "invalid_snapshot",
        );
        for (const g of s.grants) {
          nonnegative(g.amount);
          const p = s.positions.find((p) => p.grantId === g.id);
          assert(
            p && nonnegative(p.spent) + nonnegative(p.held) <= units(g.amount),
            "invalid_snapshot",
          );
        }
        const blockers = [...(s.blockers ?? [])];
        if (
          s.reservations.length > 0 ||
          s.positions.some((p) => units(p.held) !== 0n)
        )
          blockers.push("active_reservations");
        if (input.dryRun)
          return {
            customerId: s.customer.id,
            grants: s.grants.length,
            dryRun: true,
            blockers,
          };
        assert(
          blockers.length === 0,
          "migration_requires_reconciliation",
          undefined,
        );
        return yield* this.write(
          {
            customerId: s.customer.id,
            idempotencyKey: `import:${yield* hash(input.idempotencyKey)}`,
          },
          "migration.import",
          s,
          (tx) => {
            return task({ self: this }, function* () {
              assert(
                !(yield* tx.get("customers", s.customer.id)),
                "import_customer_exists",
              );
              if (s.archive) {
                const allowed = new Set<Table>([
                  "customers",
                  "entities",
                  "subscriptions",
                  "grants",
                  "movements",
                  "reservations",
                  "usage",
                  "operations",
                  "inbox",
                  "work",
                  "events",
                  "audit",
                  "counters",
                  "licenses",
                  "workflows",
                ]);
                assert(
                  s.archive.customers?.length === 1 &&
                    s.archive.customers[0]?.id === s.customer.id &&
                    canonical(s.archive.customers[0]?.data) ===
                      canonical(s.customer),
                  "invalid_snapshot",
                );
                for (const [table, rows] of Object.entries(s.archive)) {
                  assert(
                    allowed.has(table as Table) && Array.isArray(rows),
                    "invalid_snapshot",
                  );
                  for (const row of rows) {
                    assert(
                      typeof row.id === "string" &&
                        typeof row.state === "string",
                      "invalid_snapshot",
                    );
                    yield* tx.put(table as Table, row);
                  }
                }
              } else {
                yield* put(tx, "customers", s.customer.id, s.customer);
                for (const e of s.entities) yield* put(tx, "entities", e.id, e);
                for (const g of s.grants) {
                  yield* put(
                    tx,
                    "grants",
                    g.id,
                    g,
                    s.grantStates?.[g.id] ?? "active",
                  );
                  const p = s.positions.find((p) => p.grantId === g.id)!;
                  if (units(p.spent) > 0n)
                    yield* this.ledger.movement(
                      tx,
                      g.id,
                      units(p.spent),
                      input.idempotencyKey,
                      "import_opening_balance",
                    );
                }
                for (const counter of s.policyCounters ?? [])
                  yield* put(
                    tx,
                    "counters",
                    counter.id,
                    counter.data,
                    counter.state,
                  );
                for (const license of s.licenses ?? [])
                  yield* put(tx, "licenses", license.id, license);
                for (const quantity of s.quantities ?? [])
                  yield* put(tx, "counters", quantity.id, quantity.data);
                for (const sub of s.subscriptions) {
                  yield* registerFeatures(tx, sub.plan);
                  yield* put(
                    tx,
                    "subscriptions",
                    sub.id,
                    sub,
                    ["active", "trialing"].includes(sub.status)
                      ? "active"
                      : sub.status,
                  );
                }
              }
              assert(
                (yield* this.ledger.reconcile(tx)).consistent,
                "invalid_snapshot_ledger",
              );
              return {
                customerId: s.customer.id,
                grants: s.grants.length,
                dryRun: false,
              };
            });
          },
          true,
        );
      });
    },
  };
}
type ImportedLicense = {
  id: string;
  entityId: string;
  feature: string;
  allocations: Allocation[];
};
type ImportedQuantity = {
  id: string;
  data: {
    amount: string;
    allocations: Allocation[];
  };
};
export type ExportSnapshot = {
  archive?: Partial<Record<Table, Row[]>>;
  grantStates?: Record<string, string>;
  policyCounters?: {
    id: string;
    state: string;
    data: unknown;
  }[];
  licenses?: ImportedLicense[];
  quantities?: ImportedQuantity[];
  blockers?: string[];
  format: 1;
  environment: Environment;
  customer: Customer;
  entities: Entity[];
  grants: Grant[];
  positions: {
    grantId: string;
    spent: string;
    held: string;
  }[];
  subscriptions: Subscription[];
  reservations: Reservation[];
};
