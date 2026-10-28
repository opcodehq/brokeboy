import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import {
  type BillingEffect,
  database,
  storageSync,
  task,
} from "./core/effect.js";
import { assert, BillingError } from "./core/errors.js";
import { promiseStorage } from "./storage/bridge.js";
import {
  dueAt,
  type Row,
  readonly,
  type Storage,
  type Table,
  type Transaction,
  tables,
} from "./storage/native.js";
export type Dialect = "postgres" | "mysql" | "sqlite" | "d1";
export type AdapterOptions = {
  dialect: Dialect;
  retries?: number;
  busyTimeout?: number;
};
type Query = (sql: string, parameters?: unknown[]) => BillingEffect<any[]>;
const names = new Set<string>(tables);
function name(table: Table): string {
  assert(names.has(table), "invalid_table");
  return `brokeboy_${table}`;
}
export function migrationSQL(dialect: Dialect): string[] {
  const indexType =
    dialect === "mysql" ? "VARCHAR(191) COLLATE utf8mb4_bin" : "VARCHAR(191)";
  const statements = [
    `CREATE TABLE IF NOT EXISTS brokeboy_locks (scope ${indexType} PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, token VARCHAR(64))`,
  ];
  for (const table of tables) {
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${name(table)} (scope ${indexType} NOT NULL, id ${indexType} NOT NULL, state VARCHAR(32) NOT NULL, data ${dialect === "mysql" ? "LONGTEXT" : "TEXT"} NOT NULL${table === "work" ? ", due BIGINT NOT NULL DEFAULT 0" : ""}, PRIMARY KEY (scope,id)${dialect === "mysql" ? `, INDEX state_idx (scope,state)${table === "work" ? ", INDEX due_idx (scope,state,due,id)" : ""}` : ""})`,
    );
    if (dialect !== "mysql")
      statements.push(
        `CREATE INDEX IF NOT EXISTS ${name(table)}_state ON ${name(table)} (scope,state)`,
      );
  }
  if (dialect !== "mysql")
    statements.push(
      "CREATE INDEX IF NOT EXISTS brokeboy_work_due ON brokeboy_work (scope,state,due,id)",
    );
  return statements;
}
function placeholder(dialect: Dialect, i: number) {
  return dialect === "postgres" ? `$${i}` : "?";
}
function recordTransaction(
  scope: string,
  dialect: Dialect,
  query: Query,
): Transaction {
  return {
    get<T>(table: Table, id: string) {
      return task(function* () {
        const rows = yield* query(
          `SELECT id,state,data FROM ${name(table)} WHERE scope=${placeholder(dialect, 1)} AND id=${placeholder(dialect, 2)}`,
          [scope, id],
        );
        const row = rows[0];
        return row
          ? { id: row.id, state: row.state, data: JSON.parse(row.data) as T }
          : null;
      });
    },
    list<T>(table: Table, state?: string) {
      return task(function* () {
        const rows = yield* query(
          `SELECT id,state,data FROM ${name(table)} WHERE scope=${placeholder(dialect, 1)}${state === undefined ? "" : ` AND state=${placeholder(dialect, 2)}`} ORDER BY id`,
          state === undefined ? [scope] : [scope, state],
        );
        return rows.map((r) => ({
          id: r.id,
          state: r.state,
          data: JSON.parse(r.data) as T,
        }));
      });
    },
    page<T>(table: Table, page: import("./storage/native.js").PageQuery) {
      return task(function* () {
        assert(
          Number.isSafeInteger(page.limit) &&
            page.limit > 0 &&
            page.limit <= 1001,
          "invalid_limit",
        );
        const values: unknown[] = [scope, page.after ?? ""];
        let filter = "";
        if (page.state !== undefined) {
          values.push(page.state);
          filter = ` AND state=${placeholder(dialect, values.length)}`;
        }
        if (page.dueBefore !== undefined) {
          assert(table === "work", "invalid_due_query");
          values.push(page.dueBefore);
          filter += ` AND due<=${placeholder(dialect, values.length)}`;
        }
        values.push(page.limit);
        const rows = yield* query(
          `SELECT id,state,data FROM ${name(table)} WHERE scope=${placeholder(dialect, 1)} AND id>${placeholder(dialect, 2)}${filter} ORDER BY id LIMIT ${placeholder(dialect, values.length)}`,
          values,
        );
        return rows.map((row) => ({
          id: row.id,
          state: row.state,
          data: JSON.parse(row.data) as T,
        }));
      });
    },
    put(table, row) {
      return task(function* () {
        const values: unknown[] = [
          scope,
          row.id,
          row.state,
          JSON.stringify(row.data),
        ];
        if (table === "work") values.push(dueAt(row));
        const suffix =
          dialect === "mysql"
            ? `ON DUPLICATE KEY UPDATE state=VALUES(state),data=VALUES(data)${table === "work" ? ",due=VALUES(due)" : ""}`
            : `ON CONFLICT(scope,id) DO UPDATE SET state=excluded.state,data=excluded.data${table === "work" ? ",due=excluded.due" : ""}`;
        yield* query(
          `INSERT INTO ${name(table)} (scope,id,state,data${table === "work" ? ",due" : ""}) VALUES (${values.map((_, i) => placeholder(dialect, i + 1)).join(",")}) ${suffix}`,
          values,
        );
      });
    },
  };
}
const sqliteLocks = new WeakMap<object, Semaphore.Semaphore>();
/** Native Effect adapter. Connection acquisition and release are scoped. */
export function drizzleStorage(
  db: {
    $client: any;
  },
  options: AdapterOptions,
): Storage {
  const client = db.$client;
  assert(
    client && ["postgres", "mysql", "sqlite", "d1"].includes(options.dialect),
    "unsupported_driver",
  );
  if (options.dialect === "d1") return d1Storage(client, options.retries);
  const dialect = options.dialect,
    sqlite = dialect === "sqlite";
  if (sqlite) {
    assert(
      typeof client.exec === "function" &&
        (typeof client.prepare === "function" ||
          typeof client.query === "function"),
      "unsupported_driver",
    );
    client.exec(
      `PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeout ?? 5000))}`,
    );
    client.exec("PRAGMA foreign_keys = ON");
  } else
    assert(
      typeof client[dialect === "postgres" ? "connect" : "getConnection"] ===
        "function",
      "unsupported_driver",
    );
  const gate = sqlite
    ? (sqliteLocks.get(client) ?? Semaphore.makeUnsafe(1))
    : undefined;
  if (gate) sqliteLocks.set(client, gate);
  const acquire = sqlite
    ? Effect.succeed(client)
    : database(() =>
        dialect === "postgres" ? client.connect() : client.getConnection(),
      );
  const queryFor =
    (conn: any): Query =>
    (sql, parameters = []) => {
      if (sqlite)
        return storageSync(() => {
          const statement =
            typeof conn.prepare === "function"
              ? conn.prepare(sql)
              : conn.query(sql);
          if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql))
            return statement.all(...parameters);
          statement.run(...parameters);
          return [];
        });
      return database(async () => {
        if (dialect === "postgres")
          return (await conn.query(sql, parameters)).rows;
        const [rows] = await (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)
          ? conn.query(sql)
          : conn.execute(sql, parameters));
        return Array.isArray(rows) ? rows : [];
      });
    };
  function connection<A>(
    run: (query: Query, quarantine: () => void) => BillingEffect<A>,
  ): BillingEffect<A> {
    const operation = Effect.acquireUseRelease(
      Effect.map(acquire, (conn) => ({ conn, tainted: false })),
      (resource) =>
        Effect.suspend(() =>
          run(queryFor(resource.conn), () => {
            resource.tainted = true;
          }),
        ),
      (resource) =>
        sqlite
          ? Effect.void
          : Effect.sync(() => {
              if (!resource.tainted) resource.conn.release();
              else if (dialect === "postgres") resource.conn.release(true);
              else resource.conn.destroy();
            }),
    );
    return gate ? gate.withPermits(1)(operation) : operation;
  }
  return {
    atomic: (scope, run) =>
      connection((query, quarantine) =>
        task(function* () {
          assert(scope.length <= 191, "invalid_scope");
          // Driver promises are not abortable. Mask transaction commands and restore
          // interruption only while executing the domain program, so rollback cannot
          // race an in-flight query or release a connection still in use.
          return yield* Effect.uninterruptibleMask((restore) =>
            task(function* () {
              yield* query(sqlite ? "BEGIN IMMEDIATE" : "BEGIN").pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (Exit.isFailure(exit)) quarantine();
                  }),
                ),
              );
              let committed = false;
              return yield* task(function* () {
                const p = placeholder(dialect, 1);
                yield* query(
                  `INSERT INTO brokeboy_locks (scope,revision) VALUES (${p},0) ${dialect === "mysql" ? "ON DUPLICATE KEY UPDATE scope=VALUES(scope)" : "ON CONFLICT(scope) DO NOTHING"}`,
                  [scope],
                );
                if (!sqlite)
                  yield* query(
                    `SELECT revision FROM brokeboy_locks WHERE scope=${p} FOR UPDATE`,
                    [scope],
                  );
                const result = yield* restore(
                  run(recordTransaction(scope, dialect, query)),
                );
                yield* query("COMMIT");
                committed = true;
                return result;
              }).pipe(
                Effect.ensuring(
                  Effect.suspend(() =>
                    committed
                      ? Effect.void
                      : query("ROLLBACK").pipe(
                          Effect.onExit((exit) =>
                            Effect.sync(() => {
                              if (Exit.isFailure(exit)) quarantine();
                            }),
                          ),
                          Effect.orDie,
                          Effect.asVoid,
                        ),
                  ),
                ),
              );
            }),
          );
        }),
      ),
    read: (scope, run) =>
      connection((query) =>
        run(readonly(recordTransaction(scope, dialect, query))),
      ),
    scopes: (after = "", limit = 100, prefix = "") =>
      connection((query) =>
        Effect.map(
          query(
            `SELECT scope FROM brokeboy_locks WHERE scope>${placeholder(dialect, 1)} AND scope LIKE ${placeholder(dialect, 2)} ORDER BY scope LIMIT ${placeholder(dialect, 3)}`,
            [after, `${prefix}%`, limit],
          ),
          (rows) => rows.map((row) => row.scope),
        ),
      ),
  };
}
export const drizzleAdapter = (
  db: {
    $client: any;
  },
  options: AdapterOptions,
) => promiseStorage(drizzleStorage(db, options));
export type D1Client = {
  prepare(sql: string): any;
  batch(statements: any[]): Promise<any[]>;
  withSession?(constraint: string): D1Client;
};
function d1Storage(binding: D1Client, retries = 12): Storage {
  assert(
    typeof binding.batch === "function" &&
      typeof binding.prepare === "function",
    "unsupported_driver",
  );
  const primary = () => binding.withSession?.("first-primary") ?? binding;
  const queryFor =
    (db: D1Client): Query =>
    (sql, values = []) =>
      database(
        async () =>
          (
            await db
              .prepare(sql)
              .bind(...values)
              .all()
          ).results,
      );
  return {
    atomic: (scope, run) =>
      task(function* () {
        for (let attempt = 0; attempt < retries; attempt++) {
          const db = primary();
          yield* database(() =>
            db
              .prepare(
                "INSERT INTO brokeboy_locks (scope,revision) VALUES (?,0) ON CONFLICT(scope) DO NOTHING",
              )
              .bind(scope)
              .run(),
          );
          const head = yield* database<{
            revision: number;
          }>(() =>
            db
              .prepare("SELECT revision FROM brokeboy_locks WHERE scope=?")
              .bind(scope)
              .first(),
          );
          const pending = new Map<
            string,
            {
              table: Table;
              row: Row;
            }
          >();
          const reader = recordTransaction(scope, "d1", queryFor(db));
          const tx: Transaction = {
            get: <T>(table: Table, id: string) =>
              Effect.suspend(() => {
                const hit = pending.get(`${table}:${id}`);
                return hit
                  ? storageSync(() => structuredClone(hit.row) as Row<T>)
                  : reader.get<T>(table, id);
              }),
            list: <T>(table: Table, state?: string) =>
              Effect.map(reader.list<T>(table), (items) => {
                const rows = new Map(items.map((row) => [row.id, row]));
                for (const write of pending.values())
                  if (write.table === table)
                    rows.set(
                      write.row.id,
                      structuredClone(write.row) as Row<T>,
                    );
                return [...rows.values()].filter(
                  (row) => state === undefined || row.state === state,
                );
              }),
            page: <T>(
              table: Table,
              page: import("./storage/contract.js").PageQuery,
            ) =>
              Effect.suspend(() =>
                pending.size === 0
                  ? reader.page<T>(table, page)
                  : Effect.map(tx.list<T>(table, page.state), (rows) =>
                      rows
                        .filter(
                          (row) =>
                            row.id > (page.after ?? "") &&
                            (page.dueBefore === undefined ||
                              dueAt(row) <= page.dueBefore),
                        )
                        .sort((a, b) =>
                          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
                        )
                        .slice(0, page.limit),
                    ),
              ),
            put: (table, row) =>
              storageSync(() => {
                pending.set(`${table}:${row.id}`, {
                  table,
                  row: structuredClone(row),
                });
              }),
          };
          const result = yield* run(tx);
          const token = crypto.randomUUID();
          const statements = [
            db
              .prepare(
                "UPDATE brokeboy_locks SET revision=revision+1,token=? WHERE scope=? AND revision=?",
              )
              .bind(token, scope, head.revision),
          ];
          for (const { table, row } of pending.values())
            statements.push(
              db
                .prepare(
                  `INSERT INTO ${name(table)} (scope,id,state,data${table === "work" ? ",due" : ""}) SELECT ?,?,?,?${table === "work" ? ",?" : ""} WHERE EXISTS (SELECT 1 FROM brokeboy_locks WHERE scope=? AND token=?) ON CONFLICT(scope,id) DO UPDATE SET state=excluded.state,data=excluded.data${table === "work" ? ",due=excluded.due" : ""}`,
                )
                .bind(
                  scope,
                  row.id,
                  row.state,
                  JSON.stringify(row.data),
                  ...(table === "work" ? [dueAt(row)] : []),
                  scope,
                  token,
                ),
            );
          // Atomic batches cannot be aborted after submission; observe the result.
          const committed = yield* Effect.uninterruptible(
            database(() => db.batch(statements)),
          );
          if (committed[0]?.meta?.changes === 1) return result;
          yield* Effect.sleep(Math.min(2 ** attempt, 32));
        }
        return yield* Effect.fail(
          new BillingError(
            "storage_contention",
            "Concurrent mutations exceeded the retry budget. Retry with the same idempotency key.",
          ),
        );
      }),
    read: (scope, run) =>
      Effect.suspend(() =>
        run(readonly(recordTransaction(scope, "d1", queryFor(primary())))),
      ),
    scopes: (after = "", limit = 100, prefix = "") =>
      Effect.map(
        queryFor(primary())(
          "SELECT scope FROM brokeboy_locks WHERE scope>? AND scope LIKE ? ORDER BY scope LIMIT ?",
          [after, `${prefix}%`, limit],
        ),
        (rows) => rows.map((row) => row.scope),
      ),
  };
}
