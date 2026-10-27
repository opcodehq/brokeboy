import { assert, BillingError } from "./core/errors.js";
import {
  dueAt,
  type Row,
  readonly,
  type Storage,
  type Table,
  type Transaction,
  tables,
} from "./storage/contract.js";
export type Dialect = "postgres" | "mysql" | "sqlite" | "d1";
export type AdapterOptions = {
  dialect: Dialect;
  retries?: number;
  busyTimeout?: number;
};
type Query = (sql: string, parameters?: unknown[]) => Promise<any[]>;
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
    async get<T>(table: Table, id: string) {
      const rows = await query(
        `SELECT id,state,data FROM ${name(table)} WHERE scope=${placeholder(dialect, 1)} AND id=${placeholder(dialect, 2)}`,
        [scope, id],
      );
      const row = rows[0];
      return row
        ? { id: row.id, state: row.state, data: JSON.parse(row.data) as T }
        : null;
    },
    async list<T>(table: Table, state?: string) {
      const rows = await query(
        `SELECT id,state,data FROM ${name(table)} WHERE scope=${placeholder(dialect, 1)}${state === undefined ? "" : ` AND state=${placeholder(dialect, 2)}`} ORDER BY id`,
        state === undefined ? [scope] : [scope, state],
      );
      return rows.map((r) => ({
        id: r.id,
        state: r.state,
        data: JSON.parse(r.data) as T,
      }));
    },
    async page<T>(
      table: Table,
      page: import("./storage/contract.js").PageQuery,
    ) {
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
      const rows = await query(
        `SELECT id,state,data FROM ${name(table)} WHERE scope=${placeholder(dialect, 1)} AND id>${placeholder(dialect, 2)}${filter} ORDER BY id LIMIT ${placeholder(dialect, values.length)}`,
        values,
      );
      return rows.map((row) => ({
        id: row.id,
        state: row.state,
        data: JSON.parse(row.data) as T,
      }));
    },
    async put(table, row) {
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
      await query(
        `INSERT INTO ${name(table)} (scope,id,state,data${table === "work" ? ",due" : ""}) VALUES (${values.map((_, i) => placeholder(dialect, i + 1)).join(",")}) ${suffix}`,
        values,
      );
    },
  };
}
const sqliteTails = new WeakMap<object, Promise<void>>();
/** Uses only the documented Drizzle $client. Unsupported drivers fail explicitly. */
export function drizzleAdapter(
  db: { $client: any },
  options: AdapterOptions,
): Storage {
  const client = db.$client;
  assert(
    client && ["postgres", "mysql", "sqlite", "d1"].includes(options.dialect),
    "unsupported_driver",
  );
  if (options.dialect === "d1") return d1Adapter(client, options.retries);
  const dialect = options.dialect;
  const sqlite = dialect === "sqlite";
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
  }
  async function connection() {
    if (sqlite) return { conn: client, release: () => {} };
    if (dialect === "postgres") {
      assert(
        typeof client.connect === "function",
        "unsupported_driver",
        "Use a pg-compatible Pool, including Neon's WebSocket Pool.",
      );
      const conn = await client.connect();
      return { conn, release: () => conn.release() };
    }
    assert(
      typeof client.getConnection === "function",
      "unsupported_driver",
      "Use a mysql2 promise Pool.",
    );
    const conn = await client.getConnection();
    return { conn, release: () => conn.release() };
  }
  function queryFor(conn: any): Query {
    return async (sql, parameters = []) => {
      if (sqlite) {
        const stmt =
          typeof conn.prepare === "function"
            ? conn.prepare(sql)
            : conn.query(sql);
        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql))
          return stmt.all(...parameters);
        stmt.run(...parameters);
        return [];
      }
      if (dialect === "postgres")
        return (await conn.query(sql, parameters)).rows;
      const [rows] = await (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)
        ? conn.query(sql)
        : conn.execute(sql, parameters));
      return Array.isArray(rows) ? rows : [];
    };
  }
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (!sqlite) return run();
    const before = sqliteTails.get(client) ?? Promise.resolve();
    let release!: () => void;
    const tail = before.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    sqliteTails.set(client, tail);
    await before;
    // Ensure the continuation constructing the gate has executed.
    await Promise.resolve();
    try {
      return await run();
    } finally {
      release();
      if (sqliteTails.get(client) === tail) sqliteTails.delete(client);
    }
  }
  return {
    async atomic(scope, run) {
      assert(scope.length <= 191, "invalid_scope");
      return exclusive(async () => {
        const { conn, release } = await connection();
        const query = queryFor(conn);
        try {
          await query(sqlite ? "BEGIN IMMEDIATE" : "BEGIN");
          const p = placeholder(dialect, 1);
          await query(
            `INSERT INTO brokeboy_locks (scope,revision) VALUES (${p},0) ${dialect === "mysql" ? "ON DUPLICATE KEY UPDATE scope=VALUES(scope)" : "ON CONFLICT(scope) DO NOTHING"}`,
            [scope],
          );
          if (!sqlite)
            await query(
              `SELECT revision FROM brokeboy_locks WHERE scope=${p} FOR UPDATE`,
              [scope],
            );
          const result = await run(recordTransaction(scope, dialect, query));
          await query("COMMIT");
          return result;
        } catch (error) {
          try {
            await query("ROLLBACK");
          } catch {}
          throw error;
        } finally {
          release();
        }
      });
    },
    async read(scope, run) {
      return exclusive(async () => {
        const { conn, release } = await connection();
        try {
          return await run(
            readonly(recordTransaction(scope, dialect, queryFor(conn))),
          );
        } finally {
          release();
        }
      });
    },
    async scopes(after = "", limit = 100, prefix = "") {
      return exclusive(async () => {
        const { conn, release } = await connection();
        try {
          return (
            await queryFor(conn)(
              `SELECT scope FROM brokeboy_locks WHERE scope>${placeholder(dialect, 1)} AND scope LIKE ${placeholder(dialect, 2)} ORDER BY scope LIMIT ${placeholder(dialect, 3)}`,
              [after, `${prefix}%`, limit],
            )
          ).map((r) => r.scope);
        } finally {
          release();
        }
      });
    },
  };
}
export type D1Client = {
  prepare(sql: string): any;
  batch(statements: any[]): Promise<any[]>;
  withSession?(constraint: string): D1Client;
};
function d1Adapter(binding: D1Client, retries = 12): Storage {
  assert(
    typeof binding.batch === "function" &&
      typeof binding.prepare === "function",
    "unsupported_driver",
  );
  const primary = () => binding.withSession?.("first-primary") ?? binding;
  const queryFor =
    (db: D1Client): Query =>
    async (sql, values = []) =>
      (
        await db
          .prepare(sql)
          .bind(...values)
          .all()
      ).results;
  return {
    async atomic(scope, run) {
      for (let attempt = 0; attempt < retries; attempt++) {
        const db = primary();
        await db
          .prepare(
            "INSERT INTO brokeboy_locks (scope,revision) VALUES (?,0) ON CONFLICT(scope) DO NOTHING",
          )
          .bind(scope)
          .run();
        const head = await db
          .prepare("SELECT revision FROM brokeboy_locks WHERE scope=?")
          .bind(scope)
          .first();
        const pending = new Map<string, { table: Table; row: Row }>();
        const reader = recordTransaction(scope, "d1", queryFor(db));
        const tx: Transaction = {
          async get<T>(table: Table, id: string) {
            const hit = pending.get(`${table}:${id}`);
            return hit
              ? (structuredClone(hit.row) as Row<T>)
              : reader.get<T>(table, id);
          },
          async list<T>(table: Table, state?: string) {
            const rows = new Map(
              (await reader.list<T>(table)).map((row) => [row.id, row]),
            );
            for (const write of pending.values())
              if (write.table === table)
                rows.set(write.row.id, structuredClone(write.row) as Row<T>);
            return [...rows.values()].filter(
              (row) => state === undefined || row.state === state,
            );
          },
          async page<T>(
            table: Table,
            page: import("./storage/contract.js").PageQuery,
          ) {
            if (pending.size === 0) return reader.page<T>(table, page);
            return (await this.list<T>(table, page.state))
              .filter(
                (row) =>
                  row.id > (page.after ?? "") &&
                  (page.dueBefore === undefined ||
                    dueAt(row) <= page.dueBefore),
              )
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              .slice(0, page.limit);
          },
          async put(table, row) {
            pending.set(`${table}:${row.id}`, {
              table,
              row: structuredClone(row),
            });
          },
        };
        const result = await run(tx);
        const token = crypto.randomUUID();
        const statements = [
          db
            .prepare(
              "UPDATE brokeboy_locks SET revision=revision+1,token=? WHERE scope=? AND revision=?",
            )
            .bind(token, scope, head.revision),
        ];
        for (const { table, row } of pending.values()) {
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
        }
        const committed = await db.batch(statements);
        if (committed[0]?.meta?.changes === 1) return result;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(2 ** attempt, 32)),
        );
      }
      throw new BillingError(
        "storage_contention",
        "Concurrent mutations exceeded the retry budget. Retry with the same idempotency key.",
      );
    },
    async read(scope, run) {
      return run(readonly(recordTransaction(scope, "d1", queryFor(primary()))));
    },
    async scopes(after = "", limit = 100, prefix = "") {
      return (
        await queryFor(primary())(
          "SELECT scope FROM brokeboy_locks WHERE scope>? AND scope LIKE ? ORDER BY scope LIMIT ?",
          [after, `${prefix}%`, limit],
        )
      ).map((row) => row.scope);
    },
  };
}
