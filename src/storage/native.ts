import * as Effect from "effect/Effect";
import { BillingError } from "../core/errors.js";
import { indexedRow, type Table } from "./contract.js";
import type { EffectTransaction } from "./effect.js";

export type { PageQuery, Row, Table } from "./contract.js";
export { dueAt, tables } from "./contract.js";
export type {
  EffectStorage as Storage,
  EffectTransaction as Transaction,
} from "./effect.js";
export const put = <T>(
  tx: EffectTransaction,
  table: Table,
  id: string,
  data: T,
  state = "active",
) => tx.put(table, indexedRow(id, state, data, table));
export const readonly = (tx: EffectTransaction): EffectTransaction => ({
  get: tx.get.bind(tx),
  list: tx.list.bind(tx),
  page: tx.page.bind(tx),
  put: () => Effect.fail(new BillingError("readonly_transaction")),
});
