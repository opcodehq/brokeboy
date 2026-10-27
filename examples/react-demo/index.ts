import { brokeboy } from "../../src/index.js";
import { memoryAdapter } from "../../src/memory.js";
import { toHandler } from "../../src/server.js";

const billing = brokeboy({ database: memoryAdapter() });
await billing.catalog.publish({
  catalog: {
    features: [{ id: "credits", kind: "consumable" }],
    plans: [
      {
        id: "free",
        name: "Free",
        kind: "free",
        items: [{ feature: "credits", included: "100", reset: "month" }],
      },
    ],
  },
  expectedRevision: 0,
});
await billing.customers.create({ id: "demo", idempotencyKey: "create" });
await billing.subscriptions.attach({
  customerId: "demo",
  planId: "free",
  idempotencyKey: "free",
});
const handler = toHandler({ billing, resolveCustomer: async () => "demo" });
const bundle = await Bun.build({
  entrypoints: ["examples/react-demo/app.tsx"],
  target: "browser",
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
});
if (!bundle.success) throw new Error("Demo bundle failed");
const js = await bundle.outputs[0]!.text();
Bun.serve({
  hostname: "127.0.0.1",
  port: 32109,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/billing/")) return handler(request);
    if (path === "/app.js")
      return new Response(js, {
        headers: { "content-type": "text/javascript" },
      });
    if (path !== "/") return new Response("Not found", { status: 404 });
    return new Response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brokeboy toolkit demo</title><style>body{font-family:system-ui,sans-serif;color:#212121;background:#fafaf8;margin:0}main{max-width:760px;margin:48px auto;padding:24px}h1{font-size:36px;letter-spacing:-1px}section{padding:16px 0}button,input{font:inherit;padding:6px 10px;margin:4px}label{display:block}output{font-size:22px}article{padding:12px;background:#f0f0eb}p{line-height:1.6}form{max-width:420px}input{display:block;width:90%}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
      { headers: { "content-type": "text/html" } },
    );
  },
});
console.log("Brokeboy local toolkit demo: http://127.0.0.1:32109");
