// Distribution-level contract: execute built JavaScript on Node and Bun.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import type { EffectBilling } from "../dist/core/engine.js";
import {
  addInterval,
  Billing,
  defineCatalog,
  rateUsage,
} from "../dist/native.js";
import { nativeTransport } from "../dist/native-bridge.js";
import { make } from "../dist/native-effect.js";
import { toHandler } from "../dist/server.js";

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "brokeboy-sdk-"));
  const path = resolve(directory, "billing.sqlite");
  const seed = spawnSync("bun", ["scripts/seed-native-fixture.ts", path], {
    encoding: "utf8",
  });
  assert.equal(seed.status, 0, seed.stderr);
  return {
    directory,
    options: {
      database: { driver: "sqlite" as const, url: `sqlite://${path}` },
    },
  };
}

test("native promise SDK works with authenticated HTTP and redacts private state", async () => {
  const { directory, options } = await fixture();
  const billing = await Billing.open(options);
  try {
    assert.equal(await Promise.resolve(billing.catalog), billing.catalog);
    assert.equal(JSON.stringify(billing.catalog), "{}");
    assert.equal(String(billing.catalog), "[object Object]");
    const catalog = defineCatalog({
      features: [{ id: "credits", kind: "consumable" }],
      plans: [
        {
          id: "free",
          name: "Free",
          kind: "free",
          items: [{ feature: "credits", included: "10" }],
        },
        {
          id: "private",
          name: "Private deal",
          kind: "free",
          public: false,
          items: [],
        },
      ],
    });
    await billing.catalog.publish({ catalog, expectedRevision: 0 });
    await billing.customers.create({ id: "other", idempotencyKey: "other" });
    const handler = toHandler({
      billing,
      resolveCustomer: async (request) =>
        request.headers.has("authorization") ? "native" : null,
    });
    const get = (path: string) =>
      handler(
        new Request(`https://app.example/api/billing${path}`, {
          headers: { authorization: "session" },
        }),
      );
    assert.equal(
      (await handler(new Request("https://app.example/api/billing/customer")))
        .status,
      401,
    );
    const plans = await (await get("/catalog")).json();
    assert.equal(plans.plans.length, 1);
    assert.equal(plans.plans[0].id, "free");
    assert.equal(plans.plans[0].items, undefined);
    const post = (
      path: string,
      value: unknown,
      origin = "https://app.example",
    ) =>
      handler(
        new Request(`https://app.example/api/billing${path}`, {
          method: "POST",
          headers: {
            authorization: "session",
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify(value),
        }),
      );
    assert.equal(
      (
        await post(
          "/checkout",
          {
            idempotencyKey: "forged",
            planId: "free",
            successUrl: "https://app.example/success",
          },
          "https://attacker.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post("/checkout", {
          idempotencyKey: "private",
          planId: "private",
          successUrl: "https://app.example/success",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post("/checkout", {
          customerId: "other",
          idempotencyKey: "attach",
          planId: "free",
          successUrl: "https://app.example/success",
        })
      ).status,
      200,
    );
    assert.equal((await billing.subscriptions.list("native")).length, 1);
    assert.equal((await billing.subscriptions.list("other")).length, 0);
    const customer = await (await get("/customer?customerId=other")).json();
    assert.equal(customer.id, "native");
    assert.equal(customer.metadata, undefined);
    assert.equal((await get("/admin/customer?customerId=native")).status, 403);
    await assert.rejects(
      billing.usage.consume({
        customerId: "native",
        feature: "credits",
        amount: "1",
        idempotencyKey: "bad",
        properties: { bad: Number.NaN as unknown as string },
      }),
      (error: any) => error.code === "invalid_json",
    );
    const receipt = await billing.usage.consume({
      customerId: "native",
      feature: "credits",
      amount: "1.00",
      idempotencyKey: "consume",
    });
    assert.deepEqual(
      await billing.usage.consume({
        customerId: "native",
        feature: "credits",
        amount: "1.00",
        idempotencyKey: "consume",
      }),
      receipt,
    );
    assert.equal(
      (
        await billing.credits.balance({
          customerId: "native",
          feature: "credits",
        })
      ).available,
      "9",
    );
  } finally {
    await billing.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native Effect acquisition is scoped, lazy, and translates domain errors", async () => {
  const { directory, options } = await fixture();
  let effects: EffectBilling | undefined;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const billing = yield* make(options);
          effects = billing;
          assert.equal(JSON.stringify(billing.catalog), "{}");
          assert.equal(String(billing.catalog), "[object Object]");
          const create = billing.customers.create({
            id: "scoped",
            idempotencyKey: "create",
          });
          const absent = yield* Effect.flip(billing.customers.get("scoped"));
          assert.equal(absent._tag, "BillingError");
          yield* create;
          const error = yield* Effect.flip(
            billing.usage.consume({
              customerId: "scoped",
              feature: "credits",
              amount: "1",
              idempotencyKey: "no-funds",
            }),
          );
          assert.equal(error._tag, "BillingError");
          if (error._tag === "BillingError")
            assert.equal(error.code, "insufficient_balance");
        }),
      ),
    );
    assert.ok(effects);
    const closed = await Effect.runPromise(
      Effect.flip(effects.customers.get("scoped")),
    );
    assert.equal((closed as any).code, "billing_closed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native backup restores operation receipts without repeating a debit", async () => {
  const { directory, options } = await fixture();
  const billing = await Billing.open(options);
  try {
    await billing.credits.grant({
      customerId: "native",
      feature: "credits",
      amount: "10",
      idempotencyKey: "fund-backup",
    });
    const payload = {
      customerId: "native",
      feature: "credits",
      amount: "2.50",
      idempotencyKey: "before-backup",
    };
    const receipt = await billing.usage.consume(payload);
    await billing.close();
    const backup = resolve(directory, "restored.sqlite");
    await copyFile(resolve(directory, "billing.sqlite"), backup);
    const restored = await Billing.open({
      database: { driver: "sqlite", url: `sqlite://${backup}` },
    });
    try {
      assert.deepEqual(await restored.usage.consume(payload), receipt);
      assert.equal(
        (
          await restored.credits.balance({
            customerId: "native",
            feature: "credits",
          })
        ).available,
        "7.5",
      );
      assert.equal(
        (await restored.credits.reconcile("native")).consistent,
        true,
      );
      assert.equal(
        (await restored.customers.get("native")).metadata.future,
        "preserved",
      );
    } finally {
      await restored.close();
    }
  } finally {
    await billing.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native public pricing and calendar helpers match frozen wire fixtures", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/compatibility/v1.json", import.meta.url),
      "utf8",
    ),
  );
  for (const item of fixture.pricing) {
    if (item.error)
      assert.throws(
        () => rateUsage(item.rate, item.quantity, item.properties),
        (error: any) => error.code === item.error,
      );
    else
      assert.equal(
        rateUsage(item.rate, item.quantity, item.properties),
        item.result,
      );
  }
  for (const item of fixture.calendars)
    assert.equal(
      addInterval(item.start, item.interval, item.count),
      item.result,
    );
});

test("native webhook input is bounded and interrupted streams release their reader", async () => {
  const { directory, options } = await fixture();
  const billing = await Billing.open(options);
  try {
    let oversizedCancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      },
      cancel() {
        oversizedCancelled = true;
      },
    });
    const oversizedOptions = {
      method: "POST",
      body: oversized,
      duplex: "half",
    };
    await assert.rejects(
      billing.webhook(
        new Request(
          "https://app.example/api/billing/webhook",
          oversizedOptions,
        ),
      ),
      (error: any) => error.code === "body_too_large",
    );
    assert.equal(oversizedCancelled, true);
    assert.equal(oversized.locked, false);
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const streamOptions = {
      method: "POST",
      body: stream,
      duplex: "half",
      signal: controller.signal,
    };
    const pending = billing.webhook(
      new Request("https://app.example/api/billing/webhook", streamOptions),
    );
    controller.abort();
    await assert.rejects(pending, (error: any) => error.code === "interrupted");
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
    const requestAbort = new AbortController();
    let requestCancelled = false;
    const requestStream = new ReadableStream<Uint8Array>({
      cancel() {
        requestCancelled = true;
      },
    });
    const requestOptions = {
      method: "POST",
      body: requestStream,
      duplex: "half",
      signal: requestAbort.signal,
    };
    const separateSignal = new AbortController().signal;
    const combined = billing[nativeTransport].webhook(
      new Request("https://app.example/api/billing/webhook", requestOptions),
      separateSignal,
    );
    requestAbort.abort();
    await assert.rejects(
      combined,
      (error: any) => error.code === "interrupted",
    );
    assert.equal(requestCancelled, true);
    assert.equal(requestStream.locked, false);
    const consumed = new Request("https://app.example/api/billing/webhook", {
      method: "POST",
      body: "already parsed",
    });
    await consumed.text();
    await assert.rejects(
      billing.webhook(consumed),
      (error: any) => error.code === "invalid_body",
    );
    assert.equal((await billing.customers.get("native")).id, "native");
  } finally {
    await billing.close();
    await rm(directory, { recursive: true, force: true });
  }
});
