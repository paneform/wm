import { Deferred, Effect, Ref } from "effect";
import type { Clock } from "./platform.ts";
import {
  BATCH_COMMAND_CAP,
  SUSPICIOUS_REPEAT_THRESHOLD,
  TRANSACTION_HISTORY_LIMIT,
  TRANSACTION_PENDING_LIMIT,
  TRANSACTION_TIMEOUT_MS,
} from "./constants.ts";

// Serialized FIFO transaction queue — docs/rewrite/engine-guide.md
// §Command execution layer. Idempotent coalescing shares one execution +
// receipt; suspicious repeats escalate; recovery mode queues submissions;
// timeouts cancel via the injected Clock; failures roll back applied steps
// in reverse order (best-effort).

export interface TransactionStep {
  name: string;
  run: () => Effect.Effect<unknown, StepFailure>;
  /** Best-effort inverse executed in reverse order after a later-step failure. */
  compensate?: (() => Effect.Effect<void>) | undefined;
}

/** User-safe failure description; internal detail rides separately. */
export interface StepFailure {
  code: string;
  message: string;
  diagnostic?: string | undefined;
}

export interface WorkUnit {
  id: string;
  coalesceKey?: string | undefined;
  steps: readonly TransactionStep[];
  /**
   * Escalation hook invoked before execution when this coalesce key repeats
   * ≥ SUSPICIOUS_REPEAT_THRESHOLD times (full reconciliation).
   */
  escalate?: (() => Effect.Effect<void>) | undefined;
}

export interface Receipt {
  id: string;
  status: "completed" | "failed" | "timeout";
  appliedSteps: readonly string[];
  error?: { code: string; message: string } | undefined;
  startedAt: number;
  finishedAt: number;
}

export type SubmitError =
  | { code: "queue_full" }
  | { code: "invalid_request"; detail: string };

export interface PendingTransactionInfo {
  id: string;
  coalesceKey: string | null;
  submittedAt: number;
}

export interface TransactionQueue {
  submit(unit: WorkUnit): Effect.Effect<Receipt, SubmitError>;
  /** Composite transaction: ≤ BATCH_COMMAND_CAP commands, stop on first failure. */
  submitBatch(units: readonly WorkUnit[]): Effect.Effect<Receipt, SubmitError>;
  setRecovery(active: boolean): void;
  isRecovering(): boolean;
  pending(): readonly PendingTransactionInfo[];
  history(): readonly Receipt[];
}

interface PendingEntry {
  unit: WorkUnit;
  deferred: Deferred.Deferred<Receipt, SubmitError>;
  submittedAt: number;
}

const INTERNAL_FAILURE: StepFailure = {
  code: "internal_error",
  message: "the operation failed unexpectedly",
};

export const createTransactionQueue = (deps: {
  clock: Clock;
  onDiagnostic?: ((detail: string) => void) | undefined;
}): TransactionQueue => {
  let pendingEntries: PendingEntry[] = [];
  let historyRing: Receipt[] = [];
  let recovering = false;
  let processing = false;
  const keyCounts = new Map<string, number>();

  const pumping = Ref.unsafeMake(false);

  const recordHistory = (receipt: Receipt): void => {
    historyRing.push(receipt);
    if (historyRing.length > TRANSACTION_HISTORY_LIMIT) {
      historyRing = historyRing.slice(historyRing.length - TRANSACTION_HISTORY_LIMIT);
    }
  };

  const runSteps = (
    unitId: string,
    steps: readonly TransactionStep[],
    start: number,
  ): Effect.Effect<Receipt> =>
    Effect.gen(function* () {
      const applied: string[] = [];
      const compensations: Array<() => Effect.Effect<void>> = [];

      for (const step of steps) {
        const result = yield* Effect.either(step.run());
        if (result._tag === "Left") {
          const failure = result.left ?? INTERNAL_FAILURE;
          const safe =
            failure.code === "internal_error"
              ? { code: INTERNAL_FAILURE.code, message: INTERNAL_FAILURE.message }
              : { code: failure.code, message: failure.message };
          const diagnostic =
            failure.diagnostic ??
            (failure.code === "internal_error" ? `${unitId}: unexpected step failure` : undefined);
          if (diagnostic !== undefined) deps.onDiagnostic?.(diagnostic);

          // Reverse-order best-effort rollback of already-applied steps.
          for (const compensate of [...compensations].reverse()) {
            yield* compensate().pipe(Effect.ignore);
          }
          return {
            id: unitId,
            status: "failed",
            appliedSteps: applied,
            error: safe,
            startedAt: start,
            finishedAt: deps.clock.now(),
          } satisfies Receipt;
        }
        applied.push(step.name);
        if (step.compensate !== undefined) compensations.push(step.compensate);
      }

      return {
        id: unitId,
        status: "completed",
        appliedSteps: applied,
        startedAt: start,
        finishedAt: deps.clock.now(),
      } satisfies Receipt;
    });

  const processEntry = (entry: PendingEntry): Effect.Effect<void> =>
    Effect.gen(function* () {
      const start = deps.clock.now();

      // Suspicious-repeat escalation ≥3 ⇒ hook before execute.
      if (entry.unit.coalesceKey !== undefined && entry.unit.escalate !== undefined) {
        const count = keyCounts.get(entry.unit.coalesceKey) ?? 0;
        if (count >= SUSPICIOUS_REPEAT_THRESHOLD) {
          keyCounts.set(entry.unit.coalesceKey, 0);
          yield* entry.unit.escalate();
        }
      }

      // Both race sides use the SUCCESS channel: a failing winner in
      // Effect.race can strand an uninterruptible loser fiber.
      const timeoutSignal: { kind: "timeout" } = { kind: "timeout" };
      const outcome = yield* Effect.either(
        Effect.race(
          runSteps(entry.unit.id, entry.unit.steps, start).pipe(
            Effect.map(
              (receipt): { kind: "receipt"; receipt: Receipt } => ({
                kind: "receipt",
                receipt,
              }),
            ),
          ),
          Effect.flatMap(deps.clock.sleep(TRANSACTION_TIMEOUT_MS), () =>
            Effect.succeed(timeoutSignal),
          ),
        ),
      );

      const receipt: Receipt =
        outcome._tag === "Left" || outcome.right.kind === "timeout"
          ? {
              id: entry.unit.id,
              status: "timeout",
              appliedSteps: [],
              error: { code: "timeout", message: "operation exceeded its time budget" },
              startedAt: start,
              finishedAt: deps.clock.now(),
            }
          : outcome.right.receipt;

      recordHistory(receipt);
      yield* Deferred.succeed(entry.deferred, receipt);
    });

  const drain = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const busy = yield* Ref.getAndSet(pumping, true);
      if (busy) return;
      try {
        while (pendingEntries.length > 0 && !recovering) {
          const entry = pendingEntries[0]!;
          pendingEntries = pendingEntries.slice(1);
          processing = true;
          try {
            yield* processEntry(entry);
          } finally {
            processing = false;
          }
        }
      } finally {
        yield* Ref.set(pumping, false);
      }
    });

  const enqueue = (
    unit: WorkUnit,
  ): Effect.Effect<Deferred.Deferred<Receipt, SubmitError>, SubmitError> =>
    Effect.gen(function* () {
      // The in-flight unit occupies a slot too.
      const occupied = pendingEntries.length + (processing ? 1 : 0);
      if (occupied >= TRANSACTION_PENDING_LIMIT) {
        return yield* Effect.fail<SubmitError>({ code: "queue_full" });
      }
      if (unit.coalesceKey !== undefined) {
        keyCounts.set(unit.coalesceKey, (keyCounts.get(unit.coalesceKey) ?? 0) + 1);
      }
      const deferred = yield* Deferred.make<Receipt, SubmitError>();
      pendingEntries = [
        ...pendingEntries,
        { unit, deferred, submittedAt: deps.clock.now() },
      ];
      yield* drain();
      return deferred;
    });

  const submit = (unit: WorkUnit): Effect.Effect<Receipt, SubmitError> =>
    Effect.gen(function* () {
      // Idempotent-command coalescing: equivalent pending commands share one
      // execution and receipt.
      if (unit.coalesceKey !== undefined) {
        const existing = pendingEntries.find(
          (entry) => entry.unit.coalesceKey === unit.coalesceKey,
        );
        if (existing !== undefined) return yield* Deferred.await(existing.deferred);
      }
      const deferred = yield* enqueue(unit);
      return yield* Deferred.await(deferred);
    });

  const submitBatch = (units: readonly WorkUnit[]): Effect.Effect<Receipt, SubmitError> =>
    Effect.gen(function* () {
      if (units.length > BATCH_COMMAND_CAP) {
        return yield* Effect.fail({
          code: "invalid_request",
          detail: `batch exceeds ${BATCH_COMMAND_CAP} commands`,
        } satisfies SubmitError);
      }
      if (units.length === 0) {
        const now = deps.clock.now();
        return {
          id: "batch:empty",
          status: "completed",
          appliedSteps: [],
          startedAt: now,
          finishedAt: now,
        } satisfies Receipt;
      }
      const steps = units.flatMap((unit) =>
        unit.steps.map((step) => ({ ...step, name: `${unit.id}/${step.name}` })),
      );
      const deferred = yield* enqueue({ id: `batch:${units[0]!.id}`, steps });
      return yield* Deferred.await(deferred);
    });

  return {
    submit,
    submitBatch,
    setRecovery(active: boolean): void {
      recovering = active;
      if (!active) void Effect.runPromise(drain()).catch(() => {});
    },
    isRecovering: () => recovering,
    pending(): readonly PendingTransactionInfo[] {
      return pendingEntries.map((entry) => ({
        id: entry.unit.id,
        coalesceKey: entry.unit.coalesceKey ?? null,
        submittedAt: entry.submittedAt,
      }));
    },
    history: () => historyRing,
  };
};
