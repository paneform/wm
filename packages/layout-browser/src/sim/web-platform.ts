import { Effect, Stream } from "effect";
import {
  PlatformError,
  type DisplayId,
  type DisplayObservation,
  type ExpectedWindowIdentity,
  type Frame,
  type PlatformAdapter,
  type PlatformEvent,
  type Point,
  type Size,
  type TopologyObservation,
  type WindowId,
  type WindowObservation,
  type WriteObservation,
  windowIdentityFingerprint,
} from "@paneform/layout";

// In-memory simulated PlatformAdapter — docs/rewrite/platform-contract.md.
// DOM-free logical displays/windows in canonical space (top-left primary
// origin, y-down). Personalities mirror the documented macOS behaviors from
// docs/rewrite/testing-guide.md §Fake platform: min/max clamps, work-area
// clamping, offscreen sliver refusal (~1 pt horizontal / ~52 pt vertical),
// fixed-size, unmovable, animated settling, reanchoring, identity replacement,
// topology churn. Fully deterministic: seeded RNG, read-driven animation,
// no wall clock anywhere.

// ---------------------------------------------------------------------------
// Personality model
// ---------------------------------------------------------------------------

export type PersonalityKind =
  | "normal"
  | "minMaxClamp"
  | "workAreaClamp"
  | "reanchoring"
  | "animated"
  | "slowAnimated"
  | "fixedSize"
  | "unmovable";

export interface SimConstraints {
  minWidth?: number | undefined;
  maxWidth?: number | undefined;
  minHeight?: number | undefined;
  maxHeight?: number | undefined;
}

export interface SimPersonality {
  kind: PersonalityKind;
  constraints?: SimConstraints | undefined;
  /**
   * Reanchoring apps keep their CENTER fixed when resized (origin shifts), so
   * a size-only write ends with the position wrong — validates the
   * convergedSizePositionSize ladder rung.
   */
  anchor?: ("topleft" | "center") | undefined;
  /** Fraction of remaining distance covered per settle read. */
  animationFraction?: number | undefined;
}

const ANIMATION_FRACTIONS: Record<string, number> = {
  animated: 0.35,
  slowAnimated: 0.06,
};

const ANIMATED_KINDS: readonly string[] = ["animated", "slowAnimated"];

export const isAnimated = (personality: SimPersonality): boolean =>
  ANIMATED_KINDS.includes(personality.kind);

// ---------------------------------------------------------------------------
// Specs (pure data used by bootstrap + scenarios)
// ---------------------------------------------------------------------------

export interface DisplaySpec {
  id: DisplayId;
  frame: Frame;
  workArea: Frame;
  scale: number;
  primary: boolean;
  /** Offscreen parking sliver visibility in points. */
  visibility?: { horizontal: number; vertical: number } | undefined;
}

export interface AddWindowSpec {
  ref?: string | undefined;
  title?: string | undefined;
  bundleId?: string | undefined;
  pid?: number | undefined;
  role?: string | undefined;
  subrole?: string | undefined;
  displayId?: DisplayId | undefined;
  x?: number | undefined;
  y?: number | undefined;
  width: number;
  height: number;
  personality?: SimPersonality | undefined;
  minimized?: boolean | undefined;
}

export interface WebPlatformSimOptions {
  seed?: number | undefined;
  displays?: readonly DisplaySpec[] | undefined;
}

export interface GroundTruthWindow {
  id: WindowId;
  title: string;
  personality: SimPersonality;
  initialFrame: Frame;
}

export interface SimGroundTruth {
  seed: number;
  windows: readonly GroundTruthWindow[];
  displays: readonly DisplayObservation[];
  focusedWindowId: WindowId | null;
}

export interface WebPlatformSim {
  readonly adapter: PlatformAdapter;
  readonly seed: number;

  // World mutation ops — scenario / control-panel entry points.
  addWindow(spec: AddWindowSpec): WindowId;
  removeWindow(id: WindowId): void;
  focusWindowExternal(id: WindowId | null): void;
  driftWindow(id: WindowId, dx: number, dy: number): void;
  nudgeWindow(id: WindowId, frame: Partial<Frame>): void;
  scheduleIdentityReplacement(id: WindowId): void;
  connectDisplay(spec: DisplaySpec): void;
  disconnectDisplay(displayId: DisplayId): void;
  updateWorkArea(displayId: DisplayId, workArea: Frame): void;
  setVisibilityLimits(displayId: DisplayId, limits: { horizontal: number; vertical: number }): void;

  // Introspection.
  displays(): readonly DisplayObservation[];
  windowIds(): readonly WindowId[];
  focusedWindowId(): WindowId | null;
  groundTruth(): SimGroundTruth;
}

// ---------------------------------------------------------------------------
// Internal state shapes
// ---------------------------------------------------------------------------

interface SimDisplay {
  spec: DisplaySpec;
}

interface SimWindow {
  id: WindowId;
  pid: number;
  bundleId?: string | undefined;
  executablePath?: string | undefined;
  title: string;
  role: string;
  subrole?: string | undefined;
  personality: SimPersonality;
  frame: Frame;
  target: Frame | null;
  minimized: boolean;
  hidden: boolean;
  fullscreen: boolean;
  generation: number;
  replacementPending: boolean;
  initialFrame: Frame;
}

const DEFAULT_VISIBILITY = { horizontal: 1, vertical: 52 } as const;

/** Adapter-side settle budget (sidecar emulation: ≤36 samples). */
const ADAPTER_SETTLE_SAMPLES = 36;
const STABLE_READS_TO_STOP = 3;

// ---------------------------------------------------------------------------
// Pure geometry helpers (unit-tested DOM-free)
// ---------------------------------------------------------------------------

/**
 * One animation step toward target; snaps when within one point so integer
 * rounding can never stall. Deterministic and read-driven.
 */
export function stepTowardFrame(current: Frame, target: Frame, fraction: number): Frame {
  const axis = (c: number, t: number): number => {
    const d = t - c;
    if (Math.abs(d) <= 1) return t;
    const raw = d * fraction;
    const stepped = Math.abs(raw) < 1 ? Math.sign(d) : Math.round(raw);
    return c + stepped;
  };
  return {
    x: axis(current.x, target.x),
    y: axis(current.y, target.y),
    width: axis(current.width, target.width),
    height: axis(current.height, target.height),
  };
}

const clampValue = (v: number, min: number | undefined, max: number | undefined): number => {
  let out = v;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
};

/** Personality size response: clamps into known min/max bounds. */
export function clampSizeToConstraints(size: Size, constraints: SimConstraints | undefined): Size {
  if (constraints === undefined) return { ...size };
  return {
    width: clampValue(size.width, constraints.minWidth, constraints.maxWidth),
    height: clampValue(size.height, constraints.minHeight, constraints.maxHeight),
  };
}

const intersectsArea = (a: Frame, b: Frame): boolean =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0;

/**
 * Offscreen sliver target at the nearest display corner — emulates macOS
 * refusing fully-offscreen windows (~1 pt horizontal, ~52 pt vertical left
 * visible at the corner).
 */
export function offscreenSliverTarget(
  requested: Frame,
  displays: readonly DisplayObservation[],
  visibilityFor: (display: DisplayObservation) => { horizontal: number; vertical: number },
): { frame: Frame; displayId: DisplayId } {
  const centerX = requested.x + requested.width / 2;
  const centerY = requested.y + requested.height / 2;
  let host = displays[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const dx =
      centerX < display.frame.x
        ? display.frame.x - centerX
        : centerX > display.frame.x + display.frame.width
          ? centerX - (display.frame.x + display.frame.width)
          : 0;
    const dy =
      centerY < display.frame.y
        ? display.frame.y - centerY
        : centerY > display.frame.y + display.frame.height
          ? centerY - (display.frame.y + display.frame.height)
          : 0;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      host = display;
    }
  }
  if (host === undefined) return { frame: { ...requested }, displayId: "" };
  const limits = visibilityFor(host);
  const toLeft = centerX < host.frame.x + host.frame.width / 2;
  const toTop = centerY < host.frame.y + host.frame.height / 2;
  const x = toLeft
    ? host.frame.x - requested.width + limits.horizontal
    : host.frame.x + host.frame.width - limits.horizontal;
  const y = toTop
    ? host.frame.y - requested.height + limits.vertical
    : host.frame.y + host.frame.height - limits.vertical;
  return { frame: { x, y, width: requested.width, height: requested.height }, displayId: host.id };
}

/** Work-area pull-back: the OS keeps some apps' frames inside the usable area. */
export function clampFrameIntoWorkArea(frame: Frame, workAreas: readonly Frame[]): Frame {
  if (workAreas.length === 0) return frame;
  const fullyInside = workAreas.some(
    (wa) =>
      frame.x >= wa.x &&
      frame.y >= wa.y &&
      frame.x + frame.width <= wa.x + wa.width &&
      frame.y + frame.height <= wa.y + wa.height,
  );
  if (fullyInside) return frame;
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const host =
    workAreas.find(
      (wa) => cx >= wa.x && cx < wa.x + wa.width && cy >= wa.y && cy < wa.y + wa.height,
    ) ?? workAreas[0];
  if (host === undefined) return frame;
  const maxX = Math.max(host.x, host.x + host.width - frame.width);
  const maxY = Math.max(host.y, host.y + host.height - frame.height);
  return {
    x: Math.min(Math.max(frame.x, host.x), maxX),
    y: Math.min(Math.max(frame.y, host.y), maxY),
    width: frame.width,
    height: frame.height,
  };
}

/** Seeded RNG (mulberry32) — same seed ⇒ identical outcomes. */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const platformError = (code: PlatformError["code"], detail: string): PlatformError =>
  new PlatformError({ code, detail });

const failWith = (
  code: PlatformError["code"],
  detail: string,
): Effect.Effect<never, PlatformError> => Effect.fail(platformError(code, detail));

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebPlatformSim(options: WebPlatformSimOptions = {}): WebPlatformSim {
  const seed = options.seed ?? 1337;
  const rng = createSeededRng(seed);

  const defaultDisplays: DisplaySpec[] = [
    {
      id: "display:sim-primary",
      frame: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 38, width: 1512, height: 944 },
      scale: 2,
      primary: true,
    },
    {
      // Sits LEFT of the primary: negative-origin canonical coordinates.
      id: "display:sim-secondary",
      frame: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 38, width: 1920, height: 1042 },
      scale: 1,
      primary: false,
    },
  ];

  let displays: SimDisplay[] = (options.displays ?? defaultDisplays).map((spec) => ({
    spec: { ...spec, visibility: { ...(spec.visibility ?? DEFAULT_VISIBILITY) } },
  }));
  const windows = new Map<WindowId, SimWindow>();
  let nextWindowNumber = 1;
  let nextPid = 4200 + Math.floor(rng() * 100);
  let focusedId: WindowId | null = null;

  // --- event plumbing (same push pattern as the engine's own event bus) ---
  const listeners = new Set<(event: PlatformEvent) => void>();
  const dispatch = (event: PlatformEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const eventsStream: Stream.Stream<PlatformEvent> = Stream.asyncPush<PlatformEvent>((emit) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (event: PlatformEvent): void => {
          emit.single(event);
        };
        listeners.add(listener);
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          listeners.delete(listener);
        }),
    ),
  );

  // --- observation projection ---

  const sortedDisplays = (): DisplayObservation[] =>
    [...displays]
      .map((d) => d.spec)
      .sort((a, b) => {
        if (a.primary !== b.primary) return a.primary ? -1 : 1;
        if (a.frame.x !== b.frame.x) return a.frame.x - b.frame.x;
        if (a.frame.y !== b.frame.y) return a.frame.y - b.frame.y;
        return a.id.localeCompare(b.id);
      })
      .map((s) => ({
        id: s.id,
        frame: { ...s.frame },
        workArea: { ...s.workArea },
        scale: s.scale,
        primary: s.primary,
      }));

  const capabilitiesOf = (w: SimWindow): WindowObservation["capabilities"] => {
    switch (w.personality.kind) {
      case "fixedSize":
        return {
          movable: "supported",
          resizable: "fixed",
          movableEvidence: "platform_report",
          resizableEvidence: "platform_report",
        };
      case "unmovable":
        return {
          movable: "fixed",
          resizable: "fixed",
          movableEvidence: "platform_report",
          resizableEvidence: "platform_report",
        };
      default:
        return {
          movable: "unknown",
          resizable: "unknown",
          movableEvidence: "platform_report",
          resizableEvidence: "platform_report",
        };
    }
  };

  const observationOf = (w: SimWindow): WindowObservation => ({
    id: w.id,
    pid: w.pid,
    ...(w.bundleId !== undefined ? { bundleId: w.bundleId } : {}),
    ...(w.executablePath !== undefined ? { executablePath: w.executablePath } : {}),
    title: w.title,
    role: w.role,
    ...(w.subrole !== undefined ? { subrole: w.subrole } : {}),
    frame: { ...w.frame },
    minimized: w.minimized,
    hidden: w.hidden,
    fullscreen: w.fullscreen,
    focused: w.id === focusedId,
    capabilities: capabilitiesOf(w),
  });

  const resolveWindow = (id: WindowId): SimWindow | undefined => windows.get(id);

  // --- animation (read-driven; deterministic, zero timers) ---

  const animationFractionOf = (w: SimWindow): number =>
    w.personality.animationFraction ?? ANIMATION_FRACTIONS[w.personality.kind] ?? 1;

  const advanceAnimation = (w: SimWindow): void => {
    if (w.target === null) return;
    w.frame = stepTowardFrame(w.frame, w.target, animationFractionOf(w));
    if (
      w.target !== null &&
      w.frame.x === w.target.x &&
      w.frame.y === w.target.y &&
      w.frame.width === w.target.width &&
      w.frame.height === w.target.height
    ) {
      w.target = null;
    }
  };

  /**
   * Settle loop after component writes: advance the animation once per
   * virtual read, stop early on three identical reads or budget exhaustion.
   * Returns whether the window reached its final frame.
   */
  const settleWindow = (w: SimWindow): boolean => {
    let previous = JSON.stringify(w.frame);
    let stableReads = 0;
    for (let read = 0; read < ADAPTER_SETTLE_SAMPLES; read++) {
      advanceAnimation(w);
      const current = JSON.stringify(w.frame);
      if (current === previous) {
        stableReads += 1;
        if (stableReads >= STABLE_READS_TO_STOP) break;
      } else {
        stableReads = 0;
      }
      previous = current;
    }
    return w.target === null;
  };

  // --- write pipeline ---

  /**
   * Identity discipline (contract §4): consume any scheduled replacement
   * BEFORE applying the write; if identity changed mid-operation abort with
   * `stale` rather than mutating the replacement.
   */
  const beginWrite = (w: SimWindow): boolean => {
    const before = w.generation;
    if (w.replacementPending) {
      w.replacementPending = false;
      w.generation += 1;
      w.pid = nextPid;
      nextPid += 1;
    }
    return w.generation === before;
  };

  const workAreasAll = (): Frame[] => displays.map((d) => d.spec.workArea);

  const applyOffscreenRefusal = (frame: Frame): Frame => {
    const observations = sortedDisplays();
    const touchesAny = observations.some((d) => intersectsArea(frame, d.frame));
    if (touchesAny || observations.length === 0) return frame;
    return offscreenSliverTarget(frame, observations, (display) => {
      const match = displays.find((d) => d.spec.id === display.id);
      return match?.spec.visibility ?? { ...DEFAULT_VISIBILITY };
    }).frame;
  };

  const applyPositionWrite = (w: SimWindow, point: Point): Frame => {
    if (w.personality.kind === "unmovable") return { ...w.frame };
    let next: Frame = { ...w.frame, x: point.x, y: point.y };
    if (w.personality.kind === "workAreaClamp") {
      next = clampFrameIntoWorkArea(next, workAreasAll());
    }
    return applyOffscreenRefusal(next);
  };

  const applySizeWrite = (w: SimWindow, size: Size): Frame => {
    if (w.personality.kind === "unmovable") return { ...w.frame };
    if (w.personality.kind === "fixedSize") return { ...w.frame };
    const constrained = clampSizeToConstraints(size, w.personality.constraints);
    if (w.personality.anchor === "center") {
      // Reanchoring app: origin shifts so the visual center stays put.
      return {
        x: Math.round(w.frame.x + (w.frame.width - constrained.width) / 2),
        y: Math.round(w.frame.y + (w.frame.height - constrained.height) / 2),
        width: constrained.width,
        height: constrained.height,
      };
    }
    return { ...w.frame, width: constrained.width, height: constrained.height };
  };

  interface WritePart {
    readonly component: "position" | "size";
    readonly requested: Frame;
    readonly apply: () => Frame;
  }

  const runWrite = (
    w: SimWindow,
    parts: readonly WritePart[],
  ): Effect.Effect<WriteObservation, PlatformError> =>
    Effect.gen(function* () {
      const identityHeld = beginWrite(w);
      if (!identityHeld) {
        return yield* failWith("stale", "window identity replaced behind the same handle");
      }
      let lastRequested: Frame = w.frame;
      for (const part of parts) {
        lastRequested = part.requested;
        // Fixed-size apps refuse resize at the AX API level: a HARD rejection,
        // not a soft observed clamp (probe counts this toward resizable=fixed).
        if (part.component === "size" && w.personality.kind === "fixedSize") {
          settleWindow(w);
          return yield* failWith("rejected", "window refuses all size changes");
        }
        const nextFrame = part.apply();
        if (isAnimated(w.personality)) {
          w.target = nextFrame;
        } else {
          w.frame = nextFrame;
        }
      }
      const stable = settleWindow(w);
      return {
        requested: { ...lastRequested },
        observed: { ...w.frame },
        stable,
      };
    });

  // macOS-style bookends: size → position → size (contract §setWindowFrame).
  const setWindowFrame = (
    id: WindowId,
    frame: Frame,
  ): Effect.Effect<WriteObservation, PlatformError> => {
    const w = resolveWindow(id);
    if (w === undefined) return failWith("not_found", `unknown window ${id}`);
    const requested = (): Frame => ({ ...frame });
    return runWrite(w, [
      { component: "size", requested: requested(), apply: () => applySizeWrite(w, frame) },
      { component: "position", requested: requested(), apply: () => applyPositionWrite(w, frame) },
      { component: "size", requested: requested(), apply: () => applySizeWrite(w, frame) },
    ]);
  };

  const setWindowPosition = (
    id: WindowId,
    point: Point,
  ): Effect.Effect<WriteObservation, PlatformError> => {
    const w = resolveWindow(id);
    if (w === undefined) return failWith("not_found", `unknown window ${id}`);
    const requested = { ...w.frame, x: point.x, y: point.y };
    return runWrite(w, [
      { component: "position", requested, apply: () => applyPositionWrite(w, point) },
    ]);
  };

  const setWindowSize = (
    id: WindowId,
    size: Size,
  ): Effect.Effect<WriteObservation, PlatformError> => {
    const w = resolveWindow(id);
    if (w === undefined) return failWith("not_found", `unknown window ${id}`);
    const requested = { ...w.frame, width: size.width, height: size.height };
    return runWrite(w, [{ component: "size", requested, apply: () => applySizeWrite(w, size) }]);
  };

  const focusWindow = (
    id: WindowId,
    expected?: ExpectedWindowIdentity,
  ): Effect.Effect<import("@paneform/layout").PlatformFocusResult, PlatformError> =>
    Effect.gen(function* () {
      const w = resolveWindow(id);
      if (w === undefined) return yield* failWith("not_found", `unknown window ${id}`);
      if (
        expected !== undefined &&
        expected.fingerprint !== windowIdentityFingerprint(observationOf(w))
      ) {
        return yield* failWith("stale", "window identity changed before focus");
      }
      const held = beginWrite(w);
      if (!held) return yield* failWith("stale", "window identity replaced behind the same handle");
      focusedId = w.id;
      dispatch({ kind: "focus_changed", windowId: w.id });
      return { frontmostPid: w.pid, focused: true, main: true };
    });

  const adapter: PlatformAdapter = {
    events: eventsStream,
    getTopology: () => Effect.succeed({ displays: sortedDisplays() }),
    getWindows: () => Effect.succeed([...windows.values()].map(observationOf)),
    getWindow: (id: WindowId): Effect.Effect<WindowObservation | null, PlatformError> =>
      Effect.sync(() => {
        const w = windows.get(id);
        if (w === undefined) return null;
        // Settle reads drive the animation forward (17 ms apart on real macOS).
        advanceAnimation(w);
        return observationOf(w);
      }),
    setWindowFrame,
    setWindowPosition,
    setWindowSize,
    focusWindow,
  };

  // --- controller ops ---

  const placeFrame = (spec: AddWindowSpec): Frame => {
    const host =
      displays.find((d) => d.spec.id === spec.displayId) ??
      displays.find((d) => d.spec.primary) ??
      displays[0];
    const workArea = host?.spec.workArea ?? { x: 0, y: 0, width: 1512, height: 944 };
    const cascade = ((windows.size % 5) * 32 + Math.floor(rng() * 8)) | 0;
    return {
      x: spec.x ?? workArea.x + 80 + cascade,
      y: spec.y ?? workArea.y + 80 + cascade,
      width: spec.width,
      height: spec.height,
    };
  };

  const addWindow = (spec: AddWindowSpec): WindowId => {
    const id = `window:sim:${nextWindowNumber}`;
    nextWindowNumber += 1;
    const frame = placeFrame(spec);
    const window: SimWindow = {
      id,
      pid: spec.pid ?? nextPid++,
      ...(spec.bundleId !== undefined ? { bundleId: spec.bundleId } : {}),
      executablePath: `/Applications/${(spec.bundleId ?? "sim.app").split(".").pop()}/MacOS/sim`,
      title: spec.title ?? `Sim Window ${nextWindowNumber - 1}`,
      role: spec.role ?? "AXWindow",
      ...(spec.subrole !== undefined ? { subrole: spec.subrole } : {}),
      personality: spec.personality ?? { kind: "normal" },
      frame,
      target: null,
      minimized: spec.minimized ?? false,
      hidden: false,
      fullscreen: false,
      generation: 1,
      replacementPending: false,
      initialFrame: { ...frame },
    };
    windows.set(id, window);
    if (focusedId === null && !window.minimized) focusedId = id;
    dispatch({ kind: "window_added", window: observationOf(window) });
    return id;
  };

  const removeWindow = (id: WindowId): void => {
    if (!windows.has(id)) return;
    windows.delete(id);
    if (focusedId === id) focusedId = [...windows.keys()][0] ?? null;
    dispatch({ kind: "window_removed", windowId: id });
  };

  const focusWindowExternal = (id: WindowId | null): void => {
    if (id !== null && !windows.has(id)) return;
    focusedId = id;
    dispatch({ kind: "focus_changed", windowId: id });
  };

  const driftWindow = (id: WindowId, dx: number, dy: number): void => {
    const w = windows.get(id);
    if (w === undefined) return;
    w.frame = { ...w.frame, x: w.frame.x + dx, y: w.frame.y + dy };
    w.initialFrame = { ...w.frame };
    dispatch({ kind: "window_changed", window: observationOf(w) });
  };

  const nudgeWindow = (id: WindowId, frame: Partial<Frame>): void => {
    const w = windows.get(id);
    if (w === undefined) return;
    w.frame = { ...w.frame, ...frame };
    dispatch({ kind: "window_changed", window: observationOf(w) });
  };

  const scheduleIdentityReplacement = (id: WindowId): void => {
    const w = windows.get(id);
    if (w === undefined) return;
    w.replacementPending = true;
  };

  const connectDisplay = (spec: DisplaySpec): void => {
    if (displays.some((d) => d.spec.id === spec.id)) return;
    displays.push({
      spec: { ...spec, visibility: { ...(spec.visibility ?? DEFAULT_VISIBILITY) } },
    });
    dispatch({ kind: "topology_changed" });
  };

  const disconnectDisplay = (displayId: DisplayId): void => {
    const before = displays.length;
    displays = displays.filter((d) => d.spec.id !== displayId);
    if (displays.length !== before) dispatch({ kind: "topology_changed" });
  };

  const updateWorkArea = (displayId: DisplayId, workArea: Frame): void => {
    const display = displays.find((d) => d.spec.id === displayId);
    if (display === undefined) return;
    display.spec = { ...display.spec, workArea: { ...workArea } };
    dispatch({ kind: "topology_changed" });
  };

  const setVisibilityLimits = (
    displayId: DisplayId,
    limits: { horizontal: number; vertical: number },
  ): void => {
    const display = displays.find((d) => d.spec.id === displayId);
    if (display === undefined) return;
    display.spec = { ...display.spec, visibility: { ...limits } };
  };

  const groundTruth = (): SimGroundTruth => ({
    seed,
    windows: [...windows.values()].map((w) => ({
      id: w.id,
      title: w.title,
      personality: { ...w.personality },
      initialFrame: { ...w.initialFrame },
    })),
    displays: sortedDisplays(),
    focusedWindowId: focusedId,
  });

  return {
    adapter,
    seed,
    addWindow,
    removeWindow,
    focusWindowExternal,
    driftWindow,
    nudgeWindow,
    scheduleIdentityReplacement,
    connectDisplay,
    disconnectDisplay,
    updateWorkArea,
    setVisibilityLimits,
    displays: () => sortedDisplays(),
    windowIds: () => [...windows.keys()],
    focusedWindowId: () => focusedId,
    groundTruth,
  };
}
