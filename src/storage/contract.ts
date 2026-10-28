export const tables = [
  "resources",
  "customers",
  "entities",
  "catalog",
  "subscriptions",
  "grants",
  "movements",
  "reservations",
  "usage",
  "operations",
  "inbox",
  "work",
  "events",
  "audit",
  "counters",
  "licenses",
  "workflows",
] as const;
export type Table = (typeof tables)[number];
export type Row<T = unknown> = { id: string; state: string; data: T };
export type PageQuery = {
  after?: string;
  limit: number;
  state?: string;
  dueBefore?: number;
};
export interface Transaction {
  page<T>(table: Table, query: PageQuery): Promise<Row<T>[]>;
  get<T>(table: Table, id: string): Promise<Row<T> | null>;
  list<T>(table: Table, state?: string): Promise<Row<T>[]>;
  put<T>(table: Table, row: Row<T>): Promise<void>;
}
export interface Storage {
  atomic<T>(scope: string, run: (tx: Transaction) => Promise<T>): Promise<T>;
  read<T>(scope: string, run: (tx: Transaction) => Promise<T>): Promise<T>;
  scopes(after?: string, limit?: number, prefix?: string): Promise<string[]>;
}
export function readonly(tx: Transaction): Transaction {
  return {
    get: tx.get.bind(tx),
    list: tx.list.bind(tx),
    page: tx.page.bind(tx),
    put: async () => {
      throw new Error("Read-only transaction");
    },
  };
}

export function indexedRow<T>(
  id: string,
  state: string,
  data: T,
  table: Table,
): Row<T> {
  const kind = (data as { kind?: string } | null | undefined)?.kind;
  const indexedState =
    table === "work" && (state === "pending" || state === "failed")
      ? kind === "meter"
        ? `meter_${state}`
        : kind === "workflow_timeout"
          ? `internal_${state}`
          : state
      : state;
  return { id, state: indexedState, data };
}
export const put = <T>(
  tx: Transaction,
  table: Table,
  id: string,
  data: T,
  state = "active",
) => tx.put(table, indexedRow(id, state, data, table));

export function dueAt(row: Row): number {
  const data = row.data as { availableAt?: number; leaseUntil?: number };
  return Math.max(
    data.availableAt ?? 0,
    row.state === "processing" ? (data.leaseUntil ?? 0) : 0,
  );
}
