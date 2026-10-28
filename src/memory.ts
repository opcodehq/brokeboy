import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { type BillingEffect, sync } from "./core/effect.js";
import { promiseStorage } from "./storage/bridge.js";
import {
  dueAt,
  type Row,
  readonly,
  type Storage,
  type Table,
  type Transaction,
} from "./storage/native.js";

/** Ephemeral, rollback-safe Effect storage. Use durable storage in production. */
export function memoryStorage(): Storage {
  const data = new Map<string, Map<Table, Map<string, Row>>>();
  const locks = new Map<string, { gate: Semaphore.Semaphore; users: number }>();
  function exclusive<A>(
    scope: string,
    effect: BillingEffect<A>,
  ): BillingEffect<A> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const lock = locks.get(scope) ?? {
          gate: Semaphore.makeUnsafe(1),
          users: 0,
        };
        lock.users++;
        locks.set(scope, lock);
        return lock;
      }),
      (lock) => lock.gate.withPermits(1)(effect),
      (lock) =>
        Effect.sync(() => {
          if (--lock.users === 0) locks.delete(scope);
        }),
    );
  }
  function transaction(scope: string): Transaction {
    let bucket = data.get(scope);
    if (!bucket) {
      bucket = new Map();
      data.set(scope, bucket);
    }
    const rows = bucket;
    const list = <T>(table: Table, state?: string) =>
      sync(
        () =>
          structuredClone(
            [...(rows.get(table)?.values() ?? [])].filter(
              (r) => state === undefined || r.state === state,
            ),
          ) as Row<T>[],
      );
    return {
      get: <T>(table: Table, id: string) =>
        sync(
          () =>
            structuredClone(rows.get(table)?.get(id) ?? null) as Row<T> | null,
        ),
      list,
      page: <T>(
        table: Table,
        query: import("./storage/contract.js").PageQuery,
      ) =>
        Effect.map(list<T>(table, query.state), (items) =>
          items
            .filter(
              (row) =>
                row.id > (query.after ?? "") &&
                (query.dueBefore === undefined ||
                  dueAt(row) <= query.dueBefore),
            )
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, query.limit),
        ),
      put: (table, row) =>
        sync(() => {
          let records = rows.get(table);
          if (!records) {
            records = new Map();
            rows.set(table, records);
          }
          records.set(row.id, structuredClone(row));
        }),
    };
  }
  return {
    atomic: (scope, run) =>
      exclusive(
        scope,
        Effect.suspend(() => {
          const before = structuredClone(data.get(scope));
          return Effect.suspend(() => run(transaction(scope))).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isFailure(exit)) {
                  if (before) data.set(scope, before);
                  else data.delete(scope);
                }
              }),
            ),
          );
        }),
      ),
    read: (scope, run) =>
      exclusive(
        scope,
        Effect.suspend(() => run(readonly(transaction(scope)))),
      ),
    scopes: (after = "", limit = 100, prefix = "") =>
      sync(() =>
        [...data.keys()]
          .filter((s) => s > after && s.startsWith(prefix))
          .sort()
          .slice(0, limit),
      ),
  };
}
export const memoryAdapter = () => promiseStorage(memoryStorage());
