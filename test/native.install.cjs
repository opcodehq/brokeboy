// Compiler-free execution check for a staged, platform-specific package.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const directory = resolve(process.argv[2] ?? "target/npm/platform");
const native = require(join(directory, "brokeboy.node"));
const executable = join(
  directory,
  process.platform === "win32" ? "brokeboy-native.exe" : "brokeboy-native",
);
const fixture = mkdtempSync(join(tmpdir(), "brokeboy-installed-"));
(async () => {
  let billing;
  try {
    assert.equal(
      native.canonicalHashV1('{"a":1}'),
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
    const schema = spawnSync(executable, ["schema", "sqlite"], {
      encoding: "utf8",
    });
    assert.equal(schema.status, 0, schema.stderr);
    const path = join(fixture, "billing.sqlite");
    const db = new DatabaseSync(path);
    db.exec(schema.stdout);
    db.close();
    const config = { database: { driver: "sqlite", url: `sqlite://${path}` } };
    billing = await native.NativeBilling.open(JSON.stringify(config));
    let sequence = 0;
    const call = async (method, input) => {
      const id = `installed-${++sequence}`;
      billing.registerRequest(id);
      return JSON.parse(await billing.call(method, JSON.stringify(input), id));
    };
    await call("customers.create", {
      id: "installed",
      idempotencyKey: "create",
    });
    await call("credits.grant", {
      customerId: "installed",
      feature: "requests",
      amount: "5",
      idempotencyKey: "fund",
    });
    const payload = {
      customerId: "installed",
      feature: "requests",
      amount: "1.25",
      idempotencyKey: "consume",
    };
    assert.deepEqual(
      await call("usage.consume", payload),
      await call("usage.consume", payload),
    );
    assert.equal(
      (
        await call("credits.balance", {
          customerId: "installed",
          feature: "requests",
        })
      ).available,
      "3.75",
    );
    await billing.close();
    billing = undefined;
    const configPath = join(fixture, "brokeboy.json");
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const doctor = spawnSync(executable, ["--config", configPath, "doctor"], {
      encoding: "utf8",
    });
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).ok, true);
    const cli = (args, input) => {
      const result = spawnSync(executable, ["--config", configPath, ...args], {
        encoding: "utf8",
        input: input === undefined ? undefined : JSON.stringify(input),
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const catalog = {
      features: [{ id: "requests", kind: "consumable" }],
      plans: [
        {
          id: "free",
          name: "Free",
          kind: "free",
          items: [{ feature: "requests", included: "10" }],
        },
      ],
    };
    cli(["call", "catalog.publish", "-"], { catalog, expectedRevision: 0 });
    catalog.plans[0].items[0].included = "20";
    cli(["call", "catalog.publish", "-"], { catalog, expectedRevision: 1 });
    const exported = cli(["catalog", "export"]);
    assert.equal(exported.catalog.plans.length, 1);
    assert.equal(exported.catalog.plans[0].items[0].included, "20");
    assert.equal(exported.expectedRevision, 2);
    assert.equal(cli(["customer", "inspect", "installed"]).id, "installed");
    assert.equal(cli(["reconcile", "installed"]).consistent, true);
    const snapshot = cli(["migrate", "export", "installed"]);
    assert.deepEqual(snapshot.blockers, []);
    const inputPath = join(fixture, "import.json");
    writeFileSync(
      inputPath,
      JSON.stringify({ snapshot, idempotencyKey: "import", dryRun: true }),
    );
    assert.equal(cli(["migrate", "import", inputPath]).dryRun, true);
    const missing = new DatabaseSync(path);
    missing.exec("DROP TABLE brokeboy_workflows");
    missing.close();
    const unhealthy = spawnSync(
      executable,
      ["--config", configPath, "doctor"],
      { encoding: "utf8" },
    );
    assert.equal(unhealthy.status, 1);
    assert.match(unhealthy.stderr, /doctor_failed/);
    const inspect = new DatabaseSync(path);
    assert.equal(
      inspect
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name='brokeboy_workflows'",
        )
        .get().n,
      0,
    );
    inspect.close();
    console.log(
      JSON.stringify({
        passed: true,
        platform: process.platform,
        arch: process.arch,
        compilerRequired: false,
      }),
    );
  } finally {
    await billing?.close();
    rmSync(fixture, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
