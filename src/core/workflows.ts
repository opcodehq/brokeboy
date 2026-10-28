import { put, type Transaction } from "../storage/native.js";
import { decimal, nonnegative, positive, units } from "./decimal.js";
import { type BillingEffect, task } from "./effect.js";
import { assert, identifier, timestamp } from "./errors.js";
import type { Ledger } from "./ledger.js";
import type { Reservation, ScopeInput, Usage, WriteInput } from "./types.js";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
export type WorkflowStepDefinition = {
  id: string;
  dependsOn?: string[];
  budgets: {
    feature: string;
    amount: string;
    poolScope?: "customer" | "entity";
  }[];
  maxAttempts?: number;
};
export type WorkflowStep = WorkflowStepDefinition & {
  status:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "reconciliation";
  attempts: number;
  availableAt: number;
  reservations: {
    feature: string;
    reservationId: string;
  }[];
  lease?: {
    token: string;
    workerId: string;
    until: number;
  };
  result?: JsonValue;
  usageIds?: string[];
  error?: string;
  reportedActuals?: Record<string, string>;
};
export type Workflow = {
  id: string;
  entityId?: string;
  status: "active" | "succeeded" | "failed" | "cancelled" | "reconciliation";
  revision: number;
  cancellationRequested?: boolean;
  createdAt: number;
  expiresAt: number;
  steps: WorkflowStep[];
};
type Write = <T>(
  input: WriteInput,
  method: string,
  payload: unknown,
  run: (tx: Transaction, operation: string) => BillingEffect<T>,
) => BillingEffect<T>;
type Dependencies = {
  now: () => number;
  ledger: Ledger;
  write: Write;
  read: <T>(
    customerId: string,
    run: (tx: Transaction) => BillingEffect<T>,
  ) => BillingEffect<T>;
  event: (
    tx: Transaction,
    customerId: string,
    type: string,
    data: unknown,
  ) => BillingEffect<void>;
  enqueue: (
    tx: Transaction,
    id: string,
    kind: string,
    payload: Record<string, unknown>,
  ) => BillingEffect<void>;
  afterUsage: (
    tx: Transaction,
    customerId: string,
    feature: string,
    entityId?: string,
  ) => BillingEffect<void>;
};
type StepInput = WriteInput & {
  workflowId: string;
  stepId: string;
};
type ClaimInput = StepInput & {
  token: string;
};
/** Durable billing coordination. External work always runs in the application. */
export class Workflows {
  constructor(private readonly d: Dependencies) {}
  private load(
    tx: Transaction,
    input: ScopeInput & {
      workflowId: string;
    },
  ) {
    return task(function* () {
      const row = yield* tx.get<Workflow>(
        "workflows",
        identifier(input.workflowId),
      );
      assert(row && row.data.entityId === input.entityId, "workflow_not_found");
      return row.data;
    });
  }
  private step(workflow: Workflow, id: string) {
    const step = workflow.steps.find((s) => s.id === id);
    assert(step, "workflow_step_not_found");
    return step;
  }
  private save(
    tx: Transaction,
    customerId: string,
    workflow: Workflow,
    type: string,
  ) {
    return task({ self: this }, function* () {
      workflow.revision++;
      assert(
        new TextEncoder().encode(JSON.stringify(workflow)).length <= 524288,
        "workflow_state_too_large",
      );
      yield* put(tx, "workflows", workflow.id, workflow, workflow.status);
      yield* this.d.event(tx, customerId, type, {
        workflowId: workflow.id,
        revision: workflow.revision,
        status: workflow.status,
      });
      return workflow;
    });
  }
  private schedule(
    tx: Transaction,
    workflowId: string,
    at: number,
    token?: string,
  ) {
    return task({ self: this }, function* () {
      const id = `workflow:${crypto.randomUUID()}`;
      yield* this.d.enqueue(tx, id, "workflow_timeout", {
        workflowId,
        token,
      });
      const row = (yield* tx.get<{
        availableAt: number;
      }>("work", id))!;
      yield* put(tx, "work", id, { ...row.data, availableAt: at }, row.state);
    });
  }
  private release(tx: Transaction, step: WorkflowStep) {
    return task({ self: this }, function* () {
      for (const { reservationId } of step.reservations) {
        const row = yield* tx.get<Reservation>("reservations", reservationId);
        if (row?.state === "held")
          yield* this.d.ledger.finishReservation(tx, row.data, "released");
      }
    });
  }
  private refresh(tx: Transaction, workflow: Workflow) {
    return task({ self: this }, function* () {
      if (workflow.steps.some((s) => s.status === "reconciliation"))
        workflow.status = "reconciliation";
      else if (
        workflow.cancellationRequested ||
        workflow.steps.some((s) => s.status === "failed")
      ) {
        for (const step of workflow.steps)
          if (step.status === "pending") {
            yield* this.release(tx, step);
            step.status = "cancelled";
          }
        workflow.status = workflow.steps.some((s) => s.status === "running")
          ? "active"
          : workflow.cancellationRequested
            ? "cancelled"
            : "failed";
      } else if (workflow.steps.every((s) => s.status === "succeeded"))
        workflow.status = "succeeded";
      else workflow.status = "active";
    });
  }
  private validHolds(tx: Transaction, step: WorkflowStep) {
    return task({ self: this }, function* () {
      for (const { reservationId } of step.reservations) {
        const row = yield* tx.get<Reservation>("reservations", reservationId);
        if (
          row?.state !== "held" ||
          !(yield* this.d.ledger.reservationFunded(tx, row.data))
        )
          return false;
      }
      return true;
    });
  }
  private validateActuals(step: WorkflowStep, amounts: Record<string, string>) {
    assert(
      amounts &&
        Object.keys(amounts).length === step.budgets.length &&
        step.budgets.every((b) => Object.hasOwn(amounts, b.feature)),
      "workflow_actuals_required",
    );
    for (const b of step.budgets) nonnegative(amounts[b.feature]!);
  }
  private settle(
    tx: Transaction,
    input: StepInput,
    step: WorkflowStep,
    amounts: Record<string, string>,
    operation: string,
    result?: JsonValue,
    fundUncovered = false,
  ) {
    return task({ self: this }, function* () {
      this.validateActuals(step, amounts);
      if (result !== undefined) {
        const encoded = JSON.stringify(result, (_key, value) => {
          assert(
            typeof value !== "number" || Number.isFinite(value),
            "invalid_workflow_result",
          );
          assert(
            value === null ||
              !["undefined", "function", "symbol", "bigint"].includes(
                typeof value,
              ),
            "invalid_workflow_result",
          );
          return value;
        });
        assert(
          new TextEncoder().encode(encoded).length <= 65536,
          "workflow_result_too_large",
        );
      }
      // Validate every actual before any movement; the enclosing transaction covers the whole step.
      step.reportedActuals = amounts;
      const uncovered =
        !(yield* this.validHolds(tx, step)) ||
        step.budgets.some((b) => units(amounts[b.feature]!) > units(b.amount));
      if (
        uncovered &&
        !fundUncovered &&
        step.budgets.some((b) => units(amounts[b.feature]!) > 0n)
      ) {
        step.status = "reconciliation";
        step.error = "workflow_uncovered_actuals";
        return false;
      }
      const usages: Usage[] = [];
      if (uncovered) yield* this.release(tx, step);
      for (const { feature, reservationId } of step.reservations) {
        const r = (yield* tx.get<Reservation>("reservations", reservationId))!
          .data;
        const amount = amounts[feature]!;
        if (uncovered) {
          const allocations = yield* this.d.ledger.allocate(
            tx,
            feature,
            units(amount),
            r.poolScope === "customer" ? undefined : r.entityId,
            false,
            operation,
          );
          const usage: Usage = {
            id: crypto.randomUUID(),
            feature,
            entityId: r.entityId,
            quantity: amount,
            charged: amount,
            allocations,
            createdAt: this.d.now(),
            properties: {
              workflowId: input.workflowId,
              stepId: step.id,
              reservationId,
            },
          };
          yield* put(tx, "usage", usage.id, usage);
          usages.push(usage);
        } else
          usages.push(
            yield* this.d.ledger.settleReservation(tx, r, amount, operation, {
              workflowId: input.workflowId,
              stepId: step.id,
            }),
          );
        yield* this.d.afterUsage(
          tx,
          input.customerId,
          feature,
          r.poolScope === "customer" ? undefined : r.entityId,
        );
      }
      step.usageIds = usages.map((u) => u.id);
      if (result !== undefined) step.result = result;
      step.lease = undefined;
      step.error = undefined;
      step.reportedActuals = undefined;
      return true;
    });
  }
  create(
    input: WriteInput & {
      workflowId: string;
      steps: WorkflowStepDefinition[];
      expiresAt?: number;
    },
  ) {
    return this.d.write(input, "workflows.create", input, (tx, operation) => {
      return task({ self: this }, function* () {
        identifier(input.workflowId);
        assert(
          !(yield* tx.get("workflows", input.workflowId)),
          "workflow_exists",
        );
        const expiry = timestamp(input.expiresAt ?? this.d.now() + 15 * 60000);
        assert(
          expiry > this.d.now() && expiry <= this.d.now() + 30 * 86400000,
          "invalid_expiry",
        );
        const definitions = input.steps;
        assert(
          definitions.length > 0 &&
            definitions.length <= 32 &&
            definitions.reduce((n, s) => n + s.budgets.length, 0) <= 32,
          "workflow_too_large",
        );
        const ids = new Set(definitions.map((s) => identifier(s.id)));
        assert(ids.size === definitions.length, "duplicate_workflow_step");
        const visited = new Set<string>();
        while (visited.size < definitions.length) {
          const before = visited.size;
          for (const s of definitions)
            if (
              !visited.has(s.id) &&
              (s.dependsOn ?? []).every((id) => visited.has(id))
            )
              visited.add(s.id);
          assert(
            visited.size > before,
            "invalid_workflow_dependencies",
            "Dependencies must exist and form an acyclic graph.",
          );
        }
        yield* this.d.ledger.materialize(tx);
        const steps: WorkflowStep[] = [];
        let expiresAt = expiry;
        for (const definition of definitions) {
          const maxAttempts = definition.maxAttempts ?? 3;
          assert(
            Number.isSafeInteger(maxAttempts) &&
              maxAttempts >= 1 &&
              maxAttempts <= 100,
            "invalid_attempt_limit",
          );
          assert(
            definition.budgets.length <= 8 &&
              new Set(definition.budgets.map((b) => b.feature)).size ===
                definition.budgets.length,
            "invalid_workflow_budgets",
          );
          const step: WorkflowStep = {
            ...definition,
            maxAttempts,
            status: "pending",
            attempts: 0,
            availableAt: this.d.now(),
            reservations: [],
          };
          for (const budget of definition.budgets) {
            identifier(budget.feature);
            positive(budget.amount);
            const kind = (yield* tx.get<{
              kind: string;
            }>("counters", `feature-kind:${budget.feature}`))?.data.kind;
            assert(
              !kind || kind === "consumable",
              "workflow_consumable_required",
            );
            assert(
              !budget.poolScope ||
                ["customer", "entity"].includes(budget.poolScope),
              "invalid_pool_scope",
            );
            const r = yield* this.d.ledger.reserve(
              tx,
              { ...budget, entityId: input.entityId, expiresAt: expiry },
              operation,
            );
            expiresAt = Math.min(expiresAt, r.expiresAt);
            step.reservations.push({
              feature: budget.feature,
              reservationId: r.id,
            });
          }
          steps.push(step);
        }
        // Every step shares the earliest funding deadline, including otherwise later-expiring holds.
        for (const step of steps)
          for (const ref of step.reservations) {
            const r = (yield* tx.get<Reservation>(
              "reservations",
              ref.reservationId,
            ))!.data;
            yield* put(tx, "reservations", r.id, { ...r, expiresAt }, "held");
          }
        const workflow: Workflow = {
          id: input.workflowId,
          entityId: input.entityId,
          status: "active",
          revision: 0,
          createdAt: this.d.now(),
          expiresAt,
          steps,
        };
        yield* this.schedule(tx, workflow.id, expiresAt);
        return yield* this.save(
          tx,
          input.customerId,
          workflow,
          "workflow.created",
        );
      });
    });
  }
  get(
    input: ScopeInput & {
      workflowId: string;
    },
  ) {
    return this.d.read(input.customerId, (tx) => this.load(tx, input));
  }
  page(
    input: ScopeInput & {
      cursor?: string;
      limit?: number;
    },
  ) {
    return task({ self: this }, function* () {
      const limit = input.limit ?? 50;
      assert(
        Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
        "invalid_limit",
      );
      return yield* this.d.read(input.customerId, (tx) => {
        return task(function* () {
          const rows = yield* tx.page<Workflow>("workflows", {
            after: input.cursor,
            limit: limit + 1,
          });
          return {
            items: rows
              .slice(0, limit)
              .map((r) => r.data)
              .filter((w) => w.entityId === input.entityId),
            nextCursor: rows.length > limit ? rows[limit - 1]!.id : undefined,
          };
        });
      });
    });
  }

  claim(
    input: WriteInput & {
      workflowId: string;
      workerId: string;
      leaseMs?: number;
      stepId?: string;
    },
  ) {
    return this.d.write(input, "workflows.claim", input, (tx) => {
      return task({ self: this }, function* () {
        const workflow = yield* this.load(tx, input);
        identifier(input.workerId);
        assert(
          workflow.status === "active" && !workflow.cancellationRequested,
          "workflow_not_active",
        );
        if (
          workflow.steps.some(
            (s) => s.status === "running" && s.lease!.until <= this.d.now(),
          )
        ) {
          for (const s of workflow.steps)
            if (s.status === "running" && s.lease!.until <= this.d.now()) {
              s.status = "reconciliation";
              s.error = "workflow_worker_timeout";
            }
          yield* this.refresh(tx, workflow);
          yield* this.save(tx, input.customerId, workflow, "workflow.timeout");
          return { claimed: false as const };
        }
        assert(workflow.expiresAt > this.d.now(), "workflow_expired");
        const leaseMs = input.leaseMs ?? 60000;
        assert(
          Number.isSafeInteger(leaseMs) &&
            leaseMs >= 1000 &&
            leaseMs <= 15 * 60000,
          "invalid_lease",
        );
        if (workflow.steps.some((s) => s.status === "failed"))
          return { claimed: false as const };
        const step = workflow.steps.find(
          (s) =>
            (!input.stepId || s.id === input.stepId) &&
            s.status === "pending" &&
            s.availableAt <= this.d.now() &&
            (s.dependsOn ?? []).every(
              (id) => this.step(workflow, id).status === "succeeded",
            ),
        );
        if (!step) return { claimed: false as const };
        yield* this.d.ledger.materialize(tx);
        assert(yield* this.validHolds(tx, step), "workflow_funding_expired");
        step.attempts++;
        step.status = "running";
        step.lease = {
          token: crypto.randomUUID(),
          workerId: input.workerId,
          until: Math.min(this.d.now() + leaseMs, workflow.expiresAt),
        };
        yield* this.schedule(
          tx,
          workflow.id,
          step.lease.until,
          step.lease.token,
        );
        yield* this.save(tx, input.customerId, workflow, "workflow.claimed");
        return { claimed: true as const, workflowId: workflow.id, step };
      });
    });
  }
  increase(
    input: StepInput & {
      feature: string;
      amount: string;
      token?: string;
      reason: string;
    },
  ) {
    return this.d.write(input, "workflows.increase", input, (tx, operation) => {
      return task({ self: this }, function* () {
        assert(input.reason.trim(), "reason_required");
        const workflow = yield* this.load(tx, input),
          step = this.step(workflow, input.stepId);
        assert(
          workflow.status === "active" && !workflow.cancellationRequested,
          "workflow_not_active",
        );
        assert(
          step.status === "pending" || step.status === "running",
          "workflow_step_not_active",
        );
        if (step.status === "running") this.lease(step, input.token ?? "");
        yield* this.d.ledger.materialize(tx);
        const budget = step.budgets.find((b) => b.feature === input.feature);
        const ref = step.reservations.find((r) => r.feature === input.feature);
        assert(budget && ref, "workflow_budget_not_found");
        const row = yield* tx.get<Reservation>(
          "reservations",
          ref.reservationId,
        );
        assert(row?.state === "held", "reservation_not_held");
        const r = yield* this.d.ledger.increaseReservation(
          tx,
          row.data,
          input.amount,
          operation,
        );
        budget.amount = decimal(units(budget.amount) + positive(input.amount));
        if (r.expiresAt < workflow.expiresAt) {
          workflow.expiresAt = r.expiresAt;
          for (const s of workflow.steps) {
            if (s.lease)
              s.lease.until = Math.min(s.lease.until, workflow.expiresAt);
            for (const allocation of s.reservations) {
              const held = yield* tx.get<Reservation>(
                "reservations",
                allocation.reservationId,
              );
              if (held?.state === "held")
                yield* put(
                  tx,
                  "reservations",
                  held.id,
                  { ...held.data, expiresAt: workflow.expiresAt },
                  "held",
                );
            }
          }
          yield* this.schedule(tx, workflow.id, workflow.expiresAt);
        }
        yield* this.d.event(tx, input.customerId, "workflow.budget_increased", {
          workflowId: workflow.id,
          stepId: step.id,
          feature: input.feature,
          amount: input.amount,
          reason: input.reason,
        });
        return yield* this.save(
          tx,
          input.customerId,
          workflow,
          "workflow.updated",
        );
      });
    });
  }
  heartbeat(
    input: ClaimInput & {
      leaseMs?: number;
    },
  ) {
    return this.d.write(input, "workflows.heartbeat", input, (tx) => {
      return task({ self: this }, function* () {
        const workflow = yield* this.load(tx, input),
          step = this.step(workflow, input.stepId);
        this.lease(step, input.token);
        const ms = input.leaseMs ?? 60000;
        assert(
          Number.isSafeInteger(ms) && ms >= 1000 && ms <= 15 * 60000,
          "invalid_lease",
        );
        assert(workflow.expiresAt > this.d.now(), "workflow_expired");
        step.lease!.until = Math.min(this.d.now() + ms, workflow.expiresAt);
        yield* this.schedule(tx, workflow.id, step.lease!.until, input.token);
        return yield* this.save(
          tx,
          input.customerId,
          workflow,
          "workflow.heartbeat",
        );
      });
    });
  }
  private lease(step: WorkflowStep, token: string) {
    assert(
      step.status === "running" &&
        step.lease?.token === token &&
        step.lease.until > this.d.now(),
      "workflow_lease_lost",
    );
  }
  complete(
    input: ClaimInput & {
      actuals: Record<string, string>;
      result?: JsonValue;
    },
  ) {
    return this.d.write(input, "workflows.complete", input, (tx, operation) => {
      return task({ self: this }, function* () {
        const workflow = yield* this.load(tx, input),
          step = this.step(workflow, input.stepId);
        assert(
          step.lease?.token === input.token &&
            ["running", "reconciliation"].includes(step.status),
          "workflow_lease_lost",
        );
        this.validateActuals(step, input.actuals);
        yield* this.d.ledger.materialize(tx);
        if (
          step.status === "reconciliation" ||
          step.lease.until <= this.d.now()
        ) {
          step.status = "reconciliation";
          step.error ??= "workflow_lease_expired";
          step.reportedActuals = input.actuals;
          // Persist the actuals for review, without charging an expired hold.
          yield* this.d.event(
            tx,
            input.customerId,
            "workflow.late_completion",
            {
              workflowId: workflow.id,
              stepId: step.id,
              actuals: input.actuals,
            },
          );
        } else if (
          yield* this.settle(
            tx,
            input,
            step,
            input.actuals,
            operation,
            input.result,
          )
        )
          step.status = "succeeded";
        yield* this.refresh(tx, workflow);
        return yield* this.save(
          tx,
          input.customerId,
          workflow,
          "workflow.completed",
        );
      });
    });
  }
  fail(
    input: ClaimInput & {
      code: string;
      retrySafe: boolean;
      retryAfterMs?: number;
    },
  ) {
    return this.d.write(input, "workflows.fail", input, (tx) => {
      return task({ self: this }, function* () {
        const workflow = yield* this.load(tx, input),
          step = this.step(workflow, input.stepId);
        this.lease(step, input.token);
        identifier(input.code);
        const delay =
          input.retryAfterMs ?? Math.min(1000 * 2 ** step.attempts, 3600000);
        assert(
          Number.isSafeInteger(delay) && delay >= 0 && delay <= 86400000,
          "invalid_retry_delay",
        );
        step.error = input.code;
        step.lease = undefined;
        if (input.retrySafe && step.attempts < step.maxAttempts!) {
          step.status = "pending";
          step.availableAt = this.d.now() + delay;
        } else step.status = "reconciliation";
        yield* this.refresh(tx, workflow);
        return yield* this.save(
          tx,
          input.customerId,
          workflow,
          "workflow.failed",
        );
      });
    });
  }
  resolve(
    input: StepInput & {
      reason: string;
      outcome: "retry" | "succeeded" | "failed";
      fundUncovered?: boolean;
      actuals?: Record<string, string>;
      result?: JsonValue;
    },
  ) {
    return this.d.write(input, "workflows.resolve", input, (tx, operation) => {
      return task({ self: this }, function* () {
        assert(input.reason.trim().length > 0, "reason_required");
        const workflow = yield* this.load(tx, input),
          step = this.step(workflow, input.stepId);
        assert(
          step.status === "reconciliation",
          "workflow_not_in_reconciliation",
        );
        yield* this.d.ledger.materialize(tx);
        if (input.outcome === "retry") {
          assert(!workflow.cancellationRequested, "workflow_cancel_requested");
          assert(
            step.attempts < step.maxAttempts!,
            "workflow_attempts_exhausted",
          );
          assert(
            workflow.expiresAt > this.d.now() &&
              (yield* this.validHolds(tx, step)),
            "workflow_funding_expired",
          );
          step.status = "pending";
          step.availableAt = this.d.now();
          step.lease = undefined;
        } else {
          assert(input.actuals, "workflow_actuals_required");
          if (
            yield* this.settle(
              tx,
              input,
              step,
              input.actuals,
              operation,
              input.result,
              input.fundUncovered,
            )
          )
            step.status = input.outcome;
        }
        yield* this.refresh(tx, workflow);
        yield* this.d.event(tx, input.customerId, "workflow.resolution", {
          workflowId: workflow.id,
          stepId: step.id,
          reason: input.reason,
          outcome: input.outcome,
          status: step.status,
        });
        return yield* this.save(
          tx,
          input.customerId,
          workflow,
          "workflow.resolved",
        );
      });
    });
  }
  cancel(
    input: WriteInput & {
      workflowId: string;
      reason: string;
    },
  ) {
    return this.d.write(input, "workflows.cancel", input, (tx) => {
      return task({ self: this }, function* () {
        assert(input.reason.trim(), "reason_required");
        const workflow = yield* this.load(tx, input);
        assert(
          ["active", "reconciliation"].includes(workflow.status),
          "workflow_terminal",
        );
        workflow.cancellationRequested = true;
        for (const step of workflow.steps) {
          if (step.status === "pending") {
            yield* this.release(tx, step);
            step.status = "cancelled";
          } else if (step.status === "running") {
            step.status = "reconciliation";
            step.error = "workflow_cancelled_inflight";
          }
        }
        workflow.status = workflow.steps.some(
          (s) => s.status === "reconciliation",
        )
          ? "reconciliation"
          : "cancelled";
        yield* this.d.event(tx, input.customerId, "workflow.cancellation", {
          workflowId: workflow.id,
          reason: input.reason,
        });
        return yield* this.save(
          tx,
          input.customerId,
          workflow,
          "workflow.cancelled",
        );
      });
    });
  }
  /** Internal scheduler hook; never invokes application or payment-provider code. */
  timeout(
    tx: Transaction,
    customerId: string,
    workflowId: string,
    token?: string,
  ) {
    return task({ self: this }, function* () {
      const row = yield* tx.get<Workflow>("workflows", workflowId);
      if (!row || !["active", "reconciliation"].includes(row.state)) return;
      const workflow = row.data;
      let changed = false;
      for (const step of workflow.steps) {
        if (
          step.status === "running" &&
          step.lease &&
          step.lease.until <= this.d.now() &&
          (!token || step.lease.token === token)
        ) {
          step.status = "reconciliation";
          step.error = "workflow_worker_timeout";
          changed = true;
        }
        if (workflow.expiresAt <= this.d.now() && step.status === "pending") {
          workflow.cancellationRequested = true;
          yield* this.release(tx, step);
          step.status = "cancelled";
          changed = true;
        }
      }
      if (changed) {
        yield* this.refresh(tx, workflow);
        if (workflow.expiresAt <= this.d.now() && workflow.status === "active")
          workflow.status = "cancelled";
        yield* this.save(tx, customerId, workflow, "workflow.timeout");
      }
    });
  }
}
