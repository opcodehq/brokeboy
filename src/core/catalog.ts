import {
  decimal,
  minimum,
  multiply,
  nonnegative,
  positive,
  SCALE,
  units,
} from "./decimal.js";
import { type BillingEffect, integration, task } from "./effect.js";
import { assert, identifier } from "./errors.js";
import type { Catalog, Metadata, Rate } from "./types.js";
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export function hash(value: unknown): BillingEffect<string> {
  return task(function* () {
    const bytes = yield* integration(() =>
      crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(value)),
      ),
    );
    return Array.from(new Uint8Array(bytes), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("");
  });
}
export function defineCatalog<const T extends Catalog>(catalog: T): T {
  validateCatalog(catalog);
  return catalog;
}
export function validateCatalog(catalog: Catalog): void {
  assert(
    Array.isArray(catalog.features) && Array.isArray(catalog.plans),
    "invalid_catalog",
  );
  const features = new Map(catalog.features.map((f) => [identifier(f.id), f]));
  assert(features.size === catalog.features.length, "duplicate_feature");
  assert(
    new Set(catalog.plans.map((p) => identifier(p.id))).size ===
      catalog.plans.length,
    "duplicate_plan",
  );
  for (const feature of features.values())
    assert(
      ["boolean", "consumable", "quantity"].includes(feature.kind),
      "invalid_feature",
    );
  for (const plan of catalog.plans) {
    assert(
      typeof plan.name === "string" && plan.name.length > 0,
      "invalid_plan",
    );
    if (plan.amount !== undefined) nonnegative(plan.amount);
    if (plan.graceDays !== undefined)
      assert(
        Number.isSafeInteger(plan.graceDays) &&
          plan.graceDays > 0 &&
          plan.graceDays <= 30,
        "invalid_grace_period",
      );
    for (const [feature, amount] of Object.entries({
      ...plan.trialIncluded,
      ...plan.graceIncluded,
    })) {
      assert(features.has(feature), "unknown_feature");
      nonnegative(amount);
    }
    if (plan.currency)
      assert(/^[a-z]{3}$/.test(plan.currency), "invalid_currency");
    if (plan.trialDays !== undefined)
      assert(
        Number.isSafeInteger(plan.trialDays) && plan.trialDays > 0,
        "invalid_trial",
      );
    assert(
      new Set(plan.items.map((i) => i.feature)).size === plan.items.length,
      "duplicate_plan_feature",
    );
    for (const item of plan.items) {
      assert(features.has(item.feature), "unknown_feature");
      if (item.pool)
        assert(item.included === undefined, "pool_allowance_belongs_to_pool");
      if (features.get(item.feature)?.kind === "boolean")
        assert(
          item.included === undefined &&
            item.rate === undefined &&
            item.pool === undefined,
          "boolean_cannot_be_metered",
        );
      else assert(item.enabled === undefined, "enabled_requires_boolean");
      if (item.pool)
        assert(features.get(item.pool)?.kind === "consumable", "invalid_pool");
      if (item.included !== undefined) nonnegative(item.included);
      if (features.get(item.feature)?.kind === "quantity")
        assert(
          item.reset === undefined || item.reset === "never",
          "quantity_cannot_reset",
        );
      if (item.rollover) {
        nonnegative(item.rollover.maximum);
        assert(
          Number.isSafeInteger(item.rollover.periods) &&
            item.rollover.periods > 0 &&
            item.rollover.periods <= 120,
          "invalid_rollover",
        );
      }
      if (item.overage) assert(item.rate && !item.pool, "invalid_overage");
      if (item.rate) validateRate(item.rate);
    }
  }
}
function validateRate(rate: Rate): void {
  assert(
    (rate.amount !== undefined ? 1 : 0) +
      (rate.tiers ? 1 : 0) +
      (rate.dimensions ? 1 : 0) ===
      1,
    "invalid_rate",
  );
  if (rate.amount !== undefined) nonnegative(rate.amount);
  if (rate.tiers) {
    assert(
      rate.tiers.length > 0 && rate.tiers.at(-1)?.upTo === null,
      "invalid_tiers",
    );
    let last = 0n;
    for (const [index, tier] of rate.tiers.entries()) {
      nonnegative(tier.amount);
      if (tier.flat) nonnegative(tier.flat);
      if (tier.upTo !== null) {
        const top = positive(tier.upTo);
        assert(top > last, "invalid_tiers");
        last = top;
      } else assert(index === rate.tiers.length - 1, "invalid_tiers");
    }
  }
  if (rate.dimensions) {
    assert(rate.dimensions.length > 0, "invalid_dimensions");
    for (const d of rate.dimensions) {
      nonnegative(d.amount);
      assert(Object.keys(d.match).length > 0, "invalid_dimensions");
    }
  }
}
export function rateUsage(
  rate: Rate,
  quantity: string,
  properties: Metadata = {},
): string {
  const n = nonnegative(quantity);
  if (n === 0n) return "0";
  if (rate.dimensions) {
    const matches = rate.dimensions.filter((d) =>
      Object.entries(d.match).every(([k, v]) => properties[k] === v),
    );
    assert(
      matches.length === 1,
      matches.length ? "ambiguous_rate" : "missing_rate",
    );
    return decimal(multiply(n, units(matches[0]!.amount)));
  }
  if (!rate.tiers) return decimal(multiply(n, nonnegative(rate.amount ?? "1")));
  let previous = 0n,
    total = 0n;
  for (const tier of rate.tiers) {
    const top = tier.upTo === null ? n : units(tier.upTo);
    if (rate.mode === "volume") {
      if (n <= top)
        return decimal(
          multiply(n, units(tier.amount)) + units(tier.flat ?? "0"),
        );
    } else {
      const part = minimum(n, top) - previous;
      if (part > 0n)
        total += multiply(part, units(tier.amount)) + units(tier.flat ?? "0");
      if (n <= top) return decimal(total);
    }
    previous = top;
  }
  return decimal(total);
}
export function addInterval(
  start: number,
  interval: "month" | "year",
  count = 1,
): number {
  const date = new Date(start),
    day = date.getUTCDate();
  date.setUTCDate(1);
  if (interval === "month") date.setUTCMonth(date.getUTCMonth() + count);
  else date.setUTCFullYear(date.getUTCFullYear() + count);
  const end = new Date(date);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, end.getUTCDate()));
  return date.getTime();
}
export const UNIT = decimal(SCALE);
export function normalizePlan(
  plan: import("./types.js").Plan,
  features: Catalog["features"],
): import("./types.js").Plan {
  return {
    ...plan,
    items: plan.items.map((item) => {
      const kind = features.find((f) => f.id === item.feature)?.kind;
      return {
        ...item,
        kind,
        ...(kind === "quantity" ? { reset: "never" as const } : {}),
      };
    }),
  };
}
