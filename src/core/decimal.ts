import { assert } from "./errors.js";
export const SCALE = 1_000_000n;
const MAX = 9_223_372_036_854_775_807n;
export function units(value: string): bigint {
  assert(
    typeof value === "string" && /^-?(0|[1-9]\d*)(\.\d{1,6})?$/.test(value),
    "invalid_decimal",
    "Use a decimal string with at most six fractional digits.",
  );
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (
    negative ? value.slice(1) : value
  ).split(".");
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"));
  assert(result <= MAX, "decimal_overflow");
  return negative ? -result : result;
}
export function decimal(value: bigint): string {
  assert(value >= -MAX && value <= MAX, "decimal_overflow");
  const sign = value < 0n ? "-" : "";
  const n = value < 0n ? -value : value;
  const fraction = (n % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${n / SCALE}${fraction ? `.${fraction}` : ""}`;
}
export function positive(value: string): bigint {
  const n = units(value);
  assert(n > 0n, "invalid_amount");
  return n;
}
export function nonnegative(value: string): bigint {
  const n = units(value);
  assert(n >= 0n, "invalid_amount");
  return n;
}
export function multiply(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE;
}
export function minorUnits(amount: string, currency: string): string {
  const zero = new Set([
    "bif",
    "clp",
    "djf",
    "gnf",
    "jpy",
    "kmf",
    "krw",
    "mga",
    "pyg",
    "rwf",
    "ugx",
    "vnd",
    "vuv",
    "xaf",
    "xof",
    "xpf",
  ]);
  const three = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
  const exponent = zero.has(currency) ? 0 : three.has(currency) ? 3 : 2;
  const divisor = 10n ** BigInt(6 - exponent);
  const n = nonnegative(amount);
  return ((n + divisor / 2n) / divisor).toString();
}

export function minimum(a: bigint, b: bigint): bigint {
  if (a < b) return a;
  return b;
}
