import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { test } from "node:test";
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import WebSocket, { WebSocketServer } from "ws";
import { drizzleAdapter, migrationSQL } from "../dist/drizzle.js";
import { brokeboy } from "../dist/index.js";

test("Neon WebSocket driver runs transactional billing over the PostgreSQL protocol", {
  skip: !process.env.TEST_POSTGRES_URL,
}, async () => {
  const target = new URL(process.env.TEST_POSTGRES_URL!);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  server.on("connection", (socket) => {
    const tcp = createConnection({
      host: target.hostname,
      port: Number(target.port || 5432),
    });
    socket.on("message", (data) => tcp.write(data as Buffer));
    tcp.on("data", (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });
    socket.on("close", () => tcp.destroy());
    tcp.on("close", () => socket.close());
    tcp.on("error", () => socket.close());
  });
  neonConfig.webSocketConstructor = WebSocket;
  neonConfig.wsProxy = () => `127.0.0.1:${address.port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineConnect = false;
  neonConfig.forceDisablePgSSL = true;
  const pool = new Pool({ connectionString: target.toString(), max: 4 });
  try {
    for (const sql of migrationSQL("postgres")) await pool.query(sql);
    const billing = brokeboy({
      database: drizzleAdapter(drizzle(pool), { dialect: "postgres" }),
    });
    const customerId = crypto.randomUUID();
    await billing.customers.create({
      id: customerId,
      idempotencyKey: "create",
    });
    await billing.credits.grant({
      customerId,
      feature: "credits",
      amount: "10",
      idempotencyKey: "grant",
    });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        billing.usage.consume({
          customerId,
          feature: "credits",
          amount: "3",
          idempotencyKey: `use-${i}`,
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
    assert.equal(
      (await billing.credits.balance({ customerId, feature: "credits" }))
        .available,
      "1",
    );
    assert.equal(
      (await billing.credits.reconcile(customerId)).consistent,
      true,
    );
  } finally {
    await pool.end();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
