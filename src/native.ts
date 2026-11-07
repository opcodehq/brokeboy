import { randomUUID } from "node:crypto";
import type { Billing as LegacySurface } from "./billing.js";
import type {
  Catalog,
  Environment,
  Metadata,
  OpenConfig,
  Rate,
} from "./generated/models.js";
import { MAX_WEBHOOK_BYTES } from "./generated/models.js";
import {
  type NativeTransport,
  nativeGroups,
  nativeMethodKey,
  nativeObjectProperty,
  nativeTransport,
} from "./native-bridge.js";
import { loadNative, type NativeHandle } from "./native-loader.js";
import { readRequestBytes } from "./request-body.js";

export type * from "./generated/models.js";

function encode(value: unknown): string {
  const path = new Set<object>();
  const visit = (v: unknown, depth: number, inArray = false): void => {
    if (depth > 120)
      throw new BillingError(
        "invalid_json",
        "Billing input exceeds the JSON nesting limit.",
      );
    if (v === undefined && !inArray) return;
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || v === null)
      throw new BillingError(
        "invalid_json",
        "Billing input must contain JSON values.",
      );
    if (path.has(v))
      throw new BillingError(
        "invalid_json",
        "Billing input must not contain cycles.",
      );
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      throw new BillingError(
        "invalid_json",
        "Billing input must contain plain JSON objects.",
      );
    path.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) visit(v[i], depth + 1, true);
    } else {
      for (const item of Object.values(v)) visit(item, depth + 1);
    }
    path.delete(v);
  };
  visit(value, 0);
  return JSON.stringify(value);
}

export class BillingError extends Error {
  readonly _tag = "BillingError";
  constructor(
    readonly code: string,
    message = code,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BillingError";
  }
}
export function nativeError(error: unknown): BillingError {
  if (error instanceof BillingError) return error;
  const text = error instanceof Error ? error.message : "native_error";
  try {
    const wire = JSON.parse(text);
    if (
      wire &&
      typeof wire.code === "string" &&
      typeof wire.message === "string"
    )
      return new BillingError(wire.code, wire.message, wire.details);
  } catch {}
  return new BillingError(
    /^[a-z_]+$/.test(text) ? text : "native_error",
    "Native billing operation failed.",
  );
}
export type BillingOptions = OpenConfig & {
  hooks?: {
    onEvent?: (event: {
      id: string;
      type: string;
      customerId: string;
      data: unknown;
    }) => Promise<void>;
  };
};

function payload(method: string, args: unknown[]): unknown {
  if (method === "catalog.get") return { id: args[0], version: args[1] };
  if (method === "resources.inspect") return { key: args[0] };
  if (method === "operations.get")
    return { customerId: args[0], operationId: args[1] };
  if (method === "operations.page" || method === "events.page")
    return { ...((args[1] ?? {}) as object), customerId: args[0] };
  if (
    [
      "customers.get",
      "entities.list",
      "credits.reconcile",
      "subscriptions.list",
      "reservations.list",
      "licenses.list",
      "billingControls.get",
      "operations.list",
      "events.list",
      "migration.export",
    ].includes(method)
  )
    return { customerId: args[0] };
  return args[0] ?? {};
}
// During parity qualification, the established signatures remain the compatibility
// contract. All execution through this entry point goes to Rust.
export interface Billing
  extends Omit<LegacySurface, "environment" | "webhook"> {}
export class Billing {
  readonly environment: Environment;
  readonly [nativeTransport]: NativeTransport;
  private constructor(
    private readonly handle: NativeHandle,
    environment: Environment,
  ) {
    this.environment = environment;
    this[nativeTransport] = {
      environment,
      invoke: (method, args, signal) => this.invoke(method, args, signal),
      validate: (catalog) => this.validate(catalog),
      webhook: (request, signal) => this.receiveWebhook(request, signal),
    };
    for (const group of nativeGroups) {
      const methods = new Map<string, unknown>();
      Object.defineProperty(this, group, {
        value: new Proxy(
          {},
          {
            get: (target, key) => {
              if (!nativeMethodKey(key))
                return nativeObjectProperty(target, key);
              if (!methods.has(key))
                methods.set(
                  key,
                  group === "catalog" && key === "validate"
                    ? (catalog: Catalog) => this.validate(catalog)
                    : (...args: unknown[]) =>
                        this.invoke(`${group}.${key}`, args),
                );
              return methods.get(key);
            },
          },
        ),
      });
    }
  }
  static async open(options: BillingOptions): Promise<Billing> {
    const addon = loadNative();
    if (options.stripe && !options.stripe.secretKey)
      throw new BillingError(
        "invalid_provider_configuration",
        "Provide a Stripe secret key in server-side configuration.",
      );
    const { hooks, ...configuration } = options;
    try {
      const onEvent = hooks?.onEvent;
      const handle = await addon.NativeBilling.open(
        encode(configuration),
        onEvent ? async (raw) => onEvent(JSON.parse(raw)) : undefined,
      );
      return new Billing(handle, options.environment ?? "test");
    } catch (error) {
      throw nativeError(error);
    }
  }
  private validate(catalog: unknown): void {
    try {
      loadNative().validateCatalog(encode(catalog));
    } catch (error) {
      throw nativeError(error);
    }
  }
  private async invoke(
    method: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<any> {
    if (signal?.aborted) throw new BillingError("interrupted");
    const raw = encode(payload(method, args));
    const id = randomUUID();
    const cancel = () => this.handle.cancelRequest(id);
    try {
      this.handle.registerRequest(id);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      return JSON.parse(await this.handle.call(method, raw, id));
    } catch (error) {
      throw nativeError(error);
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  private async receiveWebhook(
    request: Request,
    signal: AbortSignal = request.signal,
  ): Promise<{ accepted: boolean }> {
    signal = AbortSignal.any([signal, request.signal]);
    let body: Buffer;
    try {
      body = Buffer.from(
        await readRequestBytes(request, MAX_WEBHOOK_BYTES, signal),
      );
    } catch (error) {
      throw nativeError(error);
    }
    if (signal.aborted) throw new BillingError("interrupted");
    const id = randomUUID(),
      cancel = () => this.handle.cancelRequest(id);
    try {
      this.handle.registerRequest(id);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      return JSON.parse(
        await this.handle.webhook(
          JSON.stringify(Object.fromEntries(request.headers)),
          body,
          id,
        ),
      );
    } catch (error) {
      throw nativeError(error);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  webhook(request: Request): Promise<{ accepted: boolean }> {
    return this.receiveWebhook(request);
  }
  async close(): Promise<void> {
    try {
      await this.handle.close();
    } catch (error) {
      throw nativeError(error);
    }
  }
}
export function defineCatalog<const T extends Catalog>(catalog: T): T {
  try {
    loadNative().validateCatalog(encode(catalog));
    return catalog;
  } catch (error) {
    throw nativeError(error);
  }
}
export const brokeboy = (options: BillingOptions) => Billing.open(options);

export function rateUsage(
  rate: Rate,
  quantity: string,
  properties: Metadata = {},
): string {
  try {
    return loadNative().rateUsage(encode(rate), quantity, encode(properties));
  } catch (error) {
    throw nativeError(error);
  }
}
export function addInterval(
  start: number,
  interval: "month" | "year",
  count = 1,
): number {
  try {
    return loadNative().addInterval(start, interval, count);
  } catch (error) {
    throw nativeError(error);
  }
}
