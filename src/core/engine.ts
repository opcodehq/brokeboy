import {
  put,
  type Row,
  type Storage,
  type Table,
  type Transaction,
} from "../storage/contract.js";
import {
  type ResourceManager,
  resourceRegistry,
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
import { assert, BillingError, identifier, timestamp } from "./errors.js";
import {
  allocationEntity,
  isEntitled,
  Ledger,
  registerFeatures,
} from "./ledger.js";
import type {
  Allocation,
  Balance,
  Catalog,
  Controls,
  Customer,
  Entity,
  Environment,
  Grant,
  Hooks,
  Metadata,
  PaymentProvider,
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
export type BillingOptions = {
  database: Storage;
  environment?: Environment;
  provider?: PaymentProvider;
  now?: () => number;
  hooks?: Hooks;
};

type SavedOperation = { hash: string; result: unknown; createdAt: number };
export function brokeboy(options: BillingOptions) {
  return new Billing(options);
}
export class Billing {
  private readonly store: Storage;
  private readonly now: () => number;
  private readonly ledger: Ledger;
  private readonly resourceStore: ResourceManager;
  readonly environment: Environment;
  constructor(private readonly options: BillingOptions) {
    this.store = options.database;
    this.now = options.now ?? Date.now;
    this.ledger = new Ledger(this.now);
    this.environment = options.environment ?? "test";
    this.resourceStore = resourceRegistry(
      this.store,
      this.environment,
      this.now,
    );
    assert(["test", "live"].includes(this.environment), "invalid_environment");
  }
  private scope(customerId: string) {
    return `${this.environment}:c:${identifier(customerId)}`;
  }
  private catalogScope() {
    return `${this.environment}:catalog`;
  }
  private async write<T>(
    input: WriteInput,
    method: string,
    payload: unknown,
    run: (tx: Transaction, operation: string) => Promise<T>,
    create = false,
  ): Promise<T> {
    const digest = await hash({ method, payload });
    const key = identifier(input.idempotencyKey);
    return this.store.atomic(this.scope(input.customerId), async (tx) => {
      const previous = await tx.get<SavedOperation>("operations", key);
      if (previous) {
        assert(previous.data.hash === digest, "idempotency_conflict");
        return previous.data.result as T;
      }
      if (!create)
        assert(
          await tx.get("customers", input.customerId),
          "customer_not_found",
        );
      if (input.entityId)
        assert(
          await tx.get("entities", identifier(input.entityId)),
          "entity_not_found",
        );
      const result = JSON.parse(JSON.stringify(await run(tx, key))) as T;
      await put(tx, "operations", key, {
        hash: digest,
        result,
        createdAt: this.now(),
      });
      return result;
    });
  }
  private async customer(tx: Transaction, id: string) {
    const row = await tx.get<Customer>("customers", id);
    assert(row, "customer_not_found");
    return row.data;
  }
  private async event(
    tx: Transaction,
    customerId: string,
    type: string,
    data: unknown,
  ) {
    const id = crypto.randomUUID();
    const event = { id, type, customerId, data, createdAt: this.now() };
    await put(tx, "events", id, event);
    await put(tx, "audit", id, {
      id,
      type,
      customerId,
      createdAt: this.now(),
      data,
    });
    if (this.options.hooks?.onEvent)
      await this.enqueue(tx, `event:${id}`, "event", event);
  }
  private async enqueue(
    tx: Transaction,
    id: string,
    kind: string,
    payload: Record<string, unknown>,
  ) {
    if (await tx.get("work", id)) return;
    await put(
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
  }
  readonly resources = {
    inspect: (key: string) => this.resourceStore.inspect(key),
    reconcile: async (input: { key: string; id: string; reason: string }) => {
      assert(
        this.options.provider?.verifyResource,
        "resource_verification_required",
      );
      await this.options.provider.verifyResource(input.key, input.id);
      return this.resourceStore.resolve(input.key, input.id, input.reason);
    },
  };
  readonly catalog = {
    validate: (catalog: Catalog) => validateCatalog(catalog),
    export: async () =>
      this.store.atomic(this.catalogScope(), async (tx) => {
        const versions = (
          await tx.list<PublishedPlan>("catalog", "published")
        ).map((row) => row.data);
        const pointers = new Set(
          (await tx.list<{ version: string }>("catalog", "pointer")).map(
            (row) => row.data.version,
          ),
        );
        return {
          revision:
            (await tx.get<{ revision: number }>("catalog", "head"))?.data
              .revision ?? 0,
          features:
            (await tx.get<Catalog["features"]>("catalog", "features"))?.data ??
            [],
          plans: versions.filter((plan) => pointers.has(plan.version)),
          versions,
        };
      }),
    diff: async (catalog: Catalog) => {
      validateCatalog(catalog);
      const current = await this.catalog.export();
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
        if (canonical(old) !== canonical(normalizePlan(plan, catalog.features)))
          changes.push({
            planId: plan.id,
            action: previous ? "version" : "create",
          });
      }
      return { expectedRevision: current.revision, changes };
    },
    publish: async (input: { catalog: Catalog; expectedRevision: number }) => {
      validateCatalog(input.catalog);
      const digest = await hash({
        ...input.catalog,
        plans: input.catalog.plans.map((plan) =>
          normalizePlan(plan, input.catalog.features),
        ),
      });
      return this.store.atomic(this.catalogScope(), async (tx) => {
        const head = (
          await tx.get<{ revision: number; hash: string }>("catalog", "head")
        )?.data;
        if (head?.hash === digest) return { revision: head.revision };
        assert(
          (head?.revision ?? 0) === input.expectedRevision,
          "catalog_conflict",
        );
        const revision = input.expectedRevision + 1;
        for (const plan of input.catalog.plans) {
          const normalized = normalizePlan(plan, input.catalog.features);
          const version = await hash(normalized);
          if (!(await tx.get("catalog", version)))
            await put(
              tx,
              "catalog",
              version,
              { ...normalized, version, revision },
              "published",
            );
          await put(tx, "catalog", `plan:${plan.id}`, { version }, "pointer");
        }
        await put(
          tx,
          "catalog",
          "features",
          input.catalog.features,
          "features",
        );
        await put(tx, "catalog", "head", { revision, hash: digest }, "head");
        return { revision };
      });
    },
    get: async (id: string, version?: string): Promise<PublishedPlan> =>
      this.store.read(this.catalogScope(), async (tx) => {
        const target =
          version ??
          (
            await tx.get<{ version: string }>(
              "catalog",
              `plan:${identifier(id)}`,
            )
          )?.data.version;
        assert(target, "plan_not_found");
        const plan = await tx.get<PublishedPlan>("catalog", target);
        assert(plan?.data.id === id, "plan_not_found");
        return plan.data;
      }),
    migrate: async (
      input: WriteInput & {
        subscriptionId: string;
        planId: string;
        effective?: "now" | "period_end";
      },
    ) => this.subscriptions.update(input),
    custom: async (input: { plan: Plan; expectedRevision: number }) => {
      const existing = await this.store.read(
        this.catalogScope(),
        async (tx) =>
          (await tx.get<Catalog["features"]>("catalog", "features"))?.data ??
          [],
      );
      return this.catalog.publish({
        catalog: {
          features: existing,
          plans: [{ ...input.plan, public: false }],
        },
        expectedRevision: input.expectedRevision,
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
        async (tx) => {
          const existing = await tx.get<Customer>("customers", input.id);
          if (existing) return existing.data;
          const customer: Customer = {
            id: input.id,
            metadata: input.metadata ?? {},
            stripeCustomerId: input.stripeCustomerId,
            controls: {},
          };
          await put(tx, "customers", input.id, customer);
          return customer;
        },
        true,
      ),
    get: (customerId: string) =>
      this.store.read(this.scope(customerId), (tx) =>
        this.customer(tx, customerId),
      ),
    update: (
      input: WriteInput & { metadata?: Metadata; stripeCustomerId?: string },
    ) =>
      this.write(input, "customers.update", input, async (tx) => {
        const customer = await this.customer(tx, input.customerId);
        assert(
          !input.stripeCustomerId ||
            !customer.stripeCustomerId ||
            customer.stripeCustomerId === input.stripeCustomerId,
          "customer_mapping_conflict",
        );
        const updated = {
          ...customer,
          metadata: input.metadata ?? customer.metadata,
          stripeCustomerId: input.stripeCustomerId ?? customer.stripeCustomerId,
        };
        await put(tx, "customers", customer.id, updated);
        return updated;
      }),
  };
  readonly entities = {
    create: (input: WriteInput & { id: string; metadata?: Metadata }) =>
      this.write(
        { ...input, entityId: undefined },
        "entities.create",
        input,
        async (tx) => {
          const entity = {
            id: identifier(input.id),
            metadata: input.metadata ?? {},
          };
          assert(!(await tx.get("entities", input.id)), "entity_exists");
          await put(tx, "entities", input.id, entity);
          return entity;
        },
      ),
    list: (customerId: string) =>
      this.store.read(this.scope(customerId), async (tx) =>
        (await tx.list<Entity>("entities")).map((row) => row.data),
      ),
    update: (input: WriteInput & { id: string; metadata: Metadata }) =>
      this.write(input, "entities.update", input, async (tx) => {
        assert(await tx.get("entities", input.id), "entity_not_found");
        const entity = { id: input.id, metadata: input.metadata };
        await put(tx, "entities", input.id, entity);
        return entity;
      }),
  };
  private async subscriptionsIn(tx: Transaction, entityId?: string) {
    return (await tx.list<Subscription>("subscriptions", "active"))
      .map((row) => row.data)
      .filter((s) => s.entityId === entityId && isEntitled(s, this.now()));
  }
  private async item(
    tx: Transaction,
    feature: string,
    entityId?: string,
  ): Promise<{ item: PlanItem; subscription: Subscription } | undefined> {
    const found = (await this.subscriptionsIn(tx, entityId)).flatMap(
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
    return priced[0] ?? found.find((f) => f.item.enabled === true) ?? found[0];
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
      this.write(input, "credits.grant", input, async (tx, key) => {
        positive(input.amount);
        assert(Number.isSafeInteger(input.priority ?? 0), "invalid_priority");
        identifier(input.feature);
        if (input.expiresAt !== undefined)
          assert(timestamp(input.expiresAt) > this.now(), "invalid_expiry");
        const grant: Grant = {
          id: await hash({ key, feature: input.feature }),
          feature: input.feature,
          entityId: input.entityId,
          amount: input.amount,
          expiresAt: input.expiresAt,
          priority: input.priority ?? 0,
          origin: input.origin ?? "manual",
          sourceId: input.sourceId ?? key,
          createdAt: this.now(),
        };
        await this.ledger.grant(tx, grant);
        await this.event(tx, input.customerId, "credits.granted", grant);
        return grant;
      }),
    balance: (input: ScopeInput & { feature: string }) =>
      this.store.atomic(this.scope(input.customerId), async (tx) => {
        await this.customer(tx, input.customerId);
        await this.ledger.materialize(tx);
        const mapped = await this.item(tx, input.feature, input.entityId);
        return this.balanceFor(
          tx,
          mapped?.item.pool ?? input.feature,
          allocationEntity(mapped?.item, input.entityId),
        );
      }),
    list: (input: ScopeInput) =>
      this.store.read(this.scope(input.customerId), async (tx) =>
        (await tx.list<Grant>("grants"))
          .map((r) => r.data)
          .filter((g) => g.entityId === input.entityId),
      ),
    adjust: (
      input: WriteInput & { grantId: string; amount: string; reason: string },
    ) =>
      this.write(input, "credits.adjust", input, async (tx, key) => {
        assert(input.reason.trim().length > 0, "reason_required");
        const grant = (await tx.get<Grant>("grants", input.grantId))?.data;
        assert(grant, "grant_not_found");
        const amount = units(input.amount);
        const p = await this.ledger.position(tx, grant.id);
        assert(
          units(p.spent) + amount >= 0n &&
            units(p.spent) + units(p.held) + amount <= units(grant.amount),
          "invalid_adjustment",
        );
        await this.ledger.movement(tx, grant.id, amount, key, input.reason);
        await this.event(tx, input.customerId, "credits.adjusted", {
          grantId: grant.id,
          amount: input.amount,
          reason: input.reason,
        });
        return this.ledger.balance(tx, grant.feature, grant.entityId);
      }),
    reconcile: (customerId: string) =>
      this.store.atomic(this.scope(customerId), (tx) =>
        this.ledger.reconcile(tx),
      ),
  };
  readonly entitlements = {
    check: async (
      input: ScopeInput & {
        feature: string;
        amount?: string;
        properties?: Metadata;
      },
    ) =>
      this.store.atomic(this.scope(input.customerId), async (tx) => {
        await this.customer(tx, input.customerId);
        await this.ledger.materialize(tx);
        const mapped = await this.item(tx, input.feature, input.entityId);
        const balance = await this.balanceFor(
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
            ? await this.item(tx, target, payerEntity)
            : undefined;
        if (funding?.item.overage) {
          try {
            await this.quoteOverage(
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
          } catch (error) {
            if (
              error instanceof BillingError &&
              ["spend_limit_exceeded", "payment_setup_required"].includes(
                error.code,
              )
            )
              return { allowed: false, balance, reason: error.code };
            throw error;
          }
        }
        return {
          allowed:
            mapped?.item.enabled === true ||
            units(balance.available) >= required,
          balance,
        };
      }),
    list: (input: ScopeInput) =>
      this.store.read(this.scope(input.customerId), async (tx) =>
        (await this.subscriptionsIn(tx, input.entityId)).flatMap((s) =>
          s.plan.items.map((item) => ({
            ...item,
            planVersion: s.plan.version,
          })),
        ),
      ),
  };
  private async afterUsage(
    tx: Transaction,
    customerId: string,
    feature: string,
    entityId?: string,
  ) {
    const customer = await this.customer(tx, customerId);
    const balance = await this.balanceFor(tx, feature, entityId);
    for (const alert of customer.controls.alerts ?? [])
      if (
        alert.feature === feature &&
        units(balance.available) <= units(alert.remaining)
      ) {
        const id = `alert:${feature}:${alert.remaining}:${new Date(this.now()).toISOString().slice(0, 10)}`;
        if (!(await tx.get("counters", id))) {
          await put(tx, "counters", id, { sent: true });
          await this.event(tx, customerId, "balance.threshold", balance);
        }
      }
    const topup = customer.controls.autoTopUp;
    if (
      topup?.feature === feature &&
      units(balance.available) < units(topup.below)
    ) {
      const period = new Date(this.now()).toISOString().slice(0, 7),
        counter = `topup:${period}`;
      const previous = (
        await tx.get<{ count: number; pending?: string }>("counters", counter)
      )?.data ?? { count: 0 };
      const pending = (
        await tx.get<{ operationId?: string }>("counters", "topup-pending")
      )?.data.operationId;
      if (
        !pending &&
        !previous.pending &&
        previous.count < topup.maximumPurchases
      ) {
        const id = crypto.randomUUID();
        await put(tx, "counters", "topup-pending", { operationId: id });
        await put(tx, "counters", counter, {
          count: previous.count + 1,
          pending: id,
        });
        await this.enqueue(tx, id, "auto_topup", {
          planId: topup.packPlan,
          counter,
          customerId,
        });
      }
    }
  }
  private async quoteOverage(
    tx: Transaction,
    input: UsageInput,
    mapped: { item: PlanItem; subscription: Subscription },
  ) {
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
    const counterId = await hash({
      feature: input.feature,
      entityId: input.entityId,
      sub: sub.id,
      start: sub.periodStart,
      dimension: dimensions?.[0]?.match ?? {},
      version: sub.plan.version,
    });
    const previous = (
      await tx.get<{ quantity: string; cost: string }>("counters", counterId)
    )?.data ?? { quantity: "0", cost: "0" };
    const budgetKey = await hash({
      feature: input.feature,
      entityId: input.entityId,
      sub: sub.id,
      start: sub.periodStart,
    });
    const meterKey = await hash({ budgetKey, version: sub.plan.version });
    const versionAggregate = (
      await tx.get<{ total: string; generation: number }>(
        "counters",
        `meter-version:${meterKey}`,
      )
    )?.data ?? { total: "0", generation: 0 };
    const aggregate = (
      await tx.get<{ total: string; quantity: string; generation: number }>(
        "counters",
        `meter-total:${budgetKey}`,
      )
    )?.data ?? { total: "0", quantity: "0", generation: 0 };
    const available = units(
      (await this.ledger.balance(tx, input.feature, input.entityId)).available,
    );
    const covered = minimum(quantity, available),
      billable = quantity - covered,
      next = units(previous.quantity) + billable;
    const total = rateUsage(mapped.item.rate!, decimal(next), input.properties),
      charge = decimal(units(total) - units(previous.cost));
    const aggregateTotal = decimal(units(aggregate.total) + units(charge)),
      versionTotal = decimal(units(versionAggregate.total) + units(charge));
    const customer = await this.customer(tx, input.customerId),
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
  }
  private async consume(
    tx: Transaction,
    input: UsageInput,
    key: string,
  ): Promise<Usage> {
    await this.ledger.materialize(tx);
    const quantity = positive(input.amount);
    assert(
      (await this.quantityCapacity(tx, input.feature, input.entityId)) ===
        undefined,
      "quantity_requires_assignment",
    );
    const mapped = await this.item(tx, input.feature, input.entityId);
    const target = mapped?.item.pool ?? input.feature;
    const payerEntity = allocationEntity(mapped?.item, input.entityId);
    const funding = mapped?.item.overage
      ? mapped
      : mapped?.item.pool
        ? await this.item(tx, target, payerEntity)
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
      const q = await this.quoteOverage(tx, rated, funding);
      charge = q.charge;
      currency = q.sub.plan.currency ?? "usd";
      if (q.covered > 0n)
        allocations = await this.ledger.allocate(
          tx,
          target,
          q.covered,
          payerEntity,
          false,
          key,
        );
      await put(tx, "counters", q.counterId, {
        quantity: decimal(q.next),
        cost: q.total,
      });
      await put(tx, "counters", `meter-total:${q.budgetKey}`, {
        total: q.aggregateTotal,
        quantity: decimal(units(q.aggregate.quantity) + cost),
        generation: q.aggregate.generation + 1,
      });
      await put(tx, "counters", `meter-version:${q.meterKey}`, {
        total: q.versionTotal,
        generation: q.versionAggregate.generation + 1,
      });
      if (units(charge) !== 0n)
        await this.enqueue(tx, `usage:${key}`, "meter", {
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
      allocations = await this.ledger.allocate(
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
    await put(tx, "usage", usage.id, usage);
    await this.afterUsage(
      tx,
      input.customerId,
      target,
      allocationEntity(mapped?.item, input.entityId),
    );
    return usage;
  }
  private async page<T>(
    customerId: string,
    table: Table,
    input: { cursor?: string; limit?: number } = {},
  ) {
    const limit = input.limit ?? 100;
    assert(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
      "invalid_limit",
    );
    return this.store.read(this.scope(customerId), async (tx) => {
      const rows = await tx.page<T>(table, {
        after: input.cursor,
        limit: limit + 1,
      });
      return {
        items: rows.slice(0, limit).map((r) => r.data),
        nextCursor: rows.length > limit ? rows[limit - 1]!.id : undefined,
      };
    });
  }
  readonly usage = {
    page: async (input: ScopeInput & { cursor?: string; limit?: number }) => {
      const page = await this.page<Usage>(input.customerId, "usage", input);
      return {
        ...page,
        items: page.items.filter((u) => u.entityId === input.entityId),
      };
    },
    consume: (input: UsageInput) =>
      this.write(input, "usage.consume", input, (tx, key) =>
        this.consume(tx, input, key),
      ),
    record: (input: UsageInput) =>
      this.write(input, "usage.record", input, (tx, key) =>
        this.consume(tx, input, key),
      ),
    list: async (input: ScopeInput) => (await this.usage.page(input)).items,
    correct: (input: WriteInput & { usageId: string; reason: string }) =>
      this.write(input, "usage.correct", input, async (tx, key) => {
        assert(input.reason.trim(), "reason_required");
        const original = await tx.get<Usage>("usage", input.usageId);
        assert(original, "usage_not_found");
        assert(original.state !== "reversed", "already_corrected");
        if (original.data.currency && units(original.data.charged) !== 0n) {
          const workId = crypto.randomUUID();
          await this.enqueue(tx, workId, "adjustment", {
            usage: original.data,
            reason: input.reason,
          });
          const work = (await tx.get<Work>("work", workId))!.data;
          work.status = "reconciliation";
          await put(tx, "work", workId, work, "reconciliation");
          return { status: "reconciliation", operationId: workId };
        }
        for (const allocation of original.data.allocations)
          await this.ledger.movement(
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
        await put(tx, "usage", correction.id, correction);
        await put(tx, "usage", original.id, original.data, "reversed");
        await this.event(tx, input.customerId, "usage.corrected", correction);
        return { status: "corrected", usage: correction };
      }),
    setQuantity: (input: UsageInput) =>
      this.write(input, "usage.setQuantity", input, async (tx, key) => {
        await this.ledger.materialize(tx);
        nonnegative(input.amount);
        const capacity = await this.quantityCapacity(
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
                    (
                      await tx.list<{ feature: string }>("licenses", "active")
                    ).filter((r) => r.data.feature === input.feature).length,
                  ) * 1_000_000n) <=
              capacity,
            "quantity_limit_exceeded",
          );
        const id = await hash({
          feature: input.feature,
          entity: input.entityId,
        });
        const previous = (
          await tx.get<{ amount: string; allocations: Allocation[] }>(
            "counters",
            `quantity:${id}`,
          )
        )?.data ?? { amount: "0", allocations: [] };
        let allocations = [...previous.allocations];
        const delta = units(input.amount) - units(previous.amount);
        if (delta > 0n)
          allocations.push(
            ...(await this.ledger.allocate(
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
              await this.ledger.movement(
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
        await put(tx, "counters", `quantity:${id}`, {
          amount: input.amount,
          allocations,
        });
        return { amount: input.amount };
      }),
  };
  private async occupied(
    tx: Transaction,
    feature: string,
    entityId?: string,
  ): Promise<bigint> {
    const id = await hash({ feature, entity: entityId });
    const quantity =
      (await tx.get<{ amount: string }>("counters", `quantity:${id}`))?.data
        .amount ?? "0";
    const assignments = (
      await tx.list<{ feature: string }>("licenses", "active")
    ).filter((r) => r.data.feature === feature).length;
    return units(quantity) + (entityId ? 0n : BigInt(assignments) * 1_000_000n);
  }
  private async balanceFor(
    tx: Transaction,
    feature: string,
    entityId?: string,
  ): Promise<Balance> {
    const capacity = await this.quantityCapacity(tx, feature, entityId);
    if (capacity === undefined)
      return this.ledger.balance(tx, feature, entityId);
    const used = await this.occupied(tx, feature, entityId);
    return {
      feature,
      granted: decimal(capacity),
      spent: decimal(used),
      reserved: "0",
      available: decimal(capacity - used),
    };
  }
  private async quantityCapacity(
    tx: Transaction,
    feature: string,
    entityId?: string,
  ): Promise<bigint | undefined> {
    const kind = (
      await tx.get<{ kind: string }>("counters", `feature-kind:${feature}`)
    )?.data.kind;
    if (kind !== "quantity") return undefined;
    let capacity = 0n;
    for (const sub of await this.subscriptionsIn(tx, entityId)) {
      const item = sub.plan.items.find((i) => i.feature === feature);
      if (item)
        capacity +=
          (units(item.included ?? "0") * units(sub.quantity)) / 1_000_000n;
    }
    for (const grant of await this.ledger.usableGrants(tx, feature, entityId))
      if (
        grant.origin === "manual" ||
        (grant.origin === "purchase" &&
          !(await this.subscriptionsIn(tx, entityId)).some(
            (sub) => sub.purchaseId === grant.sourceId,
          ))
      )
        capacity += units(grant.amount);
    return capacity;
  }
  readonly reservations = {
    create: (input: UsageInput & { expiresAt?: number }) =>
      this.write(input, "reservations.create", input, async (tx, key) => {
        await this.ledger.materialize(tx);
        positive(input.amount);
        const mapped = await this.item(tx, input.feature, input.entityId);
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
        const allocations = await this.ledger.allocate(
          tx,
          feature,
          units(amount),
          allocationEntity(mapped?.item, input.entityId),
          true,
          key,
        );
        let expiresAt = input.expiresAt ?? this.now() + 15 * 60_000;
        assert(timestamp(expiresAt) > this.now(), "invalid_expiry");
        for (const a of allocations) {
          const grant = (await tx.get<Grant>("grants", a.grantId))!.data;
          expiresAt = Math.min(expiresAt, grant.expiresAt ?? Infinity);
        }
        const reservation: Reservation = {
          id: crypto.randomUUID(),
          feature,
          entityId: input.entityId,
          amount,
          allocations,
          poolScope: mapped?.item.poolScope,
          expiresAt,
          status: "held",
        };
        await put(tx, "reservations", reservation.id, reservation, "held");
        return reservation;
      }),
    increase: (input: WriteInput & { reservationId: string; amount: string }) =>
      this.write(input, "reservations.increase", input, async (tx, key) => {
        await this.ledger.materialize(tx);
        const row = await tx.get<Reservation>(
          "reservations",
          input.reservationId,
        );
        assert(row?.state === "held", "reservation_not_held");
        const r = row.data;
        positive(input.amount);
        const extra = await this.ledger.allocate(
          tx,
          r.feature,
          units(input.amount),
          r.poolScope === "customer" ? undefined : r.entityId,
          true,
          key,
        );
        let expiresAt = r.expiresAt;
        for (const a of extra)
          expiresAt = Math.min(
            expiresAt,
            (await tx.get<Grant>("grants", a.grantId))!.data.expiresAt ??
              Infinity,
          );
        const next = {
          ...r,
          amount: decimal(units(r.amount) + units(input.amount)),
          allocations: [...r.allocations, ...extra],
          expiresAt,
        };
        await put(tx, "reservations", r.id, next, "held");
        return next;
      }),
    release: (input: WriteInput & { reservationId: string }) =>
      this.write(input, "reservations.release", input, async (tx) => {
        await this.ledger.materialize(tx);
        const row = await tx.get<Reservation>(
          "reservations",
          input.reservationId,
        );
        assert(row, "reservation_not_found");
        if (row.state !== "held") return row.data;
        return this.ledger.finishReservation(tx, row.data, "released");
      }),
    settle: (input: WriteInput & { reservationId: string; amount: string }) =>
      this.write(input, "reservations.settle", input, async (tx, key) => {
        await this.ledger.materialize(tx);
        const row = await tx.get<Reservation>(
          "reservations",
          input.reservationId,
        );
        assert(row, "reservation_not_found");
        nonnegative(input.amount);
        const r = row.data;
        if (row.state !== "held" || units(input.amount) > units(r.amount)) {
          const id = crypto.randomUUID();
          await this.enqueue(tx, id, "reservation_adjustment", {
            reservationId: r.id,
            amount: input.amount,
          });
          const work = (await tx.get<Work>("work", id))!.data;
          work.status = "reconciliation";
          await put(tx, "work", id, work, "reconciliation");
          return { status: "reconciliation" as const, operationId: id };
        }
        let left = units(input.amount);
        const used: Allocation[] = [];
        for (const a of r.allocations) {
          const take = minimum(units(a.amount), left);
          await this.ledger.adjustPosition(tx, a.grantId, 0n, -units(a.amount));
          if (take > 0n) {
            await this.ledger.movement(tx, a.grantId, take, key, "settle");
            used.push({ grantId: a.grantId, amount: decimal(take) });
            left -= take;
          }
        }
        const next = { ...r, status: "settled" as const };
        await put(tx, "reservations", r.id, next, "settled");
        const usage: Usage = {
          id: crypto.randomUUID(),
          feature: r.feature,
          entityId: r.entityId,
          quantity: input.amount,
          charged: input.amount,
          allocations: used,
          createdAt: this.now(),
          properties: { reservationId: r.id },
        };
        await put(tx, "usage", usage.id, usage);
        await this.afterUsage(
          tx,
          input.customerId,
          r.feature,
          r.poolScope === "customer" ? undefined : r.entityId,
        );
        return { status: "settled" as const, reservation: next, usage };
      }),
    list: (customerId: string) =>
      this.store.read(this.scope(customerId), async (tx) =>
        (await tx.list<Reservation>("reservations")).map((r) => r.data),
      ),
  };
  readonly billingControls = {
    get: async (customerId: string) =>
      (await this.customers.get(customerId)).controls,
    update: async (input: WriteInput & { controls: Controls }) => {
      const topup = input.controls.autoTopUp;
      if (topup) {
        const pack = await this.catalog.get(topup.packPlan);
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
      return this.write(input, "controls.update", input, async (tx) => {
        for (const value of Object.values(input.controls.overageLimits ?? {}))
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
        const customer = await this.customer(tx, input.customerId);
        customer.controls = input.controls;
        await put(tx, "customers", customer.id, customer);
        if (topup) await this.afterUsage(tx, input.customerId, topup.feature);
        return customer.controls;
      });
    },
  };
  private providerIdentity(scope: string, operation: string) {
    return hash({ environment: this.environment, scope, operation });
  }
  private async payment(
    input: WriteInput,
    kind: string,
    parameters: Record<string, unknown>,
  ) {
    const saved = await this.write(
      input,
      `payment.${kind}`,
      parameters,
      async (tx, key) => {
        const id = `payment:${key}`;
        if (
          kind === "checkout" &&
          (parameters.plan as PublishedPlan).kind !== "one_time"
        ) {
          const plan = parameters.plan as PublishedPlan;
          const slot = await hash({
            group: plan.addOn ? plan.id : (plan.group ?? "base"),
            entity: input.entityId,
          });
          const current = (
            await tx.get<{
              operationId: string;
              version: string;
              quantity: string;
              expiresAt: number;
            }>("counters", `checkout:${slot}`)
          )?.data;
          if (current && current.expiresAt > this.now()) {
            assert(
              current.version === plan.version &&
                current.quantity === String(parameters.quantity ?? "1"),
              "checkout_in_progress",
            );
            return { operationId: current.operationId };
          }
          await put(tx, "counters", `checkout:${slot}`, {
            operationId: id,
            entityId: input.entityId,
            version: plan.version,
            quantity: String(parameters.quantity ?? "1"),
            expiresAt: this.now() + 24 * 60 * 60_000,
          });
        }
        const payload = { ...parameters, customerId: input.customerId };
        const plan = parameters.plan as PublishedPlan | undefined;
        if (kind === "checkout" && plan && plan.kind !== "one_time") {
          const existing = (
            await this.subscriptionsIn(tx, input.entityId)
          ).find(
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
          const used = await tx.get("counters", "trial-claimed");
          Object.assign(payload, { trialAllowed: !used });
          if (!used)
            await put(tx, "counters", "trial-claimed", {
              operationId: id,
              createdAt: this.now(),
            });
        }
        await this.enqueue(tx, id, kind, payload);
        return { operationId: id };
      },
    );
    await this.runWork(this.scope(input.customerId), saved.operationId);
    return this.operations.get(input.customerId, saved.operationId);
  }
  private async subscriptionCommand(
    input: WriteInput & { subscriptionId: string },
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<Work> {
    const existing = await this.store.read(
      this.scope(input.customerId),
      async (tx) =>
        (await tx.get<Subscription>("subscriptions", input.subscriptionId))
          ?.data,
    );
    if (!existing || existing.stripeSubscriptionId)
      return this.payment(input, kind, payload);
    return this.write(input, `local.${kind}`, payload, async (tx, key) => {
      const row = await tx.get<Subscription>(
        "subscriptions",
        input.subscriptionId,
      );
      assert(row, "subscription_not_found");
      const sub = row.data;
      if (payload.plan)
        await registerFeatures(tx, payload.plan as PublishedPlan);
      assert(sub.plan.kind === "free", "payment_required");
      const plan = payload.plan as PublishedPlan | undefined;
      if (plan) assert(plan.kind === "free", "payment_required");
      let end = sub.periodEnd;
      let i = 1;
      while (end <= this.now() && i < 1200) {
        end = addInterval(sub.periodStart, sub.plan.interval ?? "month", i++);
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
            for (const { data: g } of await tx.list<Grant>("grants", "active"))
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
          assert(phases.length > 0 && phases.length <= 10, "invalid_schedule");
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
            sub.scheduledPlans.push({ plan: phase.plan, start, end: until });
            start = until;
          }
          break;
        }
        default:
          throw new BillingError("unsupported_subscription_operation");
      }
      if (kind !== "preview") {
        await put(
          tx,
          "subscriptions",
          sub.id,
          sub,
          ["active", "trialing"].includes(sub.status) ? "active" : sub.status,
        );
        await this.ledger.materialize(tx);
        await this.event(tx, input.customerId, kind, {
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
      await put(tx, "work", work.id, work, "done");
      return work;
    });
  }
  readonly subscriptions = {
    attach: async (
      input: WriteInput & {
        planId: string;
        version?: string;
        quantity?: string;
      },
    ) => {
      const plan = await this.catalog.get(input.planId, input.version);
      const free = plan.kind === "free";
      assert(
        free,
        "payment_required",
        "Use subscriptions.checkout for paid plans.",
      );
      return this.write(input, "subscriptions.attach", input, async (tx) => {
        const previous = (await this.subscriptionsIn(tx, input.entityId)).find(
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
        const id = await hash({ plan: plan.id, entity: input.entityId }),
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
        await registerFeatures(tx, plan);
        await put(tx, "subscriptions", id, sub);
        await this.ledger.materialize(tx);
        return sub;
      });
    },
    list: (customerId: string) =>
      this.store.read(this.scope(customerId), async (tx) =>
        (await tx.list<Subscription>("subscriptions")).map((r) => r.data),
      ),
    checkout: async (
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
      const plan = await this.catalog.get(input.planId, input.version);
      if (input.quantity !== undefined)
        assert(
          positive(input.quantity) % 1_000_000n === 0n,
          "invalid_seat_quantity",
        );
      returnUrl(input.successUrl);
      if (input.cancelUrl) returnUrl(input.cancelUrl);
      return this.payment(input, "checkout", { ...input, plan });
    },
    preview: async (
      input: WriteInput & { subscriptionId: string; planId: string },
    ) =>
      this.subscriptionCommand(input, "preview", {
        ...input,
        plan: await this.catalog.get(input.planId),
      }),
    update: async (
      input: WriteInput & {
        subscriptionId: string;
        planId?: string;
        quantity?: string;
        effective?: "now" | "period_end";
      },
    ) =>
      this.subscriptionCommand(input, "subscription_update", {
        ...input,
        plan: input.planId ? await this.catalog.get(input.planId) : undefined,
      }),
    cancel: (
      input: WriteInput & { subscriptionId: string; immediately?: boolean },
    ) => this.subscriptionCommand(input, "subscription_cancel", input),
    pause: (input: WriteInput & { subscriptionId: string }) =>
      this.subscriptionCommand(input, "subscription_pause", input),
    resume: (input: WriteInput & { subscriptionId: string }) =>
      this.subscriptionCommand(input, "subscription_resume", input),
    schedule: async (
      input: WriteInput & {
        subscriptionId: string;
        phases: { planId: string; iterations: number }[];
      },
    ) =>
      this.subscriptionCommand(input, "subscription_schedule", {
        ...input,
        phases: await Promise.all(
          input.phases.map(async (phase) => ({
            ...phase,
            plan: await this.catalog.get(phase.planId),
          })),
        ),
      }),
    portal: (input: WriteInput & { returnUrl: string }) =>
      this.payment(input, "portal", input),
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
    assign: (input: WriteInput & { feature: string; entityId: string }) =>
      this.write(input, "licenses.assign", input, async (tx, key) => {
        const id = await hash({
          feature: input.feature,
          entity: input.entityId,
        });
        assert(
          (await tx.get("licenses", id))?.state !== "active",
          "license_already_assigned",
        );
        await this.ledger.materialize(tx);
        const capacity = await this.quantityCapacity(tx, input.feature);
        if (capacity !== undefined) {
          assert(
            (await this.occupied(tx, input.feature)) + 1_000_000n <= capacity,
            "quantity_limit_exceeded",
          );
        }
        const allocations = await this.ledger.allocate(
          tx,
          input.feature,
          1_000_000n,
          undefined,
          false,
          key,
        );
        await put(tx, "licenses", id, {
          id,
          entityId: input.entityId,
          feature: input.feature,
          allocations,
        });
        return { id };
      }),
    release: (input: WriteInput & { licenseId: string }) =>
      this.write(input, "licenses.release", input, async (tx, key) => {
        const row = await tx.get<{ allocations: Allocation[] }>(
          "licenses",
          input.licenseId,
        );
        assert(row?.state === "active", "license_not_found");
        for (const a of row.data.allocations)
          await this.ledger.movement(
            tx,
            a.grantId,
            -units(a.amount),
            key,
            "license_release",
          );
        await put(tx, "licenses", row.id, row.data, "released");
        return { released: true };
      }),
    list: (customerId: string) =>
      this.store.read(this.scope(customerId), async (tx) =>
        (await tx.list("licenses", "active")).map((r) => r.data),
      ),
  };
  readonly operations = {
    reconcile: async (
      input: WriteInput & {
        operationId: string;
        resolution: string;
        result?: unknown;
        outcome?: "completed" | "not_executed";
      },
    ): Promise<{ resolved: boolean }> => this.operations.resolve(input),
    page: (
      customerId: string,
      input: { cursor?: string; limit?: number } = {},
    ) => this.page<Work>(customerId, "work", input),
    get: (customerId: string, id: string) =>
      this.store.read(this.scope(customerId), async (tx) => {
        const row = await tx.get<Work>("work", id);
        assert(row, "operation_not_found");
        return row.data;
      }),
    list: async (customerId: string) =>
      (await this.operations.page(customerId)).items,
    retry: async (input: WriteInput & { operationId: string }) => {
      await this.write(input, "operations.retry", input, async (tx) => {
        const row = await tx.get<Work>("work", input.operationId);
        assert(row, "operation_not_found");
        assert(row.state !== "reconciliation", "reconciliation_required");
        assert(
          row.state !== "processing" ||
            (row.data.leaseUntil ?? 0) <= this.now(),
          "operation_in_progress",
        );
        if (row.state !== "done")
          await put(
            tx,
            "work",
            row.id,
            { ...row.data, status: "pending", availableAt: this.now() },
            "pending",
          );
        return { id: row.id };
      });
      await this.runWork(this.scope(input.customerId), input.operationId);
      return this.operations.get(input.customerId, input.operationId);
    },
    resolve: (
      input: WriteInput & {
        operationId: string;
        resolution: string;
        result?: unknown;
        outcome?: "completed" | "not_executed";
      },
    ) =>
      this.write(input, "operations.resolve", input, async (tx) => {
        assert(input.resolution.trim(), "reason_required");
        const row = await tx.get<Work>("work", input.operationId);
        assert(row?.state === "reconciliation", "operation_not_reconcilable");
        await put(
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
        for (const intent of await tx.list<{
          operationId?: string;
          expiresAt?: number;
        }>("counters"))
          if (
            input.outcome === "not_executed" &&
            intent.id.startsWith("checkout:") &&
            intent.data.operationId === row.id
          )
            await put(tx, "counters", intent.id, {
              ...intent.data,
              expiresAt: 0,
            });
        if (
          input.outcome === "not_executed" &&
          row.data.kind === "auto_topup"
        ) {
          const counter = String(row.data.payload.counter);
          const current = (
            await tx.get<{ pending?: string; count: number }>(
              "counters",
              counter,
            )
          )?.data;
          if (current?.pending === row.id) {
            await put(tx, "counters", counter, { count: current.count });
            await put(tx, "counters", "topup-pending", {});
          }
        }
        await this.event(tx, input.customerId, "operation.resolved", input);
        return { resolved: true };
      }),
  };
  readonly events = {
    page: (
      customerId: string,
      input: { cursor?: string; limit?: number } = {},
    ) => this.page<unknown>(customerId, "events", input),
    list: async (customerId: string) =>
      (await this.events.page(customerId)).items,
  };
  readonly webhook = async (request: Request) => {
    assert(this.options.provider, "provider_missing");
    const event = await this.options.provider.verify(request);
    if (!event) return { accepted: true };
    identifier(event.customerId);
    const scope = this.scope(event.customerId);
    await this.store.atomic(scope, async (tx) => {
      if (await tx.get("inbox", event.id)) return;
      await this.customer(tx, event.customerId);
      await put(tx, "inbox", event.id, event, "pending");
      await this.enqueue(tx, `webhook:${event.id}`, "webhook", { event });
    });
    return { accepted: true };
  };
  private async runWork(scope: string, id: string): Promise<boolean> {
    const token = crypto.randomUUID();
    const work = await this.store.atomic(scope, async (tx) => {
      const row = await tx.get<Work>("work", id);
      if (
        !row ||
        row.state === "done" ||
        row.state === "reconciliation" ||
        row.data.availableAt > this.now() ||
        (row.state === "processing" && (row.data.leaseUntil ?? 0) > this.now())
      )
        return null;
      const lane = (
        await tx.get<{ owner: string; until: number; operationId?: string }>(
          "counters",
          "provider-lane",
        )
      )?.data;
      if (row.data.kind !== "event" && lane) {
        if (lane.until > this.now()) return null;
        if (lane.operationId && lane.operationId !== id) {
          const interrupted = await tx.get<Work>("work", lane.operationId);
          if (interrupted?.state === "processing") return null;
        }
      }
      if (row.data.kind === "subscription_update") {
        const outstanding = (
          await Promise.all([
            tx.list<Work>("work", "meter_pending"),
            tx.list<Work>("work", "meter_failed"),
            tx.list<Work>("work", "pending"),
            tx.list<Work>("work", "failed"),
            tx.list<Work>("work", "processing"),
            tx.list<Work>("work", "reconciliation"),
          ])
        )
          .flat()
          .some(
            (w) =>
              w.data.kind === "meter" &&
              w.data.payload.subscriptionId === row.data.payload.subscriptionId,
          );
        if (outstanding) return null;
      }
      if (row.data.kind !== "event")
        await put(tx, "counters", "provider-lane", {
          owner: token,
          operationId: id,
          until: this.now() + 120_000,
        });
      const next = {
        ...row.data,
        status: "processing" as const,
        attempts: row.data.attempts + 1,
        leaseOwner: token,
        leaseUntil: this.now() + 120_000,
      };
      await put(tx, "work", id, next, "processing");
      return next;
    });
    if (!work) return false;
    let result: unknown;
    try {
      const customerId = scope.slice(`${this.environment}:c:`.length);
      if (work.kind === "event") {
        await this.options.hooks?.onEvent?.(
          work.payload as unknown as Parameters<
            NonNullable<Hooks["onEvent"]>
          >[0],
        );
        result = { delivered: true };
      } else if (work.kind === "webhook") {
        assert(this.options.provider, "provider_missing");
        const reconciled = await this.options.provider.reconcile(
          work.payload.event as ProviderEvent,
        );
        await this.applyProviderEvent(scope, reconciled);
        result = { applied: true };
      } else {
        assert(this.options.provider, "provider_missing");
        if (this.now() - work.createdAt > 23 * 60 * 60_000)
          throw new BillingError(
            "reconciliation_required",
            "Provider operation is outside the safe retry window.",
          );
        let input = work.payload;
        if (work.kind === "auto_topup")
          input = {
            ...input,
            plan: await this.catalog.get(String(input.planId)),
          };
        const customer = await this.customers.get(customerId);
        if (work.kind === "meter") {
          const checkpoint = await this.store.read(
            scope,
            async (tx) =>
              (
                await tx.get<{ minor: string; generation: number }>(
                  "counters",
                  `meter-export:${String(input.meterKey)}`,
                )
              )?.data ?? { minor: "0", generation: 0 },
          );
          input = { ...input, previousMinor: checkpoint.minor };
          if (Number(input.generation) <= checkpoint.generation)
            result = { skipped: true };
          else
            result = await this.options.provider.execute({
              id: await this.providerIdentity(scope, work.id),
              kind: work.kind,
              resources: this.resourceStore,
              customer,
              input,
            });
        } else
          result = await this.options.provider.execute({
            id: await this.providerIdentity(scope, work.id),
            kind: work.kind,
            resources: this.resourceStore,
            customer,
            input,
          });
      }
      if (result && typeof result === "object" && "providerEvent" in result)
        await this.applyProviderEvent(
          scope,
          result.providerEvent as ProviderEvent,
        );
      await this.store.atomic(scope, async (tx) => {
        const current = (await tx.get<Work>("work", id))!.data;
        assert(current.leaseOwner === token, "lease_lost");
        if (work.kind !== "event")
          await put(tx, "counters", "provider-lane", {
            owner: token,
            until: 0,
          });
        if (
          work.kind === "meter" &&
          result &&
          typeof result === "object" &&
          "exportedMinor" in result
        )
          await put(
            tx,
            "counters",
            `meter-export:${String(work.payload.meterKey)}`,
            {
              minor: String(result.exportedMinor),
              generation: Number(work.payload.generation),
            },
          );
        await put(
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
          const c = await this.customer(tx, customerId);
          const linked = String(result.stripeCustomerId);
          assert(
            !c.stripeCustomerId || c.stripeCustomerId === linked,
            "customer_mapping_conflict",
          );
          await put(tx, "customers", c.id, { ...c, stripeCustomerId: linked });
        }
        if (work.kind === "webhook") {
          const event = work.payload.event as ProviderEvent;
          await put(tx, "inbox", event.id, event, "done");
        }
      });
      return true;
    } catch (error) {
      await this.store.atomic(scope, async (tx) => {
        const current = (await tx.get<Work>("work", id))!.data;
        if (current.leaseOwner !== token) return;
        if (work.kind !== "event")
          await put(tx, "counters", "provider-lane", {
            owner: token,
            until: 0,
          });
        const reconciliation =
          error instanceof BillingError &&
          error.code === "reconciliation_required";
        const status = reconciliation ? "reconciliation" : "failed";
        await put(
          tx,
          "work",
          id,
          {
            ...current,
            status,
            error:
              error instanceof BillingError ? error.code : "provider_error",
            availableAt:
              this.now() + Math.min(2 ** current.attempts * 1000, 3600_000),
            leaseUntil: undefined,
          },
          status,
        );
      });
      return false;
    }
  }
  private async applyProviderEvent(scope: string, event: ProviderEvent) {
    const planData = event.data.plan as PublishedPlan | undefined;
    const plan =
      planData ??
      (event.data.planId
        ? await this.catalog.get(
            String(event.data.planId),
            event.data.planVersion as string | undefined,
          )
        : undefined);
    await this.store.atomic(scope, async (tx) => {
      if (await tx.get("counters", `applied:${event.id}`)) return;
      if (event.data.subscription && plan) {
        const subscription = event.data.subscription as Omit<
          Subscription,
          "plan"
        >;
        const existing = (
          await tx.get<Subscription>("subscriptions", subscription.id)
        )?.data;
        await registerFeatures(tx, plan);
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
            for (const { data: g } of await tx.list<Grant>(
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
          next.paidThrough = Math.max(existing.paidThrough, next.paidThrough);
        if (
          next.status === "past_due" &&
          existing?.paidThrough &&
          next.plan.graceDays
        )
          next.graceThrough =
            existing.paidThrough + next.plan.graceDays * 86400_000;
        if (existing?.status === "trialing" && next.status === "active")
          for (const grant of await tx.list<Grant>("grants", "active"))
            if (
              grant.data.sourceId === next.id &&
              grant.data.origin === "subscription"
            )
              await put(tx, "grants", grant.id, grant.data, "expired");
        if (["active", "trialing"].includes(next.status) && !next.plan.addOn)
          for (const row of await tx.list<Subscription>(
            "subscriptions",
            "active",
          ))
            if (
              row.id !== next.id &&
              row.data.entityId === next.entityId &&
              !row.data.plan.addOn &&
              (row.data.plan.group ?? "base") === (next.plan.group ?? "base")
            )
              await put(
                tx,
                "subscriptions",
                row.id,
                { ...row.data, status: "ended" },
                "ended",
              );
        await put(
          tx,
          "subscriptions",
          next.id,
          next,
          isEntitled(next, this.now()) ? "active" : next.status,
        );
        await this.ledger.materialize(tx);
      }
      if (event.type === "purchase.paid" && plan) {
        assert(plan.kind === "one_time", "invalid_purchase_plan");
        const id = await hash({ purchaseId: event.data.purchaseId });
        const existing = await tx.get<Subscription>("subscriptions", id);
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
          await registerFeatures(tx, plan);
          await put(tx, "subscriptions", id, purchase);
        }
        await this.ledger.materialize(tx);
        const counter = event.data.topupCounter as string | undefined;
        if (counter) {
          const old = (
            await tx.get<{ count: number; pending?: string }>(
              "counters",
              counter,
            )
          )?.data;
          if (
            old?.pending &&
            (await this.providerIdentity(scope, old.pending)) ===
              event.data.purchaseId
          ) {
            await put(tx, "counters", counter, { count: old.count });
            const pending = (
              await tx.get<{ operationId?: string }>(
                "counters",
                "topup-pending",
              )
            )?.data.operationId;
            if (pending === old.pending)
              await put(tx, "counters", "topup-pending", {});
          }
        }
      }
      if (event.type === "payment.reconciliation") {
        if (event.data.purchaseId)
          for (const row of await tx.list<Grant>("grants", "active"))
            if (row.data.sourceId === event.data.purchaseId)
              await put(tx, "grants", row.id, row.data, "review");
        const id = crypto.randomUUID();
        await this.enqueue(tx, id, "payment_adjustment", event.data);
        const w = (await tx.get<Work>("work", id))!.data;
        await put(
          tx,
          "work",
          id,
          { ...w, status: "reconciliation" },
          "reconciliation",
        );
      }
      if (event.type === "purchase.reversed") {
        for (const row of await tx.list<Subscription>(
          "subscriptions",
          "active",
        ))
          if (row.data.purchaseId === event.data.purchaseId)
            await put(
              tx,
              "subscriptions",
              row.id,
              { ...row.data, status: "ended" },
              "ended",
            );
        for (const row of await tx.list<Grant>("grants", "active"))
          if (row.data.sourceId === event.data.purchaseId) {
            const p = await this.ledger.position(tx, row.id);
            const unused =
              units(row.data.amount) - units(p.spent) - units(p.held);
            if (unused > 0n)
              await this.ledger.movement(
                tx,
                row.id,
                unused,
                event.id,
                "purchase_refunded",
              );
            await put(tx, "grants", row.id, row.data, "revoked");
            if (units(p.spent) > 0n) {
              const id = crypto.randomUUID();
              await this.enqueue(tx, id, "refund_adjustment", {
                purchaseId: event.data.purchaseId,
                spent: p.spent,
              });
              const w = (await tx.get<Work>("work", id))!.data;
              await put(
                tx,
                "work",
                id,
                { ...w, status: "reconciliation" },
                "reconciliation",
              );
            }
          }
      }
      await put(tx, "counters", `applied:${event.id}`, {
        appliedAt: this.now(),
      });
      await this.event(tx, event.customerId, event.type, {
        providerEventId: event.id,
      });
    });
  }
  readonly maintenance = {
    run: async (
      input: { limit?: number; customerId?: string; cursor?: string } = {},
    ) => {
      const limit = input.limit ?? 100;
      assert(
        Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
        "invalid_limit",
      );
      const cursor =
        input.cursor ??
        (await this.store.read(
          this.catalogScope(),
          async (tx) =>
            (
              await tx.get<{ cursor: string }>("counters", "maintenance-cursor")
            )?.data.cursor,
        )) ??
        "";
      const scopes = input.customerId
        ? [this.scope(input.customerId)]
        : await this.store.scopes(cursor, limit, `${this.environment}:c:`);
      let processed = 0,
        more = false,
        lastScope = cursor;
      for (const scope of scopes) {
        lastScope = scope;
        await this.store.atomic(scope, async (tx) => {
          await this.ledger.materialize(tx);
          const customerId = scope.slice(`${this.environment}:c:`.length);
          const customer = (await tx.get<Customer>("customers", customerId))
            ?.data;
          if (customer?.controls.autoTopUp)
            await this.afterUsage(
              tx,
              customerId,
              customer.controls.autoTopUp.feature,
            );
        });
        const candidates = await this.store.read(scope, async (tx) =>
          (
            await Promise.all(
              [
                "processing",
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
            )
          )
            .flat()
            .filter(
              (r) =>
                ["pending", "failed", "processing"].includes(r.data.status) &&
                r.data.availableAt <= this.now() &&
                (r.data.leaseUntil ?? 0) <= this.now(),
            )
            .map((r) => r.id),
        );
        for (const id of candidates) {
          if (processed >= limit) {
            more = true;
            break;
          }
          await this.runWork(scope, id);
          processed++;
        }
        if (processed >= limit) {
          more = true;
          break;
        }
      }
      const nextCursor = scopes.length === limit || more ? lastScope : "";
      if (!input.customerId && input.cursor === undefined)
        await this.store.atomic(this.catalogScope(), (tx) =>
          put(tx, "counters", "maintenance-cursor", { cursor: nextCursor }),
        );
      return {
        processed,
        more: more || scopes.length === limit,
        cursor: nextCursor,
      };
    },
  };
  readonly migration = {
    linkSubscription: async (
      input: WriteInput & { stripeSubscriptionId: string; planId: string },
    ) =>
      this.payment(input, "subscription_import", {
        ...input,
        plan: await this.catalog.get(input.planId),
      }),
    export: async (customerId: string): Promise<ExportSnapshot> =>
      this.store.atomic(this.scope(customerId), async (tx) => {
        const subscriptions = (
          await tx.list<Subscription>("subscriptions")
        ).map((r) => r.data);
        const grantRows = await tx.list<Grant>("grants");
        const grants = grantRows.map((r) => r.data);
        const work = (await tx.list<Work>("work")).map((r) => r.data);
        const usage = (await tx.list<Usage>("usage"))
          .filter((r) => r.state !== "reversed")
          .map((r) => r.data);
        const blockers = work
          .filter((w) => w.status !== "done" && w.kind !== "event")
          .map((w) => `operation:${w.id}`);
        if (
          usage.some(
            (u) =>
              u.currency &&
              units(u.charged) !== 0n &&
              subscriptions.some(
                (sub) =>
                  u.createdAt >= sub.periodStart && u.createdAt < sub.periodEnd,
              ),
          )
        )
          blockers.push("open_postpaid_period");
        const policyCounters = (await tx.list<unknown>("counters")).filter(
          (r) =>
            r.id === "trial-claimed" ||
            r.id.startsWith("topup:") ||
            r.id === "topup-pending",
        );
        if (
          (await tx.get<{ operationId?: string }>("counters", "topup-pending"))
            ?.data.operationId
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
        ] as const)
          archive[table] = await tx.list(table);
        return {
          archive,
          grantStates: Object.fromEntries(
            grantRows.map((row) => [row.id, row.state]),
          ),
          policyCounters,
          format: 1,
          environment: this.environment,
          customer: await this.customer(tx, customerId),
          entities: (await tx.list<Entity>("entities")).map((r) => r.data),
          grants,
          positions: await Promise.all(
            grants.map(async (g) => ({
              grantId: g.id,
              ...(await this.ledger.position(tx, g.id)),
            })),
          ),
          subscriptions,
          reservations: (
            await tx.list<Reservation>("reservations", "held")
          ).map((r) => r.data),
          licenses: (await tx.list<ImportedLicense>("licenses", "active")).map(
            (r) => r.data,
          ),
          quantities: (await tx.list<ImportedQuantity["data"]>("counters"))
            .filter((r) => r.id.startsWith("quantity:"))
            .map((r) => ({ id: r.id, data: r.data })),
          blockers,
        };
      }),
    import: async (input: {
      snapshot: ExportSnapshot;
      idempotencyKey: string;
      dryRun?: boolean;
    }) => {
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
      return this.write(
        {
          customerId: s.customer.id,
          idempotencyKey: `import:${await hash(input.idempotencyKey)}`,
        },
        "migration.import",
        s,
        async (tx) => {
          assert(
            !(await tx.get("customers", s.customer.id)),
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
                  typeof row.id === "string" && typeof row.state === "string",
                  "invalid_snapshot",
                );
                await tx.put(table as Table, row);
              }
            }
          } else {
            await put(tx, "customers", s.customer.id, s.customer);
            for (const e of s.entities) await put(tx, "entities", e.id, e);
            for (const g of s.grants) {
              await put(
                tx,
                "grants",
                g.id,
                g,
                s.grantStates?.[g.id] ?? "active",
              );
              const p = s.positions.find((p) => p.grantId === g.id)!;
              if (units(p.spent) > 0n)
                await this.ledger.movement(
                  tx,
                  g.id,
                  units(p.spent),
                  input.idempotencyKey,
                  "import_opening_balance",
                );
            }
            for (const counter of s.policyCounters ?? [])
              await put(
                tx,
                "counters",
                counter.id,
                counter.data,
                counter.state,
              );
            for (const license of s.licenses ?? [])
              await put(tx, "licenses", license.id, license);
            for (const quantity of s.quantities ?? [])
              await put(tx, "counters", quantity.id, quantity.data);
            for (const sub of s.subscriptions) {
              await registerFeatures(tx, sub.plan);
              await put(
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
            (await this.ledger.reconcile(tx)).consistent,
            "invalid_snapshot_ledger",
          );
          return {
            customerId: s.customer.id,
            grants: s.grants.length,
            dryRun: false,
          };
        },
        true,
      );
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
  data: { amount: string; allocations: Allocation[] };
};
export type ExportSnapshot = {
  archive?: Partial<Record<Table, Row[]>>;
  grantStates?: Record<string, string>;
  policyCounters?: { id: string; state: string; data: unknown }[];
  licenses?: ImportedLicense[];
  quantities?: ImportedQuantity[];
  blockers?: string[];
  format: 1;
  environment: Environment;
  customer: Customer;
  entities: Entity[];
  grants: Grant[];
  positions: { grantId: string; spent: string; held: string }[];
  subscriptions: Subscription[];
  reservations: Reservation[];
};
