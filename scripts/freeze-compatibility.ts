// Run against the 0.1 engine only. The committed fixture is the Rust port oracle.
import { addInterval, canonical, rateUsage } from "../src/core/catalog.js";
import { decimal, minorUnits, multiply, units } from "../src/core/decimal.js";
import { identifier, timestamp } from "../src/core/errors.js";
import type { Metadata, Rate } from "../src/core/types.js";
import { migrationSQL } from "../src/drizzle.js";

function capture(run: () => unknown) {
  try {
    return { result: run() };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error)
      return { error: error.code };
    throw error;
  }
}
const inputs: unknown[] = [
  null,
  { z: 1, a: { b: 2, a: 1 }, empty: {}, array: [false, null, "a"] },
  { "\u{10000}": "astral", "\ue000": "bmp", "😀": "emoji", "a\n": "\u0000" },
  {
    numbers: [
      0, -0, 0.000001, 0.0000001, 1e20, 1e21, 1.23456789012345,
      9007199254740991,
    ],
  },
  {
    method: "usage.consume",
    payload: { amount: "1.00", customerId: "c", idempotencyKey: "k" },
  },
  {
    method: "usage.consume",
    payload: { amount: "1", customerId: "c", idempotencyKey: "k" },
  },
  {
    method: "usage.consume",
    payload: {
      amount: "1",
      customerId: "c",
      idempotencyKey: "k",
      properties: {},
    },
  },
];
const hashes = await Promise.all(
  inputs.map(async (input) => {
    const text = canonical(input);
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text),
    );
    const hash = Array.from(new Uint8Array(bytes), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return { input, canonical: text, hash };
  }),
);
const decimals = [
  "0",
  "-0",
  "1.000000",
  "-0.000001",
  "9223372036854.775807",
  "-9223372036854.775807",
  "9223372036854.775808",
  "-9223372036854.775808",
  "01",
  "+1",
  ".5",
  "1.",
  "1e3",
  "1.0000001",
  "",
  "--1",
].map((input) => ({
  input,
  ...capture(() => ({
    scaled: units(input).toString(),
    decimal: decimal(units(input)),
  })),
}));
const currencies = ["usd", "jpy", "kwd", "xof", "USD"].flatMap((currency) =>
  ["0", "0.004999", "0.005", "1.2345", "9223372036854.775807", "-1"].map(
    (amount) => ({
      currency,
      amount,
      ...capture(() => minorUnits(amount, currency)),
    }),
  ),
);
const multiplication = [
  ["-0.000001", "0.5"],
  ["1.234567", "2.765432"],
  ["9223372036854.775807", "1"],
  ["9223372036854.775807", "2"],
].map(([a, b]) => ({
  a: a!,
  b: b!,
  ...capture(() => decimal(multiply(units(a!), units(b!)))),
}));
const rates: { rate: Rate; properties?: Metadata }[] = [
  { rate: {} },
  { rate: { amount: "0.123456" } },
  {
    rate: {
      tiers: [
        { upTo: "10", amount: "2", flat: "1" },
        { upTo: null, amount: "0.5", flat: "3" },
      ],
    },
  },
  {
    rate: {
      mode: "volume",
      tiers: [
        { upTo: "10", amount: "2", flat: "1" },
        { upTo: null, amount: "0.5", flat: "3" },
      ],
    },
  },
  {
    rate: {
      dimensions: [
        { match: { model: "small" }, amount: "0.01" },
        { match: { model: "large" }, amount: "0.3" },
      ],
    },
    properties: { model: "large" },
  },
  {
    rate: { dimensions: [{ match: { model: "small" }, amount: "0.01" }] },
    properties: {},
  },
  {
    rate: {
      dimensions: [
        { match: { model: "small" }, amount: "0.01" },
        { match: { region: "us" }, amount: "1" },
      ],
    },
    properties: { model: "small", region: "us" },
  },
];
const pricing = rates.flatMap(({ rate, properties = {} }) =>
  ["0", "0.000001", "9.999999", "10", "10.000001", "100"].map((quantity) => ({
    rate,
    properties,
    quantity,
    ...capture(() => rateUsage(rate, quantity, properties)),
  })),
);
const calendars = [
  "2024-01-31T12:34:56.789Z",
  "2024-02-29T00:00:00.000Z",
  "2025-01-31T00:00:00.000Z",
  "2025-12-31T23:59:59.999Z",
].flatMap((iso) =>
  (["month", "year"] as const).flatMap((interval) =>
    [0, 1, 2, 12, 25].map((count) => ({
      start: Date.parse(iso),
      interval,
      count,
      result: addInterval(Date.parse(iso), interval, count),
    })),
  ),
);
const identifiers = [
  "c",
  "org/team:test@1.0",
  "constructor",
  "__proto__",
  "toString",
  "toLocaleString",
  "hello world",
  "a".repeat(128),
  "a".repeat(129),
  "-a",
  "é",
].map((input) => ({ input, ...capture(() => identifier(input)) }));
const timestamps = [-1, 0, 1, 1.1, 9007199254740991, 9007199254740992].map(
  (input) => ({ input, ...capture(() => timestamp(input)) }),
);
const fixture = {
  oracle: "26c5eb67e9e7eb7d017fd968556172877ab48296",
  hashes,
  decimals,
  currencies,
  multiplication,
  pricing,
  calendars,
  identifiers,
  timestamps,
  schema: {
    sqlite: migrationSQL("sqlite"),
    postgres: migrationSQL("postgres"),
    mysql: migrationSQL("mysql"),
  },
};
await Bun.write(
  new URL("../test/fixtures/compatibility/v1.json", import.meta.url),
  `${JSON.stringify(fixture, null, 2)}\n`,
);
