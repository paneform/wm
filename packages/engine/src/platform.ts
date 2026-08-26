import { Effect, Stream } from "effect";
import type { Config, ConfigInvalidError } from "./config.ts";
import type {
  DisplayId,
  ExpectedWindowIdentity,
  Frame,
  PlatformError,
  PlatformEvent,
  Point,
  Size,
  TopologyObservation,
  WindowId,
  WindowObservation,
  WriteObservation,
} from "./schema.ts";

/**
 * The ONLY boundary between engine and a host system. Implemented by:
 *  - the macOS sidecar host (packages/platform-macos)
 *  - the headless test fake (test/helpers/fake-platform.ts)
 *  - the web renderer simulation (packages/renderer)
 *
 * Adapters are dumb: no policy, no clamping, no retry, no classification.
 * Every write returns the OBSERVED outcome; the engine decides what it means.
 */
export interface PlatformAdapter {
  /** Stream of generic events. Hints only — the engine re-queries to reconcile. */
  readonly events: Stream.Stream<PlatformEvent>;

  getTopology(): Effect.Effect<TopologyObservation, PlatformError>;
  getWindows(): Effect.Effect<ReadonlyArray<WindowObservation>, PlatformError>;
  getWindow(id: WindowId): Effect.Effect<WindowObservation | null, PlatformError>;

  /**
   * Write position+size as separate component writes in an adapter-chosen order
   * (macOS uses size→position→size bookends), settle-poll readback, report.
   * Never throws for "window refused the exact frame" — report observed instead.
   *
   * IDENTITY GUARD (contract §4): every write primitive — including this one —
   * MUST re-validate the window identity behind the stable `id` immediately
   * before and after the underlying native operation and abort with
   * `PlatformError { code: "stale" }` when a replacement is detected, leaving
   * the replacement untouched. Callers therefore never need to retry writes
   * unguarded: a returned `stale` always means "nothing was mutated".
   *
   * When `expected` is provided its `fingerprint` is compared EXACTLY against
   * the live metadata fingerprint `JSON.stringify([pid, role ?? null,
   * subrole ?? null])` at write time — same-pid replacements differing in
   * subrole (null or otherwise) are rejected.
   */
  setWindowFrame(
    id: WindowId,
    frame: Frame,
    expected?: ExpectedWindowIdentity,
  ): Effect.Effect<WriteObservation, PlatformError>;
  setWindowPosition(
    id: WindowId,
    point: Point,
    expected?: ExpectedWindowIdentity,
  ): Effect.Effect<WriteObservation, PlatformError>;
  setWindowSize(
    id: WindowId,
    size: Size,
    expected?: ExpectedWindowIdentity,
  ): Effect.Effect<WriteObservation, PlatformError>;
  focusWindow(id: WindowId): Effect.Effect<void, PlatformError>;

  /**
   * One host/native round trip for related mutations. This is not an atomic
   * transaction: every operation reports its own outcome and callers own
   * compensation. Dependencies order related operations; unrelated windows
   * may execute concurrently.
   */
  readonly executeBatch?: (
    request: PlatformBatchRequest,
  ) => Effect.Effect<PlatformBatchResult, PlatformError>;
}

export type PlatformBatchOperation =
  | {
      readonly operationId: string;
      readonly kind: "setFrame";
      readonly windowId: WindowId;
      readonly frame: Frame;
      readonly expectedIdentity: ExpectedWindowIdentity;
      readonly dependsOn?: readonly string[];
    }
  | {
      readonly operationId: string;
      readonly kind: "focus";
      readonly windowId: WindowId;
      readonly expectedIdentity: ExpectedWindowIdentity;
      readonly dependsOn?: readonly string[];
    };

export interface PlatformBatchRequest {
  readonly operations: readonly PlatformBatchOperation[];
}

export interface PlatformBatchOperationResult {
  readonly operationId: string;
  readonly requested?: Frame | undefined;
  readonly observed?: Frame | undefined;
  readonly stable?: boolean | undefined;
  /** Consecutive stable native settle reads supporting this observation. */
  readonly stableReads?: number | undefined;
  readonly error?: {
    readonly code: PlatformError["code"];
    readonly detail?: string | undefined;
  } | undefined;
}

export interface PlatformBatchResult {
  /** Results are in deterministic request order. */
  readonly operations: readonly PlatformBatchOperationResult[];
  readonly completed: number;
  readonly failed: number;
}

/** Injected clock — tests use virtual time; production uses real time. */
export interface Clock {
  now(): number;
  sleep(millis: number): Effect.Effect<void>;
}

/** Seeded randomness for deterministic probing/scenarios. */
export interface Random {
  nextInt(maxExclusive: number): number;
}

/** Runtime config source; file watching lives in the node host implementation. */
export interface ConfigSource {
  load(): Effect.Effect<unknown>; // raw JSONC text → parsed candidate
  changes(): Stream.Stream<void>;
  prepare?(config: Config, mode: "delta" | "full"): Effect.Effect<void, ConfigInvalidError>;
}
