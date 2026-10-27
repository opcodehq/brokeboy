"use client";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

const messages: Record<string, string> = {
  provider_missing: "Billing is not available yet.",
  payment_processing:
    "Your payment is still processing. Please try again shortly.",
  payment_setup_required: "Add a payment method to continue.",
  insufficient_balance: "You do not have enough credits.",
  spend_limit_exceeded: "Your spending limit has been reached.",
  subscription_exists: "Manage your existing subscription to change plans.",
  checkout_in_progress:
    "Finish your current checkout before choosing another plan.",
  invalid_decimal: "Enter a valid amount.",
  unauthenticated: "Sign in to manage billing.",
  origin_not_allowed: "Refresh the page and try again.",
};
export class BillingClientError extends Error {
  constructor(readonly code: string) {
    super(messages[code] ?? "Unable to update billing. Please try again.");
    this.name = "BillingClientError";
  }
}
export type BillingClient = {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  post<T>(
    path: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<T>;
};
export function createBillingClient(
  basePath = "/api/billing",
  fetcher: typeof fetch = fetch,
): BillingClient {
  async function send<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetcher(`${basePath}${path}`, {
      credentials: "same-origin",
      ...init,
    });
    const body = await response.json();
    if (!response.ok)
      throw new BillingClientError(
        body.error?.code ?? "billing_request_failed",
      );
    return body as T;
  }
  return {
    get: (path, signal) => send(path, { signal }),
    post: (path, body, key) =>
      send(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...body,
          idempotencyKey: key ?? crypto.randomUUID(),
        }),
      }),
  };
}
const Context = createContext<BillingClient | null>(null);
export function BillingProvider({
  client,
  children,
}: {
  client: BillingClient;
  children: ReactNode;
}) {
  return createElement(Context.Provider, { value: client }, children);
}
export function useBilling() {
  const client = useContext(Context);
  if (!client) throw new Error("Wrap billing components in BillingProvider.");
  return client;
}
export function useBillingResource<T>(path: string) {
  const client = useBilling();
  const [state, setState] = useState<{
    data?: T;
    error?: Error;
    loading: boolean;
  }>({ loading: true });
  const [generation, setGeneration] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation is the explicit refresh signal.
  useEffect(() => {
    const abort = new AbortController();
    setState({ loading: true });
    client.get<T>(path, abort.signal).then(
      (data) => {
        if (!abort.signal.aborted) setState({ data, loading: false });
      },
      (error) => {
        if (!abort.signal.aborted)
          setState({
            error:
              error instanceof Error
                ? error
                : new Error("billing_request_failed"),
            loading: false,
          });
      },
    );
    return () => abort.abort();
  }, [client, path, generation]);
  const refresh = useCallback(() => setGeneration((n) => n + 1), []);
  return { ...state, refresh };
}
export function useBalance(feature: string) {
  return useBillingResource<{
    feature: string;
    available: string;
    reserved: string;
    spent: string;
  }>(`/balance?feature=${encodeURIComponent(feature)}`);
}
export function useSubscriptions() {
  return useBillingResource<{
    subscriptions: {
      id: string;
      status: string;
      plan: { name: string };
      periodEnd: number;
    }[];
  }>("/subscriptions");
}
export function useUsage() {
  return useBillingResource<{
    usage: {
      id: string;
      feature: string;
      quantity: string;
      createdAt: number;
    }[];
  }>("/usage");
}
export function useBillingAction() {
  const client = useBilling();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();
  const execute = useCallback(
    async <T,>(path: string, body: Record<string, unknown>, key?: string) => {
      setPending(true);
      setError(undefined);
      try {
        return await client.post<T>(path, body, key);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error("billing_request_failed");
        setError(failure);
        throw failure;
      } finally {
        setPending(false);
      }
    },
    [client],
  );
  return { execute, pending, error };
}
function Status({ loading, error }: { loading: boolean; error?: Error }) {
  return (
    <span role={error ? "alert" : "status"}>
      {error ? error.message : loading ? "Loading billing…" : ""}
    </span>
  );
}
function PaymentButton({
  path,
  body,
  children,
}: {
  path: string;
  body: Record<string, unknown>;
  children: ReactNode;
}) {
  const { execute, pending, error } = useBillingAction();
  const [key] = useState(() => crypto.randomUUID());
  const [operationError, setOperationError] = useState<Error>();
  const [completed, setCompleted] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setOperationError(undefined);
          void execute<{
            status: string;
            error?: string;
            result?: { url?: string };
          }>(path, body, key)
            .then((operation) => {
              if (operation.status !== "done")
                throw new BillingClientError(
                  operation.error ?? "payment_processing",
                );
              if (operation.result?.url) {
                const destination = new URL(operation.result.url);
                if (
                  destination.protocol !== "https:" &&
                  !(
                    destination.protocol === "http:" &&
                    ["localhost", "127.0.0.1"].includes(destination.hostname)
                  )
                )
                  throw new BillingClientError("invalid_payment_url");
                window.location.assign(destination.toString());
              } else setCompleted(true);
            })
            .catch((error) =>
              setOperationError(
                error instanceof Error
                  ? error
                  : new Error("billing_request_failed"),
              ),
            );
        }}
      >
        {pending ? "Please wait…" : children}
      </button>
      {(error ?? operationError) && (
        <span role="alert">{(error ?? operationError)?.message}</span>
      )}
      {completed && <span role="status">Billing updated.</span>}
    </>
  );
}
export function PricingTable({ successUrl }: { successUrl: string }) {
  const { data, loading, error } = useBillingResource<{
    plans: {
      id: string;
      name: string;
      amount?: string;
      currency?: string;
      interval?: string;
    }[];
  }>("/catalog");
  return (
    <section aria-label="Plans">
      <Status loading={loading} error={error} />
      {data?.plans.map((plan) => (
        <article key={plan.id}>
          <h3>{plan.name}</h3>
          <p>
            {plan.amount ?? "0"} {plan.currency?.toUpperCase()}{" "}
            {plan.interval ? `per ${plan.interval}` : ""}
          </p>
          <PaymentButton
            path="/checkout"
            body={{ planId: plan.id, successUrl }}
          >
            Choose {plan.name}
          </PaymentButton>
        </article>
      ))}
    </section>
  );
}
export function CreditBalance({ feature }: { feature: string }) {
  const { data, loading, error } = useBalance(feature);
  return (
    <output aria-label={`${feature} balance`}>
      <Status loading={loading} error={error} />
      {data && `${data.available} available · ${data.reserved} reserved`}
    </output>
  );
}
export function SubscriptionDetails() {
  const { data, loading, error } = useSubscriptions();
  return (
    <section aria-label="Subscriptions">
      <Status loading={loading} error={error} />
      {data?.subscriptions.map((s) => (
        <p key={s.id}>
          {s.plan.name}: {s.status}
        </p>
      ))}
    </section>
  );
}
export function UsageHistory() {
  const { data, loading, error } = useUsage();
  return (
    <section aria-label="Usage">
      <Status loading={loading} error={error} />
      <ul>
        {data?.usage.map((u) => (
          <li key={u.id}>
            {u.feature}: {u.quantity} · {new Date(u.createdAt).toISOString()}
          </li>
        ))}
      </ul>
    </section>
  );
}
export function CustomerPortalButton({
  returnUrl,
  children = "Manage billing",
}: {
  returnUrl: string;
  children?: ReactNode;
}) {
  return (
    <PaymentButton path="/portal" body={{ returnUrl }}>
      {children}
    </PaymentButton>
  );
}
export function TopUpButton({
  planId,
  successUrl,
  children = "Buy credits",
}: {
  planId: string;
  successUrl: string;
  children?: ReactNode;
}) {
  return (
    <PaymentButton path="/checkout" body={{ planId, successUrl }}>
      {children}
    </PaymentButton>
  );
}
export function SpendingControls() {
  const { data, loading, error, refresh } = useBillingResource<{
    overageLimits?: Record<string, string>;
  }>("/controls");
  const { execute, pending, error: actionError } = useBillingAction();
  const [feature, setFeature] = useState("");
  const [amount, setAmount] = useState("0");
  return (
    <section aria-label="Spending controls">
      <Status loading={loading} error={error ?? actionError} />
      {data && (
        <ul>
          {Object.entries(data.overageLimits ?? {}).map(([id, value]) => (
            <li key={id}>
              {id}: {value}
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void execute("/controls", {
            overageLimits: { ...data?.overageLimits, [feature]: amount },
          })
            .then(refresh)
            .catch(() => {});
        }}
      >
        <label>
          Feature
          <input
            required
            value={feature}
            onChange={(e) => setFeature(e.target.value)}
          />
        </label>
        <label>
          Overage cap
          <input
            required
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <button type="submit" disabled={pending}>
          Save cap
        </button>
      </form>
    </section>
  );
}
export function AdminInspector({ customerId }: { customerId: string }) {
  const { data, loading, error, refresh } = useBillingResource<unknown>(
    `/admin/customer?customerId=${encodeURIComponent(customerId)}`,
  );
  return (
    <section aria-label="Billing administration">
      <button type="button" onClick={refresh}>
        Refresh
      </button>
      <Status loading={loading} error={error} />
      {data !== undefined && <pre>{JSON.stringify(data, null, 2)}</pre>}
    </section>
  );
}
