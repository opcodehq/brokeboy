import * as Effect from "effect/Effect";
import type Stripe from "stripe";
import { hash } from "./core/catalog.js";
import { minorUnits, nonnegative, units } from "./core/decimal.js";
import {
  type BillingEffect,
  external,
  externalArgs,
  fail,
  recover,
  task,
} from "./core/effect.js";
import { assert, BillingError } from "./core/errors.js";
import type {
  EffectPaymentCommand as PaymentCommand,
  EffectPaymentProvider as PaymentProvider,
  EffectResourceRegistry as ResourceRegistry,
} from "./core/services.js";
import type {
  Environment,
  ProviderEvent,
  PublishedPlan,
  Subscription,
} from "./core/types.js";
import { returnUrl as url } from "./core/urls.js";
import { promiseProvider } from "./integrations.js";
export type StripeOptions = {
  client: Stripe;
  webhookSecret: string;
  environment?: Environment;
  cryptoProvider?: Stripe.CryptoProvider;
  now?: () => number;
};
function safeInteger(value: string): number {
  const n = BigInt(value);
  assert(
    n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER),
    "provider_amount_overflow",
  );
  return Number(n);
}
export function stripeService(options: StripeOptions): PaymentProvider {
  const client = options.client,
    environment = options.environment ?? "test",
    now = options.now ?? Date.now;
  const metadata = (
    customerId: string,
    plan?: PublishedPlan,
    entityId?: unknown,
  ) => ({
    brokeboy_customer: customerId,
    brokeboy_environment: environment,
    ...(plan ? { brokeboy_plan: plan.id, brokeboy_version: plan.version } : {}),
    ...(entityId ? { brokeboy_entity: String(entityId) } : {}),
  });
  const verifiedCustomers = new Set<string>();
  function customerFor(command: PaymentCommand) {
    return task(function* () {
      if (command.customer.stripeCustomerId) {
        const id = command.customer.stripeCustomerId;
        if (!verifiedCustomers.has(id)) {
          const customer = yield* external(() => client.customers.retrieve(id));
          assert(
            !customer.deleted && customer.livemode === (environment === "live"),
            "environment_mismatch",
          );
          if (customer.metadata.brokeboy_customer)
            assert(
              customer.metadata.brokeboy_customer === command.customer.id &&
                customer.metadata.brokeboy_environment === environment,
              "customer_mapping_conflict",
            );
          verifiedCustomers.add(id);
        }
        return id;
      }
      const key = yield* hash({ environment, customer: command.customer.id });
      // This key is identical across concurrent operations for this customer.
      assert(command.resources, "resource_registry_required");
      const id = yield* command.resources.getOrCreate(
        `customer:${key}`,
        (idempotencyKey) => {
          return task(function* () {
            const created = yield* external(() =>
              client.customers.create(
                { metadata: metadata(command.customer.id) },
                { idempotencyKey, timeout: 20000, maxNetworkRetries: 1 },
              ),
            );
            assert(
              created.livemode === (environment === "live"),
              "environment_mismatch",
            );
            return created.id;
          });
        },
      );
      const customer = yield* external(() => client.customers.retrieve(id));
      assert(!customer.deleted, "customer_not_found");
      assert(
        customer.livemode === (environment === "live"),
        "environment_mismatch",
      );
      verifiedCustomers.add(customer.id);
      return customer.id;
    });
  }
  function priceFor(
    plan: PublishedPlan,
    oneTime: boolean,
    resources: ResourceRegistry | undefined,
  ) {
    return task(function* () {
      if (plan.stripePriceId) return plan.stripePriceId;
      assert(resources, "resource_registry_required");
      const product = yield* resources.getOrCreate(
        `product:${plan.version}`,
        (idempotencyKey) => {
          return task(function* () {
            return (yield* external(() =>
              client.products.create(
                {
                  name: plan.name,
                  metadata: {
                    brokeboy_plan: plan.id,
                    brokeboy_version: plan.version,
                  },
                },
                { idempotencyKey, timeout: 20000, maxNetworkRetries: 1 },
              ),
            )).id;
          });
        },
      );
      return yield* resources.getOrCreate(
        `price:${plan.version}`,
        (idempotencyKey) => {
          return task(function* () {
            return (yield* external(() =>
              client.prices.create(
                {
                  product,
                  currency: plan.currency ?? "usd",
                  unit_amount: safeInteger(
                    minorUnits(plan.amount ?? "0", plan.currency ?? "usd"),
                  ),
                  ...(oneTime
                    ? {}
                    : { recurring: { interval: plan.interval ?? "month" } }),
                  metadata: {
                    brokeboy_version: plan.version,
                    brokeboy_plan: plan.id,
                  },
                },
                { idempotencyKey, timeout: 20000, maxNetworkRetries: 1 },
              ),
            )).id;
          });
        },
      );
    });
  }
  function meterPricesFor(
    plan: PublishedPlan,
    resources: ResourceRegistry | undefined,
  ): BillingEffect<Record<string, string>> {
    return task(function* () {
      const result = { ...plan.stripeMeterPriceIds };
      for (const item of plan.items.filter((i) => i.overage)) {
        if (result[item.feature]) continue;
        assert(resources, "resource_registry_required");
        const eventName = `bb_${plan.version.slice(0, 24)}_${(yield* hash(item.feature)).slice(0, 16)}`;
        const meter = yield* resources.getOrCreate(
          `meter:${eventName}`,
          (idempotencyKey) => {
            return task(function* () {
              return (yield* external(() =>
                client.billing.meters.create(
                  {
                    display_name: `${plan.name}: ${item.feature}`,
                    event_name: eventName,
                    default_aggregation: { formula: "sum" },
                    customer_mapping: {
                      type: "by_id",
                      event_payload_key: "stripe_customer_id",
                    },
                    value_settings: { event_payload_key: "value" },
                  },
                  { idempotencyKey, timeout: 20000, maxNetworkRetries: 1 },
                ),
              )).id;
            });
          },
        );
        const product = yield* resources.getOrCreate(
          `meter-product:${eventName}`,
          (idempotencyKey) => {
            return task(function* () {
              return (yield* external(() =>
                client.products.create(
                  {
                    name: `${plan.name}: ${item.feature}`,
                    metadata: {
                      brokeboy_version: plan.version,
                      brokeboy_feature: item.feature,
                    },
                  },
                  { idempotencyKey, timeout: 20000, maxNetworkRetries: 1 },
                ),
              )).id;
            });
          },
        );
        result[item.feature] = yield* resources.getOrCreate(
          `meter-price:${eventName}`,
          (idempotencyKey) => {
            return task(function* () {
              return (yield* external(() =>
                client.prices.create(
                  {
                    product,
                    currency: plan.currency ?? "usd",
                    unit_amount: 1,
                    recurring: {
                      interval: plan.interval ?? "month",
                      usage_type: "metered",
                      meter,
                    },
                    metadata: {
                      brokeboy_version: plan.version,
                      brokeboy_feature: item.feature,
                    },
                  },
                  { idempotencyKey, timeout: 20000, maxNetworkRetries: 1 },
                ),
              )).id;
            });
          },
        );
      }
      return result;
    });
  }
  function ownedSubscription(customer: string, id: unknown) {
    return task(function* () {
      assert(typeof id === "string", "subscription_required");
      const sub = yield* external(() => client.subscriptions.retrieve(id));
      assert(
        sub.customer === customer ||
          (typeof sub.customer === "object" && sub.customer.id === customer),
        "subscription_not_found",
      );
      assert(
        sub.metadata.brokeboy_environment === environment,
        "environment_mismatch",
      );
      return sub;
    });
  }
  function scheduleFor(sub: Stripe.Subscription, key: string) {
    return task(function* () {
      if (sub.schedule)
        return yield* external(() =>
          client.subscriptionSchedules.retrieve(
            typeof sub.schedule === "string" ? sub.schedule : sub.schedule!.id,
          ),
        );
      return yield* external(() =>
        client.subscriptionSchedules.create(
          { from_subscription: sub.id },
          { idempotencyKey: `${key}:create` },
        ),
      );
    });
  }
  function currentPhase(
    sub: Stripe.Subscription,
    schedule: Stripe.SubscriptionSchedule,
  ): Stripe.SubscriptionScheduleUpdateParams.Phase {
    assert(schedule.current_phase, "schedule_phase_missing");
    return {
      start_date: schedule.current_phase.start_date,
      end_date: schedule.current_phase.end_date,
      items: sub.items.data.map((i) => ({
        price: i.price.id,
        ...(i.price.recurring?.usage_type !== "metered"
          ? { quantity: i.quantity ?? 1 }
          : {}),
      })),
      metadata: sub.metadata,
    };
  }
  function execute(command: PaymentCommand): BillingEffect<unknown> {
    return task(function* () {
      const customer = yield* customerFor(command),
        input = command.input,
        key = command.id,
        request = { idempotencyKey: key, timeout: 20000, maxNetworkRetries: 1 };
      const plan = input.plan as PublishedPlan | undefined;
      const common = { stripeCustomerId: customer };
      switch (command.kind) {
        case "checkout": {
          assert(plan, "plan_required");
          const oneTime = plan.kind === "one_time";
          const price = yield* priceFor(plan, oneTime, command.resources);
          const count = nonnegative(String(input.quantity ?? "1"));
          assert(
            count > 0n && count % 1000000n === 0n,
            "invalid_seat_quantity",
          );
          const data = {
            ...metadata(command.customer.id, plan, input.entityId),
            brokeboy_purchase: key,
            brokeboy_quantity: String(input.quantity ?? "1"),
          };
          const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
            { price, quantity: safeInteger((count / 1000000n).toString()) },
          ];
          if (!oneTime)
            for (const meterPrice of Object.values(
              yield* meterPricesFor(plan, command.resources),
            ))
              lineItems.push({ price: meterPrice });
          const session = yield* external(() =>
            client.checkout.sessions.create(
              {
                customer,
                customer_update: { name: "auto", address: "auto" },
                mode: oneTime ? "payment" : "subscription",
                line_items: lineItems,
                success_url: url(input.successUrl),
                cancel_url: input.cancelUrl ? url(input.cancelUrl) : undefined,
                metadata: data,
                ...(oneTime
                  ? {
                      payment_intent_data: {
                        metadata: { ...data, brokeboy_purchase: key },
                      },
                      invoice_creation: {
                        enabled: true,
                        invoice_data: { metadata: data },
                      },
                    }
                  : {
                      subscription_data: {
                        metadata: data,
                        trial_period_days:
                          input.trialAllowed === true
                            ? plan.trialDays
                            : undefined,
                      },
                    }),
                automatic_tax: { enabled: input.automaticTax === true },
                billing_address_collection: "auto",
                tax_id_collection: { enabled: true },
                ...(!oneTime && plan.items.some((item) => item.overage)
                  ? { payment_method_collection: "always" as const }
                  : {}),
                ...(input.discountId
                  ? {
                      discounts: [{ promotion_code: String(input.discountId) }],
                    }
                  : { allow_promotion_codes: true }),
              },
              request,
            ),
          );
          return { ...common, id: session.id, url: session.url };
        }
        case "subscription_import": {
          assert(
            command.customer.stripeCustomerId,
            "customer_mapping_required",
          );
          assert(plan, "plan_required");
          const sub = yield* external(() =>
            client.subscriptions.retrieve(String(input.stripeSubscriptionId)),
          );
          assert(sub.customer === customer, "subscription_not_found");
          yield* external(() =>
            client.subscriptions.update(
              sub.id,
              { metadata: metadata(command.customer.id, plan, input.entityId) },
              request,
            ),
          );
          const providerEvent = yield* subscriptionEvent(
            {
              id: `import:${key}`,
              type: "subscription.updated",
              customerId: command.customer.id,
              data: {},
            },
            sub.id,
          );
          return { ...common, providerEvent };
        }
        case "portal":
          return {
            ...common,
            ...(yield* external(() =>
              client.billingPortal.sessions.create(
                { customer, return_url: url(input.returnUrl) },
                request,
              ),
            )),
          };
        case "invoices": {
          const page = yield* external(() =>
            client.invoices.list({ customer, limit: 100 }),
          );
          return {
            ...common,
            invoices: page.data.map((i) => ({
              id: i.id,
              status: i.status,
              total: i.total,
              currency: i.currency,
              url: i.hosted_invoice_url,
            })),
            hasMore: page.has_more,
          };
        }
        case "preview": {
          assert(plan, "plan_required");
          const sub = yield* ownedSubscription(customer, input.subscriptionId);
          const item = sub.items.data.find(
            (i) => i.price.recurring?.usage_type !== "metered",
          );
          assert(item, "subscription_item_missing");
          const invoice = yield* externalArgs(
            [yield* priceFor(plan, false, command.resources)],
            (argument0) =>
              client.invoices.createPreview({
                customer,
                subscription: sub.id,
                subscription_details: {
                  items: [
                    {
                      id: item.id,
                      price: argument0,
                    },
                  ],
                  proration_behavior: "always_invoice",
                },
              }),
          );
          return {
            ...common,
            amountDue: invoice.amount_due,
            currency: invoice.currency,
          };
        }
        case "subscription_update": {
          const sub = yield* ownedSubscription(customer, input.subscriptionId);
          const item = sub.items.data.find(
            (i) => i.price.recurring?.usage_type !== "metered",
          );
          assert(item, "subscription_item_missing");
          const quantity =
            input.quantity === undefined
              ? undefined
              : safeInteger(
                  (nonnegative(String(input.quantity)) / 1000000n).toString(),
                );
          if (input.quantity !== undefined)
            assert(
              units(String(input.quantity)) % 1000000n === 0n && quantity! > 0,
              "invalid_seat_quantity",
            );
          const effective = input.effective ?? "period_end";
          if (effective === "period_end") {
            const schedule = yield* scheduleFor(sub, key);
            const first = currentPhase(sub, schedule);
            const updated = yield* externalArgs(
              [
                yield* plan
                  ? priceFor(plan, false, command.resources)
                  : Effect.succeed(item.price.id),
                yield* plan
                  ? meterPricesFor(plan, command.resources)
                  : Effect.succeed({} as Record<string, string>),
              ],
              (argument1, argument2) =>
                client.subscriptionSchedules.update(
                  schedule.id,
                  {
                    end_behavior: "release",
                    phases: [
                      first,
                      {
                        items: [
                          {
                            price: plan ? argument1 : item.price.id,
                            quantity: quantity ?? item.quantity ?? 1,
                          },
                          ...(plan
                            ? Object.values(argument2)
                            : sub.items.data
                                .filter(
                                  (i) =>
                                    i.price.recurring?.usage_type === "metered",
                                )
                                .map((i) => i.price.id)
                          ).map((price) => ({ price })),
                        ],
                        metadata: metadata(
                          command.customer.id,
                          plan,
                          input.entityId,
                        ),
                      },
                    ],
                  },
                  request,
                ),
            );
            return { ...common, id: updated.id };
          }
          const meterItems: Stripe.SubscriptionUpdateParams.Item[] = plan
            ? [
                ...sub.items.data
                  .filter((i) => i.id !== item.id)
                  .map((i) => ({ id: i.id, deleted: true })),
                ...Object.values(
                  yield* meterPricesFor(plan, command.resources),
                ).map((price) => ({
                  price,
                })),
              ]
            : [];
          const updated = yield* externalArgs(
            [
              yield* plan
                ? priceFor(plan, false, command.resources)
                : Effect.succeed(item.price.id),
            ],
            (argument3) =>
              client.subscriptions.update(
                sub.id,
                {
                  items: [
                    {
                      id: item.id,
                      ...(plan ? { price: argument3 } : {}),
                      ...(quantity !== undefined ? { quantity } : {}),
                    },
                    ...meterItems,
                  ],
                  proration_behavior: "always_invoice",
                  payment_behavior: "pending_if_incomplete",
                  ...(plan
                    ? {
                        metadata: metadata(
                          command.customer.id,
                          plan,
                          input.entityId,
                        ),
                      }
                    : {}),
                },
                request,
              ),
          );
          return { ...common, id: updated.id, status: updated.status };
        }
        case "subscription_cancel": {
          const sub = yield* ownedSubscription(customer, input.subscriptionId);
          const result = input.immediately
            ? yield* external(() =>
                client.subscriptions.cancel(sub.id, {}, request),
              )
            : yield* external(() =>
                client.subscriptions.update(
                  sub.id,
                  { cancel_at_period_end: true },
                  request,
                ),
              );
          return { ...common, id: result.id, status: result.status };
        }
        case "subscription_pause": {
          const sub = yield* ownedSubscription(customer, input.subscriptionId);
          yield* external(() =>
            client.subscriptions.update(
              sub.id,
              { pause_collection: { behavior: "void" } },
              request,
            ),
          );
          return { ...common, id: sub.id };
        }
        case "subscription_resume": {
          const sub = yield* ownedSubscription(customer, input.subscriptionId);
          yield* external(() =>
            client.subscriptions.update(
              sub.id,
              { pause_collection: "" },
              request,
            ),
          );
          return { ...common, id: sub.id };
        }
        case "subscription_schedule": {
          const sub = yield* ownedSubscription(customer, input.subscriptionId);
          const phases = input.phases as {
            plan: PublishedPlan;
            iterations: number;
          }[];
          assert(
            Array.isArray(phases) && phases.length > 0 && phases.length <= 10,
            "invalid_schedule",
          );
          const schedule = yield* scheduleFor(sub, key);
          const built: Stripe.SubscriptionScheduleUpdateParams.Phase[] = [
            currentPhase(sub, schedule),
          ];
          for (const phase of phases) {
            assert(
              Number.isSafeInteger(phase.iterations) && phase.iterations > 0,
              "invalid_schedule",
            );
            built.push({
              items: [
                {
                  price: yield* priceFor(phase.plan, false, command.resources),
                  quantity:
                    sub.items.data.find(
                      (i) => i.price.recurring?.usage_type !== "metered",
                    )?.quantity ?? 1,
                },
                ...Object.values(
                  yield* meterPricesFor(phase.plan, command.resources),
                ).map((price) => ({ price })),
              ],
              duration: {
                interval: phase.plan.interval ?? "month",
                interval_count: phase.iterations,
              },
              metadata: metadata(
                command.customer.id,
                phase.plan,
                sub.metadata.brokeboy_entity,
              ),
            });
          }
          const result = yield* external(() =>
            client.subscriptionSchedules.update(
              schedule.id,
              { phases: built, end_behavior: "release" },
              request,
            ),
          );
          return { ...common, id: result.id };
        }
        case "invoice": {
          const currency = String(input.currency);
          const amount = safeInteger(
            minorUnits(String(input.amount), currency),
          );
          assert(amount > 0, "invalid_amount");
          const invoice = yield* external(() =>
            client.invoices.create(
              {
                customer,
                collection_method: "send_invoice",
                days_until_due: Number(input.daysUntilDue ?? 30),
                metadata: metadata(command.customer.id),
                auto_advance: false,
              },
              { idempotencyKey: `${key}:invoice` },
            ),
          );
          assert(invoice.id, "invoice_missing");
          yield* external(() =>
            client.invoiceItems.create(
              {
                customer,
                invoice: invoice.id,
                amount,
                currency,
                description: String(input.description),
              },
              { idempotencyKey: `${key}:line` },
            ),
          );
          const finalized = yield* external(() =>
            client.invoices.finalizeInvoice(invoice.id, {}, request),
          );
          return {
            ...common,
            id: finalized.id,
            url: finalized.hosted_invoice_url,
          };
        }
        case "refund": {
          assert(typeof input.paymentIntentId === "string", "payment_required");
          const payment = yield* external(() =>
            client.paymentIntents.retrieve(String(input.paymentIntentId)),
          );
          assert(payment.customer === customer, "payment_not_found");
          assert(
            typeof input.reason === "string" && input.reason.trim(),
            "reason_required",
          );
          const result = yield* external(() =>
            client.refunds.create(
              {
                payment_intent: payment.id,
                ...(input.amount
                  ? {
                      amount: safeInteger(
                        minorUnits(String(input.amount), payment.currency),
                      ),
                    }
                  : {}),
                metadata: {
                  ...metadata(command.customer.id),
                  brokeboy_reason: String(input.reason).slice(0, 500),
                },
              },
              request,
            ),
          );
          return { ...common, id: result.id, status: result.status };
        }
        case "credit_note": {
          assert(typeof input.invoiceId === "string", "invoice_required");
          const invoice = yield* external(() =>
            client.invoices.retrieve(String(input.invoiceId)),
          );
          assert(invoice.customer === customer, "invoice_not_found");
          const result = yield* external(() =>
            client.creditNotes.create(
              {
                invoice: String(input.invoiceId),
                amount: safeInteger(
                  minorUnits(String(input.amount), invoice.currency),
                ),
                memo: String(input.reason),
              },
              request,
            ),
          );
          return { ...common, id: result.id };
        }
        case "auto_topup": {
          assert(plan?.kind === "one_time", "topup_plan_must_be_one_time");
          const invoice = yield* external(() =>
            client.invoices.create(
              {
                customer,
                auto_advance: false,
                collection_method: "charge_automatically",
                metadata: {
                  ...metadata(command.customer.id, plan),
                  brokeboy_purchase: key,
                  brokeboy_topup_counter: String(input.counter),
                },
              },
              { idempotencyKey: `${key}:invoice` },
            ),
          );
          assert(invoice.id, "invoice_missing");
          yield* externalArgs(
            [yield* priceFor(plan, true, command.resources)],
            (argument4) =>
              client.invoiceItems.create(
                {
                  customer,
                  invoice: invoice.id,
                  pricing: { price: argument4 },
                  quantity: 1,
                },
                { idempotencyKey: `${key}:line` },
              ),
          );
          yield* external(() =>
            client.invoices.finalizeInvoice(
              invoice.id,
              {},
              { idempotencyKey: `${key}:finalize` },
            ),
          );
          const paid = yield* external(() =>
            client.invoices.pay(invoice.id, {}, request),
          );
          return { ...common, id: paid.id, status: paid.status };
        }
        case "meter": {
          assert(
            typeof input.subscriptionId === "string" &&
              typeof input.priceId === "string",
            "meter_not_configured",
          );
          const subscription = yield* ownedSubscription(
            customer,
            input.subscriptionId,
          );
          assert(
            subscription.items.data.some(
              (item) => item.price.id === input.priceId,
            ),
            "reconciliation_required",
            "The usage price is no longer attached to this subscription.",
          );
          const price = yield* external(() =>
            client.prices.retrieve(String(input.priceId)),
          );
          assert(
            price.recurring?.usage_type === "metered" &&
              price.unit_amount === 1 &&
              price.currency === input.currency,
            "meter_price_must_be_minor_unit",
          );
          const meterId = price.recurring.meter;
          assert(meterId, "meter_missing");
          const meter = yield* external(() =>
            client.billing.meters.retrieve(meterId),
          );
          assert(
            now() < Number(input.periodEnd) + 60 * 60000,
            "reconciliation_required",
          );
          const target = BigInt(
              minorUnits(String(input.total), String(input.currency)),
            ),
            previous = BigInt(String(input.previousMinor ?? "0")),
            delta = target - previous;
          if (delta === 0n)
            return { ...common, exportedMinor: target.toString() };
          const event = yield* external(() =>
            client.billing.meterEvents.create(
              {
                event_name: meter.event_name,
                identifier: key,
                payload: {
                  [meter.customer_mapping.event_payload_key]: customer,
                  [meter.value_settings.event_payload_key]: delta.toString(),
                },
                timestamp: Math.floor(
                  Math.min(now(), Number(input.periodEnd) - 1000) / 1000,
                ),
              },
              request,
            ),
          );
          return {
            ...common,
            id: event.identifier,
            exportedMinor: target.toString(),
          };
        }
        default:
          return yield* fail(new BillingError("unsupported_payment_operation"));
      }
    });
  }
  function verifiedEvent(
    request: Request,
    signature: string,
  ): BillingEffect<Stripe.Event> {
    return task(function* () {
      return yield* recover(
        task(function* () {
          const raw = yield* external(() => request.text());
          return yield* external(() =>
            client.webhooks.constructEventAsync(
              raw,
              signature,
              options.webhookSecret,
              undefined,
              options.cryptoProvider,
            ),
          );
        }),
        (_error) =>
          task(function* () {
            return yield* fail(new BillingError("invalid_signature"));
          }),
      );
    });
  }
  const provider: PaymentProvider = {
    execute,
    verifyResource(key, id) {
      return task(function* () {
        const [kind, ...parts] = key.split(":"),
          suffix = parts.join(":");
        if (kind === "customer") {
          const resource = yield* external(() => client.customers.retrieve(id));
          assert(
            !resource.deleted && resource.livemode === (environment === "live"),
            "resource_mapping_conflict",
          );
          assert(
            resource.metadata.brokeboy_environment === environment &&
              (yield* hash({
                environment,
                customer: resource.metadata.brokeboy_customer,
              })) === suffix,
            "resource_mapping_conflict",
          );
          return;
        }
        if (kind === "meter") {
          const resource = yield* external(() =>
            client.billing.meters.retrieve(id),
          );
          assert(
            resource.event_name === suffix &&
              resource.livemode === (environment === "live"),
            "resource_mapping_conflict",
          );
          return;
        }
        const resource =
          kind === "price" || kind === "meter-price"
            ? yield* external(() => client.prices.retrieve(id))
            : kind === "product" || kind === "meter-product"
              ? yield* external(() => client.products.retrieve(id))
              : undefined;
        assert(resource, "unknown_resource_kind");
        assert(
          resource.livemode === (environment === "live"),
          "environment_mismatch",
        );
        const version = resource.metadata.brokeboy_version;
        assert(version, "resource_mapping_conflict");
        if (kind === "price" || kind === "product")
          assert(version === suffix, "resource_mapping_conflict");
        else
          assert(
            suffix ===
              `bb_${version.slice(0, 24)}_${(yield* hash(resource.metadata.brokeboy_feature)).slice(0, 16)}`,
            "resource_mapping_conflict",
          );
      });
    },
    verify(request) {
      return task(function* () {
        const signature = request.headers.get("stripe-signature");
        assert(signature, "invalid_signature");
        const event = yield* verifiedEvent(request, signature);
        assert(
          event.livemode === (environment === "live"),
          "environment_mismatch",
        );
        const object = event.data.object as unknown as {
          metadata?: Record<string, string>;
          customer?: string;
          id: string;
        };
        const relevant = [
          "customer.subscription.created",
          "customer.subscription.updated",
          "customer.subscription.deleted",
          "customer.subscription.paused",
          "customer.subscription.resumed",
          "invoice.paid",
          "invoice.payment_failed",
          "checkout.session.completed",
          "checkout.session.async_payment_succeeded",
          "charge.refunded",
          "charge.dispute.created",
        ];
        if (!relevant.includes(event.type)) return null;
        let meta = object.metadata;
        if (event.type === "charge.dispute.created") {
          const dispute = event.data.object as Stripe.Dispute;
          const chargeId =
            typeof dispute.charge === "string"
              ? dispute.charge
              : dispute.charge?.id;
          if (chargeId) {
            const charge = yield* external(() =>
              client.charges.retrieve(chargeId),
            );
            object.customer =
              typeof charge.customer === "string"
                ? charge.customer
                : charge.customer?.id;
            meta = charge.metadata;
          }
        }
        if (!meta?.brokeboy_customer && typeof object.customer === "string") {
          const c = yield* external(() =>
            client.customers.retrieve(object.customer!),
          );
          if (!c.deleted) meta = c.metadata;
        }
        if (
          !meta?.brokeboy_customer ||
          meta.brokeboy_environment !== environment
        )
          return null;
        return {
          id: event.id,
          type: event.type,
          customerId: meta.brokeboy_customer,
          data: {
            stripeEventType: event.type,
            objectId: object.id,
            object: JSON.parse(JSON.stringify(event.data.object)),
          },
        };
      });
    },
    reconcile(event) {
      return task(function* () {
        const type = String(event.data.stripeEventType),
          object = event.data.object as any;
        if (type.startsWith("customer.subscription."))
          return yield* subscriptionEvent(event, object.id);
        if (type.startsWith("invoice.")) {
          const invoice = yield* external(() =>
            client.invoices.retrieve(object.id),
          );
          const parent = invoice.parent?.subscription_details?.subscription;
          if (parent)
            return yield* subscriptionEvent(
              event,
              typeof parent === "string" ? parent : parent.id,
            );
          if (invoice.status === "paid" && invoice.metadata?.brokeboy_plan)
            return {
              id: event.id,
              type: "purchase.paid",
              customerId: event.customerId,
              data: {
                planId: invoice.metadata.brokeboy_plan,
                planVersion: invoice.metadata.brokeboy_version,
                purchaseId: invoice.metadata.brokeboy_purchase ?? invoice.id,
                quantity: invoice.metadata.brokeboy_quantity ?? "1",
                entityId: invoice.metadata.brokeboy_entity,
                topupCounter: invoice.metadata.brokeboy_topup_counter,
              },
            };
        }
        if (
          type === "checkout.session.completed" ||
          type === "checkout.session.async_payment_succeeded"
        ) {
          const session = yield* external(() =>
            client.checkout.sessions.retrieve(object.id),
          );
          if (session.mode === "subscription" && session.subscription)
            return yield* subscriptionEvent(
              event,
              typeof session.subscription === "string"
                ? session.subscription
                : session.subscription.id,
            );
          if (
            session.payment_status === "paid" &&
            session.metadata?.brokeboy_plan
          )
            return {
              id: event.id,
              type: "purchase.paid",
              customerId: event.customerId,
              data: {
                planId: session.metadata.brokeboy_plan,
                planVersion: session.metadata.brokeboy_version,
                purchaseId: session.metadata.brokeboy_purchase ?? session.id,
                quantity: session.metadata.brokeboy_quantity ?? "1",
                entityId: session.metadata.brokeboy_entity,
              },
            };
        }
        if (type === "charge.refunded" || type === "charge.dispute.created") {
          const charge = yield* external(() =>
            client.charges.retrieve(
              type === "charge.refunded"
                ? object.id
                : typeof object.charge === "string"
                  ? object.charge
                  : object.charge.id,
            ),
          );
          let purchaseId: string | undefined;
          if (charge.payment_intent) {
            const pi = yield* external(() =>
              client.paymentIntents.retrieve(
                typeof charge.payment_intent === "string"
                  ? charge.payment_intent
                  : charge.payment_intent!.id,
              ),
            );
            purchaseId = pi.metadata.brokeboy_purchase;
          }
          const invoiceId = (
            charge as unknown as {
              invoice?: string;
            }
          ).invoice;
          if (!purchaseId && invoiceId)
            purchaseId = (yield* external(() =>
              client.invoices.retrieve(invoiceId),
            )).metadata?.brokeboy_purchase;
          return {
            ...event,
            type:
              type === "charge.refunded" &&
              charge.amount_refunded === charge.amount &&
              purchaseId
                ? "purchase.reversed"
                : "payment.reconciliation",
            data: { ...event.data, purchaseId, requiresReview: true },
          };
        }
        return event;
      });
    },
  };
  function subscriptionEvent(
    event: ProviderEvent,
    id: string,
  ): BillingEffect<ProviderEvent> {
    return task(function* () {
      const sub = yield* external(() =>
        client.subscriptions.retrieve(id, {
          expand: ["latest_invoice"],
        }),
      );
      const first = sub.items.data.find(
        (i) => i.price.recurring?.usage_type !== "metered",
      );
      assert(first, "subscription_item_missing");
      const latest =
        typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
      const trial = sub.status === "trialing";
      const paid = latest?.status === "paid";
      const paidThrough = paid
        ? first.current_period_end * 1000
        : trial
          ? (sub.trial_end ?? 0) * 1000
          : 0;
      assert(
        sub.metadata.brokeboy_customer === event.customerId &&
          sub.metadata.brokeboy_environment === environment,
        "customer_mapping_conflict",
      );
      const meterPriceIds = Object.fromEntries(
        sub.items.data
          .filter((i) => i.price.metadata.brokeboy_feature)
          .map((i) => [i.price.metadata.brokeboy_feature!, i.price.id]),
      );
      const status: Subscription["status"] = sub.pause_collection
        ? "paused"
        : ["active", "trialing", "past_due", "paused"].includes(sub.status)
          ? (sub.status as Subscription["status"])
          : ["canceled", "unpaid", "incomplete_expired"].includes(sub.status)
            ? "ended"
            : "pending";
      return {
        id: event.id,
        type: "subscription.updated",
        customerId: event.customerId,
        data: {
          meterPriceIds,
          pending: !!sub.pending_update,
          planId:
            first.price.metadata.brokeboy_plan ?? sub.metadata.brokeboy_plan,
          planVersion:
            first.price.metadata.brokeboy_version ??
            sub.metadata.brokeboy_version,
          subscription: {
            id: sub.id,
            stripeSubscriptionId: sub.id,
            entityId: sub.metadata.brokeboy_entity,
            status,
            periodStart: first.current_period_start * 1000,
            periodEnd: first.current_period_end * 1000,
            paidThrough,
            quantity: String(first.quantity ?? 1),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
          },
        },
      };
    });
  }
  return provider;
}
export const stripeProvider = (options: StripeOptions) =>
  promiseProvider(stripeService(options));
