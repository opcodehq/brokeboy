import { expect, test } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { effectBilling } from "../src/billing.js";
import { drizzleStorage } from "../src/drizzle.js";
import {
  BillingService,
  EffectBilling,
  layer,
  StorageError,
} from "../src/effect.js";
import { effectProvider, promiseProvider } from "../src/integrations.js";
import { memoryStorage } from "../src/memory.js";
import { effectHandler } from "../src/server.js";

test("native billing effects are lazy and domain failures stay in the typed channel", async () => {
  const database = memoryStorage(),
    billing = new EffectBilling({ database });
  expect(effectBilling(billing)).toBe(billing);
  const create = billing.customers.create({
    id: "lazy",
    idempotencyKey: "create",
  });
  expect(await Effect.runPromise(database.scopes())).toEqual([]);
  await Effect.runPromise(create);
  const failure = await Effect.runPromise(
    Effect.flip(
      billing.usage.consume({
        customerId: "lazy",
        feature: "credits",
        amount: "1",
        idempotencyKey: "spend",
      }),
    ),
  );
  expect(failure._tag).toBe("BillingError");
  if (failure._tag === "BillingError")
    expect(failure.code).toBe("insufficient_balance");
});

test("billing layers use Effect's clock for deterministic lease expiry", async () => {
  const program = Effect.gen(function* () {
    const billing = yield* BillingService;
    yield* billing.customers.create({ id: "clock", idempotencyKey: "create" });
    yield* billing.credits.grant({
      customerId: "clock",
      feature: "credits",
      amount: "10",
      idempotencyKey: "grant",
    });
    yield* billing.workflows.create({
      customerId: "clock",
      workflowId: "job",
      idempotencyKey: "start",
      steps: [{ id: "run", budgets: [{ feature: "credits", amount: "5" }] }],
    });
    const claim = yield* billing.workflows.claim({
      customerId: "clock",
      workflowId: "job",
      workerId: "worker",
      leaseMs: 1000,
      idempotencyKey: "claim",
    });
    expect(claim.claimed).toBe(true);
    yield* TestClock.adjust(1001);
    yield* billing.maintenance.run({ customerId: "clock" });
    expect(
      (yield* billing.workflows.get({ customerId: "clock", workflowId: "job" }))
        .status,
    ).toBe("reconciliation");
  }).pipe(
    Effect.provide(layer({ database: memoryStorage() })),
    Effect.provide(TestClock.layer()),
  );
  await Effect.runPromise(program);
});

test("interrupted memory transactions roll back and release customer locks", async () => {
  const storage = memoryStorage();
  await Effect.runPromise(
    Effect.gen(function* () {
      const changed = yield* Deferred.make<void>();
      const writer = yield* storage
        .atomic("customer", (tx) =>
          Effect.gen(function* () {
            yield* tx.put("counters", {
              id: "partial",
              state: "active",
              data: { amount: "1" },
            });
            yield* Deferred.succeed(changed, undefined);
            yield* Effect.never;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(changed);
      yield* Fiber.interrupt(writer);
      const value = yield* storage.read("customer", (tx) =>
        tx.get("counters", "partial"),
      );
      expect(value).toBeNull();
      yield* storage.atomic("customer", (tx) =>
        tx.put("counters", { id: "recovered", state: "active", data: {} }),
      );
    }),
  );
});

test("a cancelled semaphore waiter cannot retain a lock or commit later", async () => {
  const storage = memoryStorage();
  await Effect.runPromise(
    Effect.gen(function* () {
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const owner = yield* storage
        .atomic("same", () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(locked);
      const waiter = yield* storage
        .atomic("same", (tx) =>
          tx.put("counters", { id: "cancelled", state: "active", data: {} }),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiter);
      yield* storage.atomic("independent", (tx) =>
        tx.put("counters", { id: "ok", state: "active", data: {} }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
      expect(
        yield* storage.read("same", (tx) => tx.get("counters", "cancelled")),
      ).toBeNull();
    }),
  );
});

test("SQL cancellation waits for in-flight queries before rollback and release", async () => {
  const calls: string[] = [];
  let resolveQuery!: (value: { rows: unknown[] }) => void;
  const started = Deferred.makeUnsafe<void>();
  const client = {
    connect: async () => ({
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.startsWith("INSERT INTO brokeboy_counters")) {
          Effect.runSync(Deferred.succeed(started, undefined));
          return new Promise<{ rows: unknown[] }>((resolve) => {
            resolveQuery = resolve;
          });
        }
        return { rows: [] };
      },
      release: () => {
        calls.push("RELEASE");
      },
    }),
  };
  const storage = drizzleStorage({ $client: client }, { dialect: "postgres" });
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* storage
        .atomic("scope", (tx) =>
          tx.put("counters", { id: "pending", state: "active", data: {} }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(calls).not.toContain("ROLLBACK");
      expect(calls).not.toContain("RELEASE");
      resolveQuery({ rows: [] });
      yield* Fiber.join(interrupt);
      expect(calls.slice(-2)).toEqual(["ROLLBACK", "RELEASE"]);
      expect(calls).not.toContain("COMMIT");
    }),
  );
});

test("SQL failures remain tagged and always return the acquired connection", async () => {
  let released = 0;
  const storage = drizzleStorage(
    {
      $client: {
        connect: async () => ({
          query: async () => {
            throw new Error("database offline");
          },
          release: () => {
            released++;
          },
        }),
      },
    },
    { dialect: "postgres" },
  );
  const exit = await Effect.runPromiseExit(
    storage.read("scope", (tx) => tx.list("customers")),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit))
    expect(Cause.squash(exit.cause)).toBeInstanceOf(StorageError);
  expect(released).toBe(1);
});

test("an interrupted payment retains its lease and retries with the same provider identity", async () => {
  let now = Date.UTC(2026, 0, 1);
  const started = Deferred.makeUnsafe<void>();
  const identities: string[] = [];
  const billing = new EffectBilling({
    database: memoryStorage(),
    now: () => now,
    provider: {
      verify: () => Effect.succeed(null),
      reconcile: (event) => Effect.succeed(event),
      execute: (command) =>
        Effect.gen(function* () {
          identities.push(command.id);
          if (identities.length === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Effect.never;
          }
          return { id: "checkout", url: "https://checkout.stripe.com/test" };
        }),
    },
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* billing.catalog.publish({
        expectedRevision: 0,
        catalog: {
          features: [],
          plans: [
            {
              id: "paid",
              name: "Paid",
              amount: "1",
              interval: "month",
              items: [],
            },
          ],
        },
      });
      yield* billing.customers.create({ id: "a", idempotencyKey: "create" });
      const payment = yield* billing.subscriptions
        .checkout({
          customerId: "a",
          planId: "paid",
          successUrl: "https://example.test",
          idempotencyKey: "checkout",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(payment);
      expect((yield* billing.operations.list("a"))[0]?.status).toBe(
        "processing",
      );
      now += 120001;
      yield* billing.maintenance.run({ customerId: "a" });
      expect(identities).toHaveLength(2);
      expect(identities[0]).toBe(identities[1]);
      expect((yield* billing.operations.list("a"))[0]?.status).toBe("done");
    }),
  );
});

test("a failed rollback quarantines the SQL connection", async () => {
  const releases: (boolean | undefined)[] = [];
  const storage = drizzleStorage(
    {
      $client: {
        connect: async () => ({
          query: async (sql: string) => {
            if (sql === "ROLLBACK") throw new Error("connection lost");
            return { rows: [] };
          },
          release: (discard?: boolean) => {
            releases.push(discard);
          },
        }),
      },
    },
    { dialect: "postgres" },
  );
  const exit = await Effect.runPromiseExit(
    storage.atomic("scope", () =>
      Effect.fail(new StorageError({ message: "work failed", cause: null })),
    ),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(releases).toEqual([true]);
});

test("interrupted native HTTP handlers cancel and release their request stream", async () => {
  const waiting = Deferred.makeUnsafe<void>();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
    },
    pull() {
      Effect.runSync(Deferred.succeed(waiting, undefined));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("https://example.test/api/billing/controls", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      "content-type": "application/json",
    },
    body,
  });
  const handler = effectHandler({
    billing: new EffectBilling({ database: memoryStorage() }),
    resolveCustomer: () => Effect.succeed("a"),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* handler(request).pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      yield* Fiber.interrupt(fiber);
      expect(cancelled).toBe(true);
      expect(request.body!.locked).toBe(false);
    }),
  );
});

test("promise-provider overrides remain visible when lifting into Effect", async () => {
  const provider = promiseProvider({
    execute: () => Effect.succeed("original"),
    verify: () => Effect.succeed(null),
    reconcile: (event) => Effect.succeed(event),
  });
  provider.execute = async () => "overridden";
  const value = await Effect.runPromise(
    effectProvider(provider).execute({
      id: "test",
      kind: "test",
      customer: { id: "a", metadata: {}, controls: {} },
      input: {},
    }),
  );
  expect(value).toBe("overridden");
});

test("optional event callbacks retain their compatibility semantics after restart", async () => {
  const database = memoryStorage();
  const original = new EffectBilling({
    database,
    hooks: { onEvent: () => Effect.void },
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* original.customers.create({
        id: "hooks",
        idempotencyKey: "create",
      });
      yield* original.credits.grant({
        customerId: "hooks",
        feature: "credits",
        amount: "1",
        idempotencyKey: "grant",
      });
      const restarted = new EffectBilling({ database });
      yield* restarted.maintenance.run({ customerId: "hooks" });
      expect(
        (yield* restarted.operations.list("hooks")).every(
          (work) => work.status === "done",
        ),
      ).toBe(true);
      expect((yield* restarted.events.list("hooks")).length).toBeGreaterThan(0);
    }),
  );
});
