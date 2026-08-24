import { Effect, Stream } from "effect";
import type {
  DisplayId,
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
   */
  setWindowFrame(id: WindowId, frame: Frame): Effect.Effect<WriteObservation, PlatformError>;
  setWindowPosition(id: WindowId, point: Point): Effect.Effect<WriteObservation, PlatformError>;
  setWindowSize(id: WindowId, size: Size): Effect.Effect<WriteObservation, PlatformError>;
  focusWindow(id: WindowId): Effect.Effect<void, PlatformError>;
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
}
