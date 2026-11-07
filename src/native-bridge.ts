/** Internal transport boundary shared with handlers; it never loads the addon. */
export const nativeTransport = Symbol.for("@brokeboy/native/transport");
export const nativeGroups = [
  "catalog",
  "customers",
  "entities",
  "credits",
  "entitlements",
  "usage",
  "reservations",
  "billingControls",
  "subscriptions",
  "commerce",
  "licenses",
  "operations",
  "events",
  "maintenance",
  "migration",
  "resources",
  "workflows",
] as const;
export interface NativeTransport {
  readonly environment: "test" | "live";
  invoke(
    method: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown>;
  validate(catalog: unknown): void;
  webhook(
    request: Request,
    signal?: AbortSignal,
  ): Promise<{ accepted: boolean }>;
}

/** Preserve ordinary object inspection without dispatching synthetic RPC methods. */
export function nativeMethodKey(key: PropertyKey): key is string {
  return (
    typeof key === "string" &&
    key !== "then" &&
    key !== "toJSON" &&
    !Object.hasOwn(Object.prototype, key)
  );
}
export function nativeObjectProperty(
  target: object,
  key: PropertyKey,
): unknown {
  return key === "then" || key === "toJSON"
    ? undefined
    : Reflect.get(target, key);
}
