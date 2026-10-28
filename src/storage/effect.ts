import type { BillingEffect } from "../core/effect.js";
import type { PageQuery, Row, Table } from "./contract.js";
export interface EffectTransaction {
  page<T>(table: Table, query: PageQuery): BillingEffect<Row<T>[]>;
  get<T>(table: Table, id: string): BillingEffect<Row<T> | null>;
  list<T>(table: Table, state?: string): BillingEffect<Row<T>[]>;
  put<T>(table: Table, row: Row<T>): BillingEffect<void>;
}
export interface EffectStorage {
  atomic<T>(
    scope: string,
    run: (tx: EffectTransaction) => BillingEffect<T>,
  ): BillingEffect<T>;
  read<T>(
    scope: string,
    run: (tx: EffectTransaction) => BillingEffect<T>,
  ): BillingEffect<T>;
  scopes(
    after?: string,
    limit?: number,
    prefix?: string,
  ): BillingEffect<string[]>;
}
