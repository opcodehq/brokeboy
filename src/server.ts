import type { Billing } from "./core/engine.js";
import { assert, BillingError, identifier } from "./core/errors.js";
import type { PublishedPlan, Work } from "./core/types.js";
import { returnUrl as safeReturnUrl } from "./core/urls.js";
import type { JsonValue } from "./core/workflows.js";
export type HandlerOptions = {
  billing: Billing;
  basePath?: string;
  resolveCustomer(request: Request): Promise<string | null>;
  authorizeAdmin?: (request: Request) => Promise<{ actorId: string } | null>;
  authorizePlan?: (customerId: string, plan: PublishedPlan) => Promise<boolean>;
  trustedOrigins?: string[];
};
const response = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
function publicPlan(plan: PublishedPlan) {
  return {
    id: plan.id,
    name: plan.name,
    version: plan.version,
    currency: plan.currency,
    amount: plan.amount,
    interval: plan.interval,
    kind: plan.kind,
    trialDays: plan.trialDays,
    features: plan.items.map((i) => ({
      feature: i.feature,
      included: i.included,
      enabled: i.enabled,
    })),
  };
}
function operationResponse(work: Work) {
  const result = work.result as
    | { id?: string; url?: string; status?: string }
    | undefined;
  return response({
    id: work.id,
    status: work.status,
    error: work.error,
    result: result
      ? { id: result.id, url: result.url, status: result.status }
      : undefined,
  });
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  assert(
    request.headers.get("content-type")?.split(";")[0] === "application/json",
    "invalid_content_type",
  );
  const reader = request.body?.getReader();
  assert(reader, "invalid_json");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new BillingError("body_too_large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BillingError("invalid_json");
  }
  assert(
    body && typeof body === "object" && !Array.isArray(body),
    "invalid_json",
  );
  return body as Record<string, unknown>;
}
const string = (body: Record<string, unknown>, key: string) => {
  const value = body[key];
  assert(typeof value === "string", "invalid_input", `Missing ${key}.`);
  return value;
};
export function toHandler(
  options: HandlerOptions,
): (request: Request) => Promise<Response> {
  const billing = options.billing,
    base = (options.basePath ?? "/api/billing").replace(/\/$/, "");
  return async (request) => {
    try {
      const url = new URL(request.url);
      assert(
        url.pathname === base || url.pathname.startsWith(`${base}/`),
        "not_found",
      );
      const path = url.pathname.slice(base.length) || "/";
      if (path === "/webhook") {
        assert(request.method === "POST", "method_not_allowed");
        return response(await billing.webhook(request));
      }
      assert(["GET", "POST"].includes(request.method), "method_not_allowed");
      if (request.method === "POST") {
        const origin = request.headers.get("origin");
        assert(
          origin &&
            (origin === url.origin || options.trustedOrigins?.includes(origin)),
          "origin_not_allowed",
        );
      }
      if (path.startsWith("/admin/")) {
        const admin = await options.authorizeAdmin?.(request);
        assert(admin, "forbidden");
        const id = url.searchParams.get("customerId");
        assert(id, "invalid_input");
        identifier(id);
        if (request.method === "GET" && path === "/admin/customer")
          return response({
            customer: await billing.customers.get(id),
            grants: await billing.credits.list({ customerId: id }),
            operations: await billing.operations.list(id),
            ledger: await billing.credits.reconcile(id),
            workflows: await billing.workflows.page({ customerId: id }),
          });
        if (request.method === "GET" && path === "/admin/workflows")
          return response(
            await billing.workflows.page({
              customerId: id,
              entityId: url.searchParams.get("entityId") ?? undefined,
              cursor: url.searchParams.get("cursor") ?? undefined,
            }),
          );
        if (path === "/admin/workflow" && request.method === "GET") {
          const workflowId = url.searchParams.get("workflowId");
          assert(workflowId, "invalid_input");
          return response(
            await billing.workflows.get({
              customerId: id,
              workflowId,
              entityId: url.searchParams.get("entityId") ?? undefined,
            }),
          );
        }
        if (request.method === "POST" && path === "/admin/workflow/resolve") {
          const body = await readBody(request);
          const outcome = string(body, "outcome");
          const reason = string(body, "reason");
          assert(reason.trim(), "reason_required");
          assert(
            ["retry", "succeeded", "failed"].includes(outcome),
            "invalid_input",
          );
          assert(
            body.fundUncovered === undefined ||
              typeof body.fundUncovered === "boolean",
            "invalid_input",
          );
          let actuals: Record<string, string> | undefined;
          if (body.actuals !== undefined) {
            assert(
              body.actuals &&
                typeof body.actuals === "object" &&
                !Array.isArray(body.actuals),
              "invalid_input",
            );
            actuals = {};
            for (const [feature, amount] of Object.entries(body.actuals)) {
              identifier(feature);
              assert(typeof amount === "string", "invalid_decimal");
              actuals[feature] = amount;
            }
          }
          return response(
            await billing.workflows.resolve({
              customerId: id,
              entityId:
                body.entityId === undefined
                  ? undefined
                  : string(body, "entityId"),
              workflowId: string(body, "workflowId"),
              stepId: string(body, "stepId"),
              idempotencyKey: string(body, "idempotencyKey"),
              outcome: outcome as "retry" | "succeeded" | "failed",
              actuals,
              fundUncovered: body.fundUncovered as boolean | undefined,
              result: body.result as JsonValue | undefined,
              reason: `${admin.actorId}: ${reason}`,
            }),
          );
        }
        if (request.method === "POST" && path === "/admin/adjust") {
          const body = await readBody(request);
          const reason = string(body, "reason");
          return response(
            await billing.credits.adjust({
              customerId: id,
              idempotencyKey: string(body, "idempotencyKey"),
              grantId: string(body, "grantId"),
              amount: string(body, "amount"),
              reason: `${admin.actorId}: ${reason}`,
            }),
          );
        }
        if (request.method === "POST" && path === "/admin/retry") {
          const body = await readBody(request);
          return response(
            await billing.operations.retry({
              customerId: id,
              idempotencyKey: string(body, "idempotencyKey"),
              operationId: string(body, "operationId"),
            }),
          );
        }
        throw new BillingError("not_found");
      }
      const customerId = await options.resolveCustomer(request);
      assert(customerId, "unauthenticated");
      identifier(customerId);
      if (request.method === "GET") {
        if (path === "/catalog") {
          const catalog = await billing.catalog.export();
          const latest = new Map<string, PublishedPlan>();
          for (const plan of catalog.plans)
            if (
              !latest.has(plan.id) ||
              latest.get(plan.id)!.revision < plan.revision
            )
              latest.set(plan.id, plan);
          const plans = [];
          for (const plan of latest.values())
            if (
              plan.public !== false &&
              (!options.authorizePlan ||
                (await options.authorizePlan(customerId, plan)))
            )
              plans.push(publicPlan(plan));
          return response({ plans });
        }
        if (path === "/customer") {
          const customer = await billing.customers.get(customerId);
          return response({ id: customer.id, controls: customer.controls });
        }
        if (path === "/balance") {
          const feature = url.searchParams.get("feature");
          assert(feature, "invalid_input");
          return response(
            await billing.credits.balance({
              customerId,
              feature: identifier(feature),
            }),
          );
        }
        if (path === "/controls")
          return response(await billing.billingControls.get(customerId));
        if (path === "/subscriptions")
          return response({
            subscriptions: (await billing.subscriptions.list(customerId)).map(
              (s) => ({
                id: s.id,
                status: s.status,
                plan: publicPlan(s.plan),
                periodEnd: s.periodEnd,
                quantity: s.quantity,
                cancelAtPeriodEnd: s.cancelAtPeriodEnd,
              }),
            ),
          });
        if (path === "/usage")
          return response({
            usage: (await billing.usage.list({ customerId })).map((u) => ({
              id: u.id,
              feature: u.feature,
              quantity: u.quantity,
              createdAt: u.createdAt,
            })),
          });
      } else {
        const body = await readBody(request),
          key = identifier(string(body, "idempotencyKey"));
        if (path === "/controls") {
          const limits = body.overageLimits;
          assert(
            limits && typeof limits === "object" && !Array.isArray(limits),
            "invalid_input",
          );
          const overageLimits: Record<string, string> = {};
          for (const [feature, amount] of Object.entries(limits)) {
            identifier(feature);
            assert(typeof amount === "string", "invalid_decimal");
            overageLimits[feature] = amount;
          }
          const current = await billing.billingControls.get(customerId);
          return response(
            await billing.billingControls.update({
              customerId,
              idempotencyKey: key,
              controls: { ...current, overageLimits },
            }),
          );
        }
        if (path === "/checkout") {
          const plan = await billing.catalog.get(string(body, "planId"));
          assert(
            plan.public !== false &&
              (!options.authorizePlan ||
                (await options.authorizePlan(customerId, plan))),
            "forbidden",
          );
          const successUrl = new URL(safeReturnUrl(string(body, "successUrl")));
          assert(
            successUrl.origin === url.origin ||
              options.trustedOrigins?.includes(successUrl.origin),
            "origin_not_allowed",
          );
          if (
            plan.kind === "free" &&
            !plan.items.some((item) => item.overage)
          ) {
            const subscription = await billing.subscriptions.attach({
              customerId,
              idempotencyKey: key,
              planId: plan.id,
              version: plan.version,
            });
            return response({
              status: "done",
              result: { id: subscription.id },
            });
          }
          return operationResponse(
            await billing.subscriptions.checkout({
              customerId,
              idempotencyKey: key,
              planId: plan.id,
              version: plan.version,
              successUrl: successUrl.toString(),
              quantity:
                typeof body.quantity === "string" ? body.quantity : undefined,
            }),
          );
        }
        if (path === "/portal") {
          const returnUrl = new URL(safeReturnUrl(string(body, "returnUrl")));
          assert(
            returnUrl.origin === url.origin ||
              options.trustedOrigins?.includes(returnUrl.origin),
            "origin_not_allowed",
          );
          return operationResponse(
            await billing.subscriptions.portal({
              customerId,
              idempotencyKey: key,
              returnUrl: returnUrl.toString(),
            }),
          );
        }
        if (path === "/cancel")
          return operationResponse(
            await billing.subscriptions.cancel({
              customerId,
              idempotencyKey: key,
              subscriptionId: string(body, "subscriptionId"),
            }),
          );
      }
      throw new BillingError("not_found");
    } catch (error) {
      if (error instanceof BillingError) {
        const code = error.code;
        const status =
          code === "unauthenticated"
            ? 401
            : ["forbidden", "origin_not_allowed"].includes(code)
              ? 403
              : code === "not_found"
                ? 404
                : code === "method_not_allowed"
                  ? 405
                  : code === "body_too_large"
                    ? 413
                    : ["idempotency_conflict", "catalog_conflict"].includes(
                          code,
                        )
                      ? 409
                      : 400;
        return response({ error: { code, message: code } }, status);
      }
      return response({ error: { code: "internal_error" } }, 500);
    }
  };
}
