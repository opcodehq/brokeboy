export class BillingError extends Error {
  readonly name = "BillingError";
  constructor(
    readonly code: string,
    message: string = code,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  code: string,
  message?: string,
): asserts condition {
  if (!condition) throw new BillingError(code, message);
}
export function identifier(value: string): string {
  assert(
    typeof value === "string" &&
      !Object.hasOwn(Object.prototype, value) &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,127}$/.test(value),
    "invalid_identifier",
  );
  return value;
}
export function timestamp(value: number): number {
  assert(Number.isSafeInteger(value) && value >= 0, "invalid_timestamp");
  return value;
}
