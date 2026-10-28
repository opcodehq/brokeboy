import { put, type Transaction } from "../storage/native.js";
import { addInterval, canonical, hash } from "./catalog.js";
import { decimal, minimum, nonnegative, positive, units } from "./decimal.js";
import { type BillingEffect, task } from "./effect.js";
import { assert, timestamp } from "./errors.js";
import type {
  Allocation,
  Balance,
  Grant,
  Movement,
  PlanItem,
  PublishedPlan,
  Reservation,
  Subscription,
  Usage,
} from "./types.js";

type Position = {
  spent: string;
  held: string;
};
export const allocationEntity = (
  item: PlanItem | undefined,
  entityId?: string,
) => (item?.poolScope === "customer" ? undefined : entityId);
export const entitlementThrough = (sub: Subscription) =>
  sub.status === "past_due" ? (sub.graceThrough ?? 0) : sub.paidThrough;
export const isEntitled = (sub: Subscription, now: number) =>
  (["active", "trialing"].includes(sub.status) ||
    (sub.status === "past_due" && !!sub.graceThrough)) &&
  entitlementThrough(sub) > now;
export function registerFeatures(tx: Transaction, plan: PublishedPlan) {
  return task(function* () {
    for (const item of plan.items)
      if (item.kind) {
        const key = `feature-kind:${item.feature}`;
        const old = yield* tx.get<{
          kind: string;
        }>("counters", key);
        if (old) assert(old.data.kind === item.kind, "feature_kind_conflict");
        else yield* put(tx, "counters", key, { kind: item.kind });
      }
  });
}
export class Ledger {
  constructor(readonly now: () => number) {}
  position(tx: Transaction, grantId: string): BillingEffect<Position> {
    return task(function* () {
      return (
        (yield* tx.get<Position>("counters", `grant:${grantId}`))?.data ?? {
          spent: "0",
          held: "0",
        }
      );
    });
  }
  adjustPosition(
    tx: Transaction,
    grantId: string,
    spent: bigint,
    held: bigint,
  ) {
    return task({ self: this }, function* () {
      const previous = yield* this.position(tx, grantId);
      const next = {
        spent: decimal(units(previous.spent) + spent),
        held: decimal(units(previous.held) + held),
      };
      assert(
        units(next.spent) >= 0n && units(next.held) >= 0n,
        "ledger_invariant",
      );
      yield* put(tx, "counters", `grant:${grantId}`, next);
    });
  }
  movement(
    tx: Transaction,
    grantId: string,
    amount: bigint,
    operationId: string,
    reason: string,
    reverses?: string,
  ) {
    return task({ self: this }, function* () {
      const id = crypto.randomUUID();
      yield* put(tx, "movements", id, {
        id,
        grantId,
        amount: decimal(amount),
        operationId,
        createdAt: this.now(),
        reason,
        reverses,
      } satisfies Movement);
      yield* this.adjustPosition(tx, grantId, amount, 0n);
    });
  }
  grant(tx: Transaction, grant: Grant) {
    return task(function* () {
      const previous = yield* tx.get<Grant>("grants", grant.id);
      if (previous) {
        assert(
          canonical({ ...previous.data, createdAt: 0 }) ===
            canonical({ ...grant, createdAt: 0 }),
          "grant_conflict",
        );
        return previous.data;
      }
      nonnegative(grant.amount);
      yield* put(tx, "grants", grant.id, grant);
      return grant;
    });
  }
  grantPeriod(
    tx: Transaction,
    subscription: Subscription,
    item: PlanItem,
    start: number,
    end: number,
  ) {
    return task({ self: this }, function* () {
      const id = (yield* hash({
        subscription: subscription.id,
        feature: item.feature,
        start: item.reset === "never" ? 0 : start,
        version: subscription.plan.version,
        phase:
          subscription.status === "trialing"
            ? "trial"
            : subscription.status === "past_due"
              ? "grace"
              : "paid",
        quantity: subscription.quantity,
      })).slice(0, 48);
      if (yield* tx.get("grants", id)) return;
      const included =
        (units(
          subscription.status === "trialing"
            ? (subscription.plan.trialIncluded?.[item.feature] ?? "0")
            : subscription.status === "past_due"
              ? (subscription.plan.graceIncluded?.[item.feature] ?? "0")
              : (item.included ?? "0"),
        ) *
          units(subscription.quantity)) /
        1000000n;
      const offset =
        subscription.provisioningOffset &&
        start < subscription.provisioningOffset.until
          ? units(
              subscription.provisioningOffset.granted[
                item.pool ?? item.feature
              ] ?? "0",
            )
          : 0n;
      yield* this.grant(tx, {
        id,
        feature: item.pool ?? item.feature,
        entityId: allocationEntity(item, subscription.entityId),
        amount: decimal(included > offset ? included - offset : 0n),
        expiresAt:
          item.reset === "never" || subscription.plan.kind === "one_time"
            ? undefined
            : end,
        priority: 0,
        origin:
          subscription.plan.kind === "one_time" ? "purchase" : "subscription",
        sourceId: subscription.purchaseId ?? subscription.id,
        createdAt: start,
      });
    });
  }
  materialize(tx: Transaction) {
    return task({ self: this }, function* () {
      const now = this.now();
      for (const row of yield* tx.list<Subscription>(
        "subscriptions",
        "active",
      )) {
        const sub = row.data;
        if (sub.cancelAtPeriodEnd && sub.periodEnd <= now) {
          yield* put(
            tx,
            "subscriptions",
            sub.id,
            {
              ...sub,
              status: "ended",
              paidThrough: Math.min(sub.paidThrough, sub.periodEnd),
            },
            "ended",
          );
          continue;
        }
        const due = sub.scheduledPlans
          ?.filter((phase) => phase.start <= now)
          .at(-1);
        if (due) {
          yield* registerFeatures(tx, due.plan);
          sub.plan = due.plan;
          sub.periodStart = due.start;
          sub.periodEnd = due.end;
          sub.scheduledPlans = sub.scheduledPlans?.filter(
            (phase) => phase.start > now,
          );
          sub.provisioningOffset = undefined;
          yield* put(tx, "subscriptions", sub.id, sub);
        }
        if (!isEntitled(sub, now)) continue;
        for (const item of sub.plan.items) {
          if (item.included === undefined) continue;
          const reset = item.reset ?? sub.plan.interval ?? "month";
          const origin = new Date(sub.periodStart),
            current = new Date(Math.min(now, entitlementThrough(sub) - 1));
          const elapsed =
            reset === "year"
              ? current.getUTCFullYear() - origin.getUTCFullYear()
              : (current.getUTCFullYear() - origin.getUTCFullYear()) * 12 +
                current.getUTCMonth() -
                origin.getUTCMonth();
          let index =
            reset === "never"
              ? 0
              : Math.max(0, elapsed - (item.rollover?.periods ?? 0) - 1);
          let start =
            index === 0
              ? sub.periodStart
              : addInterval(sub.periodStart, reset as "month" | "year", index);
          while (
            start <= now &&
            start < entitlementThrough(sub) &&
            index < 1200
          ) {
            const end =
              reset === "never" || sub.plan.kind === "one_time"
                ? Number.MAX_SAFE_INTEGER
                : addInterval(sub.periodStart, reset, index + 1);
            yield* this.grantPeriod(
              tx,
              sub,
              item,
              start,
              Math.min(end, entitlementThrough(sub)),
            );
            if (end > now || reset === "never" || sub.plan.kind === "one_time")
              break;
            start = end;
            index++;
          }
        }
      }
      for (const row of yield* tx.list<Reservation>("reservations", "held"))
        if (row.data.expiresAt <= now)
          yield* this.finishReservation(tx, row.data, "expired");
      for (const row of yield* tx.list<Grant>("grants", "active")) {
        const grant = row.data;
        if (grant.expiresAt === undefined || grant.expiresAt > now) continue;
        const sub = (yield* tx.get<Subscription>(
          "subscriptions",
          grant.sourceId,
        ))?.data;
        const item = sub?.plan.items.find(
          (i) => (i.pool ?? i.feature) === grant.feature,
        );
        const position = yield* this.position(tx, grant.id);
        const left =
          units(grant.amount) - units(position.spent) - units(position.held);
        if (
          item?.rollover &&
          grant.origin === "subscription" &&
          left > 0n &&
          sub &&
          sub.paidThrough > grant.expiresAt
        ) {
          let outstanding = 0n;
          for (const { data: rolled } of yield* tx.list<Grant>(
            "grants",
            "active",
          ))
            if (
              rolled.origin === "rollover" &&
              rolled.feature === grant.feature &&
              rolled.entityId === grant.entityId &&
              (rolled.expiresAt ?? 0) > now
            ) {
              const p = yield* this.position(tx, rolled.id);
              outstanding +=
                units(rolled.amount) - units(p.spent) - units(p.held);
            }
          const remainingCap = units(item.rollover.maximum) - outstanding;
          const cap = remainingCap > 0n ? remainingCap : 0n;
          const expiresAt = addInterval(
            grant.expiresAt,
            item.reset === "year" ? "year" : "month",
            item.rollover.periods,
          );
          if (expiresAt > now && cap > 0n)
            yield* this.grant(tx, {
              ...grant,
              id: `roll:${grant.id}`,
              amount: decimal(minimum(left, cap)),
              createdAt: grant.expiresAt,
              expiresAt,
              origin: "rollover",
            });
        }
        yield* put(tx, "grants", grant.id, grant, "expired");
      }
    });
  }
  usableGrants(
    tx: Transaction,
    feature: string,
    entityId?: string,
  ): BillingEffect<Grant[]> {
    return task({ self: this }, function* () {
      const result: Grant[] = [];
      for (const { data: g } of yield* tx.list<Grant>("grants", "active")) {
        if (
          g.feature !== feature ||
          g.entityId !== entityId ||
          (g.expiresAt !== undefined && g.expiresAt <= this.now())
        )
          continue;
        if (g.origin === "subscription" || g.origin === "rollover") {
          const source = (yield* tx.get<Subscription>(
            "subscriptions",
            g.sourceId,
          ))?.data;
          if (!source || !isEntitled(source, this.now())) continue;
        }
        result.push(g);
      }
      return result;
    });
  }
  balance(
    tx: Transaction,
    feature: string,
    entityId?: string,
  ): BillingEffect<Balance> {
    return task({ self: this }, function* () {
      let granted = 0n,
        spent = 0n,
        held = 0n;
      for (const grant of yield* this.usableGrants(tx, feature, entityId)) {
        const p = yield* this.position(tx, grant.id);
        granted += units(grant.amount);
        spent += units(p.spent);
        held += units(p.held);
      }
      return {
        feature,
        granted: decimal(granted),
        spent: decimal(spent),
        reserved: decimal(held),
        available: decimal(granted - spent - held),
      };
    });
  }
  allocate(
    tx: Transaction,
    feature: string,
    amount: bigint,
    entityId?: string,
    hold = false,
    operation = "",
  ): BillingEffect<Allocation[]> {
    return task({ self: this }, function* () {
      const grants = (yield* this.usableGrants(tx, feature, entityId)).sort(
        (a, b) =>
          a.priority - b.priority ||
          (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id),
      );
      const result: Allocation[] = [];
      let remaining = amount;
      for (const grant of grants) {
        const p = yield* this.position(tx, grant.id);
        const left = units(grant.amount) - units(p.spent) - units(p.held);
        const take = minimum(left, remaining);
        if (take <= 0n) continue;
        if (hold) yield* this.adjustPosition(tx, grant.id, 0n, take);
        else yield* this.movement(tx, grant.id, take, operation, "consume");
        result.push({ grantId: grant.id, amount: decimal(take) });
        remaining -= take;
        if (remaining === 0n) break;
      }
      assert(remaining === 0n, "insufficient_balance");
      return result;
    });
  }
  reserve(
    tx: Transaction,
    input: {
      feature: string;
      amount: string;
      entityId?: string;
      poolScope?: "customer" | "entity";
      expiresAt: number;
    },
    operation: string,
  ): BillingEffect<Reservation> {
    return task({ self: this }, function* () {
      assert(timestamp(input.expiresAt) > this.now(), "invalid_expiry");
      const allocations = yield* this.allocate(
        tx,
        input.feature,
        nonnegative(input.amount),
        input.poolScope === "customer" ? undefined : input.entityId,
        true,
        operation,
      );
      let expiresAt = input.expiresAt;
      for (const allocation of allocations)
        expiresAt = Math.min(
          expiresAt,
          (yield* tx.get<Grant>("grants", allocation.grantId))!.data
            .expiresAt ?? Infinity,
        );
      const reservation: Reservation = {
        ...input,
        id: crypto.randomUUID(),
        allocations,
        expiresAt,
        status: "held",
      };
      yield* put(tx, "reservations", reservation.id, reservation, "held");
      return reservation;
    });
  }
  reservationFunded(tx: Transaction, reservation: Reservation) {
    return task({ self: this }, function* () {
      if (reservation.status !== "held" || reservation.expiresAt <= this.now())
        return false;
      for (const allocation of reservation.allocations) {
        const row = yield* tx.get<Grant>("grants", allocation.grantId);
        if (
          row?.state !== "active" ||
          (row.data.expiresAt !== undefined && row.data.expiresAt <= this.now())
        )
          return false;
        if (
          row.data.origin === "subscription" ||
          row.data.origin === "rollover"
        ) {
          const source = (yield* tx.get<Subscription>(
            "subscriptions",
            row.data.sourceId,
          ))?.data;
          if (!source || !isEntitled(source, this.now())) return false;
        }
      }
      return true;
    });
  }
  increaseReservation(
    tx: Transaction,
    reservation: Reservation,
    amount: string,
    operation: string,
  ) {
    return task({ self: this }, function* () {
      assert(
        yield* this.reservationFunded(tx, reservation),
        "reservation_not_held",
      );
      const extra = yield* this.allocate(
        tx,
        reservation.feature,
        positive(amount),
        reservation.poolScope === "customer" ? undefined : reservation.entityId,
        true,
        operation,
      );
      let expiresAt = reservation.expiresAt;
      for (const a of extra)
        expiresAt = Math.min(
          expiresAt,
          (yield* tx.get<Grant>("grants", a.grantId))!.data.expiresAt ??
            Infinity,
        );
      const next = {
        ...reservation,
        amount: decimal(units(reservation.amount) + units(amount)),
        allocations: [...reservation.allocations, ...extra],
        expiresAt,
      };
      yield* put(tx, "reservations", next.id, next, "held");
      return next;
    });
  }
  settleReservation(
    tx: Transaction,
    reservation: Reservation,
    amount: string,
    operation: string,
    properties: Record<string, string> = {},
  ): BillingEffect<Usage> {
    return task({ self: this }, function* () {
      assert(
        yield* this.reservationFunded(tx, reservation),
        "reservation_not_held",
      );
      let left = nonnegative(amount);
      assert(left <= units(reservation.amount), "reservation_exceeded");
      const used: Allocation[] = [];
      for (const a of reservation.allocations) {
        const take = minimum(units(a.amount), left);
        yield* this.adjustPosition(tx, a.grantId, 0n, -units(a.amount));
        if (take > 0n) {
          yield* this.movement(tx, a.grantId, take, operation, "settle");
          used.push({ grantId: a.grantId, amount: decimal(take) });
          left -= take;
        }
      }
      yield* put(
        tx,
        "reservations",
        reservation.id,
        { ...reservation, status: "settled" },
        "settled",
      );
      const usage: Usage = {
        id: crypto.randomUUID(),
        feature: reservation.feature,
        entityId: reservation.entityId,
        quantity: amount,
        charged: amount,
        allocations: used,
        createdAt: this.now(),
        properties: { ...properties, reservationId: reservation.id },
      };
      yield* put(tx, "usage", usage.id, usage);
      return usage;
    });
  }
  finishReservation(
    tx: Transaction,
    reservation: Reservation,
    status: "released" | "expired",
  ) {
    return task({ self: this }, function* () {
      for (const allocation of reservation.allocations)
        yield* this.adjustPosition(
          tx,
          allocation.grantId,
          0n,
          -units(allocation.amount),
        );
      const next = { ...reservation, status };
      yield* put(tx, "reservations", reservation.id, next, status);
      return next;
    });
  }
  reconcile(tx: Transaction) {
    return task({ self: this }, function* () {
      const movements = yield* tx.list<Movement>("movements");
      const reservations = yield* tx.list<Reservation>("reservations", "held");
      const mismatches = [];
      for (const { data: g } of yield* tx.list<Grant>("grants")) {
        const spent = movements
          .filter((m) => m.data.grantId === g.id)
          .reduce((n, m) => n + units(m.data.amount), 0n);
        const held = reservations
          .flatMap((r) => r.data.allocations)
          .filter((a) => a.grantId === g.id)
          .reduce((n, a) => n + units(a.amount), 0n);
        const p = yield* this.position(tx, g.id);
        if (
          units(p.spent) !== spent ||
          units(p.held) !== held ||
          spent < 0n ||
          held < 0n ||
          spent + held > units(g.amount)
        )
          mismatches.push({
            grantId: g.id,
            expected: { spent: decimal(spent), held: decimal(held) },
            actual: p,
          });
      }
      return { consistent: mismatches.length === 0, mismatches };
    });
  }
}
