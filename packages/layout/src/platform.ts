import { Effect, Stream } from "effect";
import type { WindowInspection } from "./window-inspection.js";
import type { Config, ConfigInvalidError } from "./config.js";
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
  WindowInventory,
  WriteObservation,
} from "./schema.js";

/**
 * The ONLY boundary between engine and a host system. Implemented by:
 *  - the macOS sidecar host (packages/platform-macos)
 *  - the headless test fake (test/helpers/fake-platform.ts)
 *  - the web renderer simulation (packages/layout-browser)
 *
 * Adapters are dumb: no policy, no clamping, no retry, no classification.
 * Every write returns the OBSERVED outcome; the engine decides what it means.
 */
export interface PlatformAdapter {
  /** Events request reconciliation; closed removals carry positive lifecycle evidence. */
  readonly events: Stream.Stream<PlatformEvent>;

  /**
   * Tell a native host whether matched hotkeys should be suppressed. Adapters
   * without native hotkey capture may omit this control.
   */
  readonly setHotkeySwallowing?: (enabled: boolean) => Effect.Effect<void, PlatformError>;

  getTopology(): Effect.Effect<TopologyObservation, PlatformError>;
  getWindows(): Effect.Effect<ReadonlyArray<WindowObservation>, PlatformError>;
  /** Current facts only. Missing/unavailable entries do not prove closure.
   * Fail with unavailable when the entire observation cannot be made. */
  readonly getWindowInventory?: () => Effect.Effect<WindowInventory, PlatformError>;
  getWindow(id: WindowId): Effect.Effect<WindowObservation | null, PlatformError>;
  /** Fresh read-only facts and query errors in the granted native host context. */
  readonly inspectWindow?: (id: WindowId) => Effect.Effect<WindowInspection, PlatformError>;
  /** Inspect an application's raw windows even when none are in managed inventory. */
  readonly inspectApplication?: (pid: number) => Effect.Effect<WindowInspection, PlatformError>;

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
   * subrole ?? null, ...optionalInstanceId])` at write time — same-pid replacements differing in
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
  focusWindow(
    id: WindowId,
    expected?: ExpectedWindowIdentity,
  ): Effect.Effect<PlatformFocusResult, PlatformError>;

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
  readonly frontmostPid?: number | undefined;
  readonly focused?: boolean | undefined;
  readonly main?: boolean | undefined;
  readonly error?: PlatformOperationError | undefined;
}

export interface PlatformOperationError {
  readonly code: PlatformError["code"];
  readonly detail?: string | undefined;
}

export interface PlatformFocusResult {
  readonly frontmostPid?: number | undefined;
  readonly focused?: boolean | undefined;
  readonly main?: boolean | undefined;
  readonly error?: PlatformOperationError | undefined;
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
