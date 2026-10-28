import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { BillingError } from "./errors.js";

export class StorageError extends Schema.TaggedError<StorageError>()(
  "StorageError",
  { message: Schema.String, cause: Schema.Defect() },
) {}
export class ProviderError extends Schema.TaggedError<ProviderError>()(
  "ProviderError",
  { message: Schema.String, cause: Schema.Defect() },
) {}
export class IntegrationError extends Schema.TaggedError<IntegrationError>()(
  "IntegrationError",
  { message: Schema.String, cause: Schema.Defect() },
) {}
export type BillingFailure =
  | BillingError
  | StorageError
  | ProviderError
  | IntegrationError;
export type BillingEffect<A> = Effect.Effect<A, BillingFailure>;
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Integration failed";
export const failure = (error: unknown): BillingFailure =>
  error instanceof BillingError ||
  error instanceof StorageError ||
  error instanceof ProviderError ||
  error instanceof IntegrationError
    ? error
    : new IntegrationError({ message: message(error), cause: error });
export const fail = (error: unknown) => Effect.fail(failure(error));
const isFailure = (cause: unknown): cause is BillingFailure =>
  cause instanceof BillingError ||
  cause instanceof StorageError ||
  cause instanceof ProviderError ||
  cause instanceof IntegrationError;
export const external = <A>(
  run: (signal: AbortSignal) => PromiseLike<A>,
): BillingEffect<A> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      isFailure(cause)
        ? cause
        : new ProviderError({ message: message(cause), cause }),
  });
export const integration = <A>(
  run: (signal: AbortSignal) => PromiseLike<A>,
): BillingEffect<A> => Effect.tryPromise({ try: run, catch: failure });
export const database = <A>(run: () => PromiseLike<A>): BillingEffect<A> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        isFailure(cause)
          ? cause
          : new StorageError({ message: message(cause), cause }),
    }),
  );
export const sync = <A>(run: () => A): BillingEffect<A> =>
  Effect.try({ try: run, catch: failure });

type Program<A> = () => Generator<Effect.Effect<any, BillingFailure>, A, any>;
/** Compose native effects while promoting failures from shared pure validators. */
export function task<A>(body: Program<A>): BillingEffect<A>;
export function task<Self, A>(
  options: { self: Self },
  body: (this: Self) => Generator<Effect.Effect<any, BillingFailure>, A, any>,
): BillingEffect<A>;
export function task<A>(
  first: Program<A> | { self: any },
  body?: Program<A>,
): BillingEffect<A> {
  const program =
    typeof first === "function"
      ? Effect.fnUntraced(first)()
      : Effect.fnUntraced(body!.bind(first.self))();
  return program.pipe(
    Effect.catchDefect((error) =>
      error instanceof BillingError ? Effect.fail(error) : Effect.die(error),
    ),
  );
}

/** Recover application failures without converting cancellation into success. */
export const recover = <A, B>(
  effect: BillingEffect<A>,
  handler: (error: unknown) => BillingEffect<B>,
): BillingEffect<A | B> =>
  Effect.catchCause(effect, (cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : handler(Cause.squash(cause)),
  );

/** Promise compatibility belongs only at application/integration boundaries. */
export const runPromise = <A, E>(
  effect: Effect.Effect<A, E>,
  options?: Effect.RunOptions,
): Promise<A> =>
  Effect.runPromiseExit(effect, options).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  });

export const storageSync = <A>(run: () => A): BillingEffect<A> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof BillingError
        ? cause
        : new StorageError({ message: message(cause), cause }),
  });

export const externalArgs = <const Args extends readonly unknown[], A>(
  args: Args,
  run: (...args: Args) => PromiseLike<A>,
): BillingEffect<A> => external(() => run(...args));
