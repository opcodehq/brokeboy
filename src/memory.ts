import {
  dueAt,
  type Row,
  readonly,
  type Storage,
  type Table,
  type Transaction,
} from "./storage/contract.js";
/** Ephemeral adapter for tests and local demos. Never use for production billing. */
export function memoryAdapter(): Storage {
  const data = new Map<string, Map<Table, Map<string, Row>>>();
  const tails = new Map<string, Promise<void>>();
  function transaction(scope: string): Transaction {
    let bucket = data.get(scope);
    if (!bucket) {
      bucket = new Map();
      data.set(scope, bucket);
    }
    return {
      async get<T>(table: Table, id: string) {
        return structuredClone(
          bucket.get(table)?.get(id) ?? null,
        ) as Row<T> | null;
      },
      async list<T>(table: Table, state?: string) {
        return structuredClone(
          [...(bucket.get(table)?.values() ?? [])].filter(
            (r) => state === undefined || r.state === state,
          ),
        ) as Row<T>[];
      },
      async page<T>(
        table: Table,
        query: import("./storage/contract.js").PageQuery,
      ) {
        return (await this.list<T>(table, query.state))
          .filter(
            (row) =>
              row.id > (query.after ?? "") &&
              (query.dueBefore === undefined || dueAt(row) <= query.dueBefore),
          )
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, query.limit);
      },
      async put(table, row) {
        let rows = bucket.get(table);
        if (!rows) {
          rows = new Map();
          bucket.set(table, rows);
        }
        rows.set(row.id, structuredClone(row));
      },
    };
  }
  return {
    async atomic(scope, run) {
      const previous = tails.get(scope) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      tails.set(scope, tail);
      await previous;
      const before = structuredClone(data.get(scope));
      try {
        return await run(transaction(scope));
      } catch (error) {
        if (before) data.set(scope, before);
        else data.delete(scope);
        throw error;
      } finally {
        release();
        if (tails.get(scope) === tail) tails.delete(scope);
      }
    },
    async read(scope, run) {
      await tails.get(scope);
      return run(readonly(transaction(scope)));
    },
    async scopes(after = "", limit = 100, prefix = "") {
      return [...data.keys()]
        .filter((s) => s > after && s.startsWith(prefix))
        .sort()
        .slice(0, limit);
    },
  };
}
