// Run separately on both Node and Bun; this file is intentionally outside bun test discovery.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
type NativeProbe = {
  registerRequest(id: string): void;
  cancelRequest(id: string): boolean;
  inspectCustomer(
    scope: string,
    id: string,
    requestId: string,
  ): Promise<string | null>;
  close(): Promise<void>;
};
const native: {
  NativeBilling: {
    open(
      config: string,
      onEvent?: (event: string) => Promise<void>,
    ): Promise<NativeEngine>;
  };
  canonicalHashV1(json: string): string;
  NativeStorageProbe: { open(url: string): Promise<NativeProbe> };
} = require("../target/debug/brokeboy.node");

type NativeEngine = {
  registerRequest(id: string): void;
  cancelRequest(id: string): boolean;
  call(method: string, input: string, id: string): Promise<string>;
  webhook(headers: string, body: Buffer, id: string): Promise<string>;
  setTestClock(now: number): void;
  close(): Promise<void>;
};
async function invoke(handle: NativeEngine, method: string, input: unknown) {
  const request = crypto.randomUUID();
  handle.registerRequest(request);
  return JSON.parse(await handle.call(method, JSON.stringify(input), request));
}

test("the native billing engine settles workflows and supports reentrant event hooks", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "brokeboy-engine-"));
  let handle: NativeEngine | undefined;
  try {
    const path = resolve(directory, "billing.sqlite");
    const seeded = spawnSync("bun", ["scripts/seed-native-fixture.ts", path], {
      encoding: "utf8",
    });
    assert.equal(seeded.status, 0, seeded.stderr);
    const events: string[] = [];
    handle = await native.NativeBilling.open(
      JSON.stringify({
        database: { driver: "sqlite", url: `sqlite://${path}` },
      }),
      async (raw) => {
        const event = JSON.parse(raw);
        events.push(event.type);
        await invoke(handle!, "customers.get", { customerId: "native" });
      },
    );
    await invoke(handle, "credits.grant", {
      customerId: "native",
      feature: "budget",
      amount: "20.00",
      idempotencyKey: "fund",
    });
    const workflow = await invoke(handle, "workflows.create", {
      customerId: "native",
      workflowId: "pipeline",
      idempotencyKey: "start",
      steps: [
        { id: "generate", budgets: [{ feature: "budget", amount: "10" }] },
        {
          id: "publish",
          dependsOn: ["generate"],
          budgets: [{ feature: "budget", amount: "5" }],
        },
      ],
    });
    assert.equal(workflow.status, "active");
    for (const [stepId, amount] of [
      ["generate", "7.5"],
      ["publish", "3.25"],
    ]) {
      const claimed = await invoke(handle, "workflows.claim", {
        customerId: "native",
        workflowId: "pipeline",
        workerId: "worker",
        idempotencyKey: `claim-${stepId}`,
      });
      assert.equal(claimed.claimed, true);
      await invoke(handle, "workflows.complete", {
        customerId: "native",
        workflowId: "pipeline",
        stepId,
        token: claimed.step.lease.token,
        actuals: { budget: amount },
        idempotencyKey: `finish-${stepId}`,
      });
    }
    assert.equal(
      (
        await invoke(handle, "workflows.get", {
          customerId: "native",
          workflowId: "pipeline",
        })
      ).status,
      "succeeded",
    );
    const balance = await invoke(handle, "credits.balance", {
      customerId: "native",
      feature: "budget",
    });
    assert.equal(balance.available, "9.25");
    assert.equal(balance.reserved, "0");
    const batch = {
      customerId: "native",
      idempotencyKey: "batch",
      events: [
        { feature: "budget", amount: "0.25", idempotencyKey: "event-one" },
      ],
    };
    const first = await invoke(handle, "usage.batch", batch);
    assert.deepEqual(await invoke(handle, "usage.batch", batch), first);
    const maintenance = await invoke(handle, "maintenance.run", {
      customerId: "native",
      limit: 100,
    });
    assert.ok(maintenance.processed >= 1);
    assert.ok(events.includes("credits.granted"));
    assert.equal(
      (await invoke(handle, "credits.reconcile", { customerId: "native" }))
        .consistent,
      true,
    );
    const snapshot = await invoke(handle, "migration.export", {
      customerId: "native",
    });
    assert.deepEqual(snapshot.blockers, []);
    assert.equal(snapshot.format, 1);
  } finally {
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native hashing matches the frozen TypeScript oracle", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/compatibility/v1.json", import.meta.url),
      "utf8",
    ),
  );
  for (const item of fixture.hashes)
    assert.equal(native.canonicalHashV1(JSON.stringify(item.input)), item.hash);
});

test("Rust and the 0.1 TypeScript engine share spending and replay across processes", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "brokeboy-mixed-"));
  let handle: NativeEngine | undefined;
  try {
    const path = resolve(directory, "billing.sqlite");
    const seeded = spawnSync("bun", ["scripts/seed-native-fixture.ts", path], {
      encoding: "utf8",
    });
    assert.equal(seeded.status, 0, seeded.stderr);
    handle = await native.NativeBilling.open(
      JSON.stringify({
        database: { driver: "sqlite", url: `sqlite://${path}` },
      }),
    );
    await invoke(handle, "credits.grant", {
      customerId: "native",
      feature: "budget",
      amount: "50",
      idempotencyKey: "fund",
    });
    const child = spawn(
      "bun",
      ["scripts/legacy-financial-writer.ts", path, "native"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    let readyResolve: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("ready\n")) readyResolve();
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(child, "exit");
    try {
      await Promise.race([
        ready,
        exited.then(() => {
          if (!stdout.includes("ready\n"))
            throw new Error(`Legacy writer failed: ${stderr}`);
        }),
      ]);
      const nativeAttempts = await Promise.allSettled(
        Array.from({ length: 100 }, (_, i) =>
          invoke(handle!, "usage.consume", {
            customerId: "native",
            feature: "budget",
            amount: "1.00",
            idempotencyKey: `rust-${i}`,
          }),
        ),
      );
      const [code] = await exited;
      assert.equal(code, 0, stderr);
      const legacy = JSON.parse(stdout.trim().split("\n").at(-1)!);
      const winners = nativeAttempts.filter(
        (r) => r.status === "fulfilled",
      ).length;
      for (const result of nativeAttempts)
        if (result.status === "rejected")
          assert.match(String(result.reason), /insufficient_balance/);
      assert.equal(winners + legacy.successes, 50);
      assert.equal(
        (
          await invoke(handle, "credits.balance", {
            customerId: "native",
            feature: "budget",
          })
        ).available,
        "0",
      );
      const legacyRetry = {
        customerId: "native",
        feature: "budget",
        amount: "1.00",
        idempotencyKey: "legacy-0",
      };
      assert.deepEqual(
        await invoke(handle, "usage.consume", legacyRetry),
        legacy.first,
      );
      await assert.rejects(
        invoke(handle, "usage.consume", { ...legacyRetry, amount: "1" }),
        /idempotency_conflict/,
      );
      await invoke(handle, "credits.grant", {
        customerId: "native",
        feature: "budget",
        amount: "1",
        idempotencyKey: "replay-fund",
      });
      const rustReceipt = await invoke(handle, "usage.consume", {
        customerId: "native",
        feature: "budget",
        amount: "1.00",
        idempotencyKey: "rust-replay",
      });
      const replay = spawnSync(
        "bun",
        [
          "scripts/legacy-financial-writer.ts",
          path,
          "native",
          "replay",
          "rust-replay",
        ],
        { encoding: "utf8" },
      );
      assert.equal(replay.status, 0, replay.stderr);
      assert.deepEqual(JSON.parse(replay.stdout), rustReceipt);
      assert.equal(
        (await invoke(handle, "credits.reconcile", { customerId: "native" }))
          .consistent,
        true,
      );
    } finally {
      if (child.exitCode === null) child.kill();
    }
  } finally {
    await handle?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native SQLite reads existing rows asynchronously and shuts down", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "brokeboy-native-"));
  try {
    const path = resolve(directory, "billing.sqlite");
    const seeded = spawnSync("bun", ["scripts/seed-native-fixture.ts", path], {
      encoding: "utf8",
    });
    assert.equal(seeded.status, 0, seeded.stderr);
    const probe = await native.NativeStorageProbe.open(`sqlite://${path}`);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 0);
    try {
      const rows = await Promise.all(
        Array.from({ length: 100 }, (_, i) => {
          const id = `read-${i}`;
          probe.registerRequest(id);
          return probe.inspectCustomer("test:c:native", "native", id);
        }),
      );
      for (const row of rows)
        assert.equal(JSON.parse(row!).metadata.future, "preserved");
      assert.ok(ticks > 0, "native I/O must allow JavaScript timers to run");
      probe.registerRequest("isolated");
      assert.equal(
        await probe.inspectCustomer("live:c:native", "native", "isolated"),
        null,
      );
      probe.registerRequest("cancelled");
      assert.ok(probe.cancelRequest("cancelled"));
      await assert.rejects(
        probe.inspectCustomer("test:c:native", "native", "cancelled"),
        /interrupted/,
      );
      const holder = spawn("bun", ["scripts/hold-native-lock.ts", path], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(holder, "exit");
      try {
        const ready = await Promise.race([
          once(holder.stdout, "data").then(([data]) => String(data)),
          exited.then(() => {
            throw new Error(
              "Lock fixture exited before acquiring its transaction",
            );
          }),
        ]);
        assert.match(ready, /locked/);
        probe.registerRequest("cancel-during-io");
        const waiting = probe.inspectCustomer(
          "test:c:native",
          "native",
          "cancel-during-io",
        );
        const rejected = assert.rejects(waiting, /interrupted/);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(probe.cancelRequest("cancel-during-io"));
        await rejected;
        const [code] = await exited;
        assert.equal(code, 0);
      } finally {
        if (holder.exitCode === null) holder.kill();
      }
      const draining = Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => {
          const id = `drain-${i}`;
          probe.registerRequest(id);
          return probe.inspectCustomer("test:c:native", "native", id);
        }),
      );
      await probe.close();
      for (const result of await draining) {
        if (result.status === "rejected")
          assert.match(String(result.reason), /interrupted|billing_closed/);
        else assert.equal(JSON.parse(result.value!).id, "native");
      }
    } finally {
      clearInterval(timer);
      await probe.close();
      await probe.close();
    }
    await assert.rejects(
      probe.inspectCustomer("test:c:native", "native", "closed"),
      /billing_closed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native workflow recovery fences workers and preserves late-cost evidence", async () => {
  for (const mode of [
    "timeout",
    "overrun",
    "cancel",
    "retry",
    "heartbeat",
  ] as const) {
    const directory = await mkdtemp(resolve(tmpdir(), "brokeboy-recovery-"));
    let handle: NativeEngine | undefined;
    try {
      const path = resolve(directory, "billing.sqlite");
      assert.equal(
        spawnSync("bun", ["scripts/seed-native-fixture.ts", path]).status,
        0,
      );
      let now = Date.UTC(2026, 0, 1);
      handle = await native.NativeBilling.open(
        JSON.stringify({
          database: { driver: "sqlite", url: `sqlite://${path}` },
          testClockMs: now,
        }),
      );
      const scope = { customerId: "native", workflowId: "job" };
      await invoke(handle, "credits.grant", {
        customerId: "native",
        feature: "credits",
        amount: "100",
        idempotencyKey: "fund",
      });
      await invoke(handle, "workflows.create", {
        ...scope,
        steps: [
          { id: "run", budgets: [{ feature: "credits", amount: "10" }] },
          {
            id: "later",
            dependsOn: ["run"],
            budgets: [{ feature: "credits", amount: "5" }],
          },
        ],
        expiresAt: now + 60_000,
        idempotencyKey: "start",
      });
      const claim = await invoke(handle, "workflows.claim", {
        ...scope,
        workerId: "worker",
        leaseMs: 1000,
        idempotencyKey: "claim",
      });
      const worker = { ...scope, stepId: "run", token: claim.step.lease.token };
      let spent = "3";
      if (mode === "timeout") {
        now += 1001;
        handle.setTestClock(now);
        await invoke(handle, "maintenance.run", { customerId: "native" });
        assert.equal(
          (await invoke(handle, "workflows.get", scope)).status,
          "reconciliation",
        );
        const late = await invoke(handle, "workflows.complete", {
          ...worker,
          actuals: { credits: "3" },
          idempotencyKey: "late",
        });
        assert.deepEqual(late.steps[0].reportedActuals, { credits: "3" });
        assert.equal(
          (
            await invoke(handle, "credits.balance", {
              customerId: "native",
              feature: "credits",
            })
          ).spent,
          "0",
        );
        await invoke(handle, "workflows.resolve", {
          ...scope,
          stepId: "run",
          outcome: "succeeded",
          actuals: { credits: "3" },
          reason: "Verified external completion",
          idempotencyKey: "resolve",
        });
      } else if (mode === "overrun") {
        const overrun = await invoke(handle, "workflows.complete", {
          ...worker,
          actuals: { credits: "12" },
          idempotencyKey: "overrun",
        });
        assert.equal(overrun.status, "reconciliation");
        await invoke(handle, "workflows.resolve", {
          ...scope,
          stepId: "run",
          outcome: "succeeded",
          fundUncovered: true,
          actuals: { credits: "12" },
          reason: "Approved additional funding",
          idempotencyKey: "resolve",
        });
        spent = "12";
      } else if (mode === "cancel") {
        assert.equal(
          (
            await invoke(handle, "workflows.cancel", {
              ...scope,
              reason: "User cancelled",
              idempotencyKey: "cancel",
            })
          ).status,
          "reconciliation",
        );
        const resolved = await invoke(handle, "workflows.resolve", {
          ...scope,
          stepId: "run",
          outcome: "failed",
          actuals: { credits: "3" },
          reason: "Confirmed partial external cost",
          idempotencyKey: "resolve",
        });
        assert.equal(resolved.status, "cancelled");
      } else if (mode === "retry") {
        await invoke(handle, "workflows.fail", {
          ...worker,
          code: "request_not_sent",
          retrySafe: true,
          retryAfterMs: 2000,
          idempotencyKey: "fail",
        });
        assert.equal(
          (
            await invoke(handle, "workflows.claim", {
              ...scope,
              workerId: "next",
              idempotencyKey: "early",
            })
          ).claimed,
          false,
        );
        now += 2000;
        handle.setTestClock(now);
        const next = await invoke(handle, "workflows.claim", {
          ...scope,
          workerId: "next",
          idempotencyKey: "next",
        });
        assert.notEqual(next.step.lease.token, worker.token);
        await assert.rejects(
          invoke(handle, "workflows.complete", {
            ...worker,
            actuals: { credits: "3" },
            idempotencyKey: "stale",
          }),
          /workflow_lease_lost/,
        );
        await invoke(handle, "workflows.complete", {
          ...worker,
          token: next.step.lease.token,
          actuals: { credits: "3" },
          idempotencyKey: "done",
        });
      } else {
        now += 500;
        handle.setTestClock(now);
        await invoke(handle, "workflows.heartbeat", {
          ...worker,
          leaseMs: 2000,
          idempotencyKey: "beat",
        });
        now += 501;
        handle.setTestClock(now);
        await invoke(handle, "maintenance.run", { customerId: "native" });
        assert.equal(
          (await invoke(handle, "workflows.get", scope)).steps[0].status,
          "running",
        );
        await invoke(handle, "workflows.complete", {
          ...worker,
          actuals: { credits: "3" },
          idempotencyKey: "done",
        });
      }
      assert.equal(
        (
          await invoke(handle, "credits.balance", {
            customerId: "native",
            feature: "credits",
          })
        ).spent,
        spent,
        mode,
      );
      assert.equal(
        (await invoke(handle, "credits.reconcile", { customerId: "native" }))
          .consistent,
        true,
        mode,
      );
    } finally {
      await handle?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
