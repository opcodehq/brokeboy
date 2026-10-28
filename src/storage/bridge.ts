import * as Effect from "effect/Effect";
import { database, runPromise } from "../core/effect.js";
import type { Storage, Transaction } from "./contract.js";
import type { EffectStorage, EffectTransaction } from "./effect.js";

const natives = new WeakMap<
  Storage,
  {
    native: EffectStorage;
    atomic: Storage["atomic"];
    read: Storage["read"];
    scopes: Storage["scopes"];
  }
>();
const nativeTransaction = (tx: Transaction): EffectTransaction => ({
  get: (table, id) => database(() => tx.get(table, id)),
  list: (table, state) => database(() => tx.list(table, state)),
  page: (table, query) => database(() => tx.page(table, query)),
  put: (table, row) => database(() => tx.put(table, row)),
});
const promiseTransaction = (tx: EffectTransaction): Transaction => ({
  get: (table, id) => runPromise(tx.get(table, id)),
  list: (table, state) => runPromise(tx.list(table, state)),
  page: (table, query) => runPromise(tx.page(table, query)),
  put: (table, row) => runPromise(tx.put(table, row)),
});
/** Legacy Promise callbacks cannot be cancelled midway through a transaction. */
export function effectStorage(storage: Storage): EffectStorage {
  const native = natives.get(storage);
  if (
    native &&
    native.atomic === storage.atomic &&
    native.read === storage.read &&
    native.scopes === storage.scopes
  )
    return native.native;
  return {
    atomic: (scope, run) =>
      Effect.uninterruptible(
        database(() =>
          storage.atomic(scope, (tx) => runPromise(run(nativeTransaction(tx)))),
        ),
      ),
    read: (scope, run) =>
      database(() =>
        storage.read(scope, (tx) => runPromise(run(nativeTransaction(tx)))),
      ),
    scopes: (after, limit, prefix) =>
      database(() => storage.scopes(after, limit, prefix)),
  };
}
export function promiseStorage(storage: EffectStorage): Storage {
  const facade: Storage = {
    atomic: (scope, run) =>
      runPromise(
        storage.atomic(scope, (tx) =>
          database(() => run(promiseTransaction(tx))),
        ),
      ),
    read: (scope, run) =>
      runPromise(
        storage.read(scope, (tx) =>
          database(() => run(promiseTransaction(tx))),
        ),
      ),
    scopes: (after, limit, prefix) =>
      runPromise(storage.scopes(after, limit, prefix)),
  };
  natives.set(facade, {
    native: storage,
    atomic: facade.atomic,
    read: facade.read,
    scopes: facade.scopes,
  });
  return facade;
}
