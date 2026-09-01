import { Effect, Stream } from "effect";
import { PlatformError } from "../../src/schema.ts";
import type {
  Constraints,
  DisplayId,
  DisplayObservation,
  ExpectedWindowIdentity,
  Frame,
  PlatformEvent,
  Point,
  Size,
  TopologyObservation,
  WindowId,
  WindowObservation,
  WriteObservation,
} from "../../src/schema.ts";
import type {
  Clock,
  PlatformAdapter,
  PlatformBatchOperationResult,
  PlatformFocusResult,
} from "../../src/platform.ts";

// Headless fake PlatformAdapter — docs/rewrite/testing-guide.md §Fake platform,
// honoring the contract in docs/rewrite/platform-contract.md and matching the
// real interface in src/platform.ts exactly.
//
// Determinism rules:
//  - Seeded xorshift RNG only; no Math.random anywhere.
//  - A Clock (src/platform.ts) must be injected; the fake never touches real
//    time and has no timers. Writes settle synchronously in sampled virtual
//    reads (testing-guide §Standards: "fake settles in microtasks or virtual
//    ticks"), so tests never need to advance the clock for a write to finish.
//    The clock is stamped into the write log for ordering assertions.
//  - Animated personalities interpolate one step per getWindow poll toward
//    their target over N polls, letting the engine observe `progressing`
//    mid-flight states that are never clobbered.
//
// Behaviors emulated (all configurable per window): min/max size clamp
// rejection (clamped frame reported as `observed`, no error), work-area
// clamping of positions, offscreen refusal leaving ~1 pt horizontal / ~52 pt
// vertical visible at the nearest corner (per-display configurable),
// fixed-size (size writes hard-rejected, position honored), unmovable,
// reanchoring (a size write moves the origin; position must be rewritten after
// size to land correctly — validates convergedSizePositionSize), animated
// settling, identity replacement (swapBackingElement → subsequent write aborts
// with `stale`), and topology churn via connectDisplay/disconnectDisplay.

// ---------------------------------------------------------------------------
// Constants (sidecar emulation)
// ---------------------------------------------------------------------------

/**
 * Offscreen parking sliver visibility — mirrors PARKING_TYPICAL_VISIBILITY
 * from src/constants.ts (~1 pt horizontal, ~52 pt vertical).
 */
const DEFAULT_VISIBILITY = { horizontal: 1, vertical: 52 } as const;

/** Adapter settle budget: ≤36 samples, stop early after 3 identical reads. */
const SETTLE_SAMPLES = 36;
const STABLE_READS_TO_STOP = 3;

// On real macOS there is a 17 ms gap between settle samples and a 25 ms delay
// between component writes; the fake settles synchronously instead.

/** Fraction of remaining distance covered per settle read, by kind. */
const ANIMATION_FRACTIONS = {
  animated: 0.35,
  slowAnimated: 0.06,
} satisfies Partial<Record<PersonalityKind, number>>;

const ANIMATED_KINDS: readonly string[] = ["animated", "slowAnimated"];

// ---------------------------------------------------------------------------
// Seeded RNG (xorshift)
// ---------------------------------------------------------------------------

export interface Xorshift32 {
  /** Next raw unit float in [0, 1). */
  next(): number;
  /** Next integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

/** xorshift32 — tiny deterministic PRNG. Seed 0 is remapped (0 is absorbing). */
export const createXorshift32 = (seed: number): Xorshift32 => {
  let state = (seed === 0 ? 0x9e37_79b9 : seed) >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  return {
    next,
    int: (maxExclusive: number): number => Math.floor(next() * Math.max(1, maxExclusive)),
  };
};

// ---------------------------------------------------------------------------
// Pure geometry helpers (unit-testable without a platform instance)
// ---------------------------------------------------------------------------

const clampValue = (v: number, min: number | undefined, max: number | undefined): number => {
  let out = v;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
};

/** Personality size response: clamps into known min/max bounds (soft, no error). */
export function clampSizeToConstraints(size: Size, constraints: Constraints | undefined): Size {
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
 * visible at the corner). Host display = nearest by center distance.
 */
export function offscreenSliverTarget(
  requested: Frame,
  displays: readonly DisplayObservation[],
  visibilityFor: (display: DisplayObservation) => { horizontal: number; vertical: number },
) {
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
  if (host === undefined)
    return { frame: { ...requested }, displayId: "" } satisfies {
      frame: Frame;
      displayId: DisplayId;
    };
  const limits = visibilityFor(host);
  const toLeft = centerX < host.frame.x + host.frame.width / 2;
  const toTop = centerY < host.frame.y + host.frame.height / 2;
  const x = toLeft
    ? host.frame.x - requested.width + limits.horizontal
    : host.frame.x + host.frame.width - limits.horizontal;
  const y = toTop
    ? host.frame.y - requested.height + limits.vertical
    : host.frame.y + host.frame.height - limits.vertical;
  return {
    frame: { x, y, width: requested.width, height: requested.height },
    displayId: host.id,
  } satisfies { frame: Frame; displayId: DisplayId };
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

// ---------------------------------------------------------------------------
// Personality model + specs
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

/**
 * Scripted per-window app personality. Every behavior is configurable per
 * window; kind selects sensible defaults.
 */
export interface FakePersonality {
  kind: PersonalityKind;
  /**
   * Min/max size bounds. Violating size writes clamp softly to the bound and
   * report the clamped frame as `observed` — never an error (behavior 1).
   */
  constraints?: Constraints | undefined;
  /** Reanchoring apps keep this anchor fixed across size writes (default: center for `reanchoring`). */
  anchor?: ("topleft" | "center") | undefined;
  /** Animated only: polls (getWindow reads) needed to converge; fraction = 1/N. */
  settlePolls?: number | undefined;
  /** Offscreen sliver refusal (behavior 3); default on. */
  refusesOffscreen?: boolean | undefined;
  /** Pull positions back into the work area (behavior 2); default on for `workAreaClamp`. */
  clampsToWorkArea?: boolean | undefined;
}

export interface FakeDisplaySpec {
  id: DisplayId;
  frame: Frame;
  workArea: Frame;
  scale: number;
  primary: boolean;
  /** Offscreen parking sliver visibility in points (per-display configurable). */
  visibility?: { horizontal: number; vertical: number } | undefined;
}

export interface FakeWindowSpec {
  id?: WindowId | undefined;
  pid?: number | undefined;
  bundleId?: string | undefined;
  executablePath?: string | undefined;
  title?: string | undefined;
  role?: string | undefined;
  subrole?: string | undefined;
  displayId?: DisplayId | undefined;
  x?: number | undefined;
  y?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  personality?: FakePersonality | undefined;
  constraints?: Constraints | undefined;
  minimized?: boolean | undefined;
  hidden?: boolean | undefined;
  fullscreen?: boolean | undefined;
}

const DEFAULT_DISPLAY: FakeDisplaySpec = {
  id: "display:sim-primary",
  frame: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 38, width: 1512, height: 944 },
  scale: 2,
  primary: true,
};

const DEFAULT_WINDOW: FakeWindowSpec = {
  width: 800,
  height: 600,
  role: "AXWindow",
};

const mergeDefined = <T extends object>(base: T, patch: Partial<T> | undefined): T => {
  if (patch === undefined) return { ...base };
  const definedEntries = Object.entries(patch).filter((entry) => entry[1] !== undefined);
  return { ...base, ...Object.fromEntries(definedEntries) };
};

/** Builder: display spec with defaults (primary 1512×982, notch-style work area). */
export const makeDisplay = (overrides: Partial<FakeDisplaySpec> = {}): FakeDisplaySpec => {
  const merged = mergeDefined(DEFAULT_DISPLAY, overrides);
  return { ...merged, visibility: { ...(merged.visibility ?? DEFAULT_VISIBILITY) } };
};

/** Builder: window spec with defaults (800×600 AXWindow). */
export const makeWindow = (overrides: FakeWindowSpec = {}): FakeWindowSpec =>
  mergeDefined(DEFAULT_WINDOW, overrides);

export const isAnimated = (personality: FakePersonality): boolean =>
  ANIMATED_KINDS.includes(personality.kind);

const anchorOf = (p: FakePersonality): "topleft" | "center" =>
  p.anchor ?? (p.kind === "reanchoring" ? "center" : "topleft");

const animationFractionOf = (p: FakePersonality): number => {
  if (p.settlePolls !== undefined && p.settlePolls > 0) return 1 / p.settlePolls;
  if (p.kind === "animated" || p.kind === "slowAnimated") return ANIMATION_FRACTIONS[p.kind];
  return 1;
};

const platformError = (code: PlatformError["code"], detail: string): PlatformError =>
  new PlatformError({ code, detail });

const failWith = (
  code: PlatformError["code"],
  detail: string,
): Effect.Effect<never, PlatformError> => Effect.fail(platformError(code, detail));

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface FakePlatformOptions {
  /** Virtual clock — required; the fake never touches real time. */
  clock: Clock;
  /** Seed for the xorshift RNG (cascade jitter, pid base). Default 1337. */
  seed?: number | undefined;
  /** Initial displays. Default: primary + secondary sitting LEFT of it. */
  displays?: readonly FakeDisplaySpec[] | undefined;
}

/** One completed adapter write, recorded for ordering/shape assertions. */
export interface FakeWriteRecord {
  at: number;
  windowId: WindowId;
  op: "frame" | "position" | "size";
  /** Component write order used internally (adapter-chosen, size→position→size for frames). */
  parts: readonly ("position" | "size")[];
  requested: Frame;
  observed: Frame;
  stable: boolean;
}

export interface FakePlatform {
  readonly adapter: PlatformAdapter;
  readonly seed: number;

  // World mutation ops (scenario setup).
  addWindow(spec?: FakeWindowSpec): WindowId;
  removeWindow(id: WindowId): void;
  /**
   * Arm identity replacement: the NEXT write behind this handle aborts
   * `stale`. By default the replacement bumps pid; `samePid` keeps it and
   * `subrole` overrides the subrole — modelling a same-pid/role window whose
   * subrole differs (fingerprint mismatch without pid change).
   */
  swapBackingElement(
    id: WindowId,
    opts?: { readonly samePid?: boolean; readonly subrole?: string | null | undefined },
  ): void;
  connectDisplay(spec: FakeDisplaySpec): void;
  disconnectDisplay(displayId: DisplayId): void;
  updateWorkArea(displayId: DisplayId, workArea: Frame): void;
  setVisibilityLimits(displayId: DisplayId, limits: { horizontal: number; vertical: number }): void;
  focusWindowExternal(id: WindowId | null): void;
  driftWindow(id: WindowId, dx: number, dy: number): void;
  nudgeWindow(id: WindowId, patch: Partial<Frame>): void;
  /** Physically move without emitting an event — deterministic divergence. */
  nudgeSilent(id: WindowId, patch: Partial<Frame>): void;
  emitSleep(): void;
  emitWake(): void;
  /**
   * Focus-observation deferral (review round 2, issue 6): when enabled,
   * focus CHANGES update the real focus but observations keep reporting the
   * previously visible focus and the focus_changed event is withheld until
   * releaseDeferredFocus() — modelling delayed platform propagation.
   */
  setDeferFocus(deferred: boolean): void;
  releaseDeferredFocus(): void;
  /** Deliver an AUTHORITATIVE focus_changed event immediately, bypassing
   * deferral — models a newer platform event whose observation lags. */
  emitFocusEvent(id: WindowId | null): void;

  // Introspection.
  displays(): readonly DisplayObservation[];
  windowIds(): readonly WindowId[];
  focusedWindowId(): WindowId | null;
  frameOf(id: WindowId): Frame | null;
  writes(): readonly FakeWriteRecord[];
  batchCalls(): number;
  batchTrace(): readonly {
    operationId: string;
    phase: "start" | "settle" | "finish";
    active: number;
  }[];
  batchHistory(): readonly { writeEnd: number; operationIds: readonly string[] }[];
  rejectNextBatchWrite(id: WindowId, code?: PlatformError["code"]): void;
  rejectNextBatchFocus(id: WindowId, code?: PlatformError["code"]): void;
}

interface SimDisplay {
  spec: FakeDisplaySpec;
}

interface SimWindow {
  id: WindowId;
  pid: number;
  bundleId?: string | undefined;
  executablePath?: string | undefined;
  title: string;
  role: string;
  subrole?: string | null | undefined;
  personality: FakePersonality;
  constraints?: Constraints | undefined;
  frame: Frame;
  /** Pending animation destination; null when stationary. */
  target: Frame | null;
  minimized: boolean;
  hidden: boolean;
  fullscreen: boolean;
  replacementPending: boolean;
  replacementDescriptor?: { samePid?: boolean; subrole?: string | undefined } | undefined;
  initialFrame: Frame;
}

interface MutableWindowObservation {
  id: WindowId;
  pid: number;
  bundleId?: string;
  executablePath?: string;
  title?: string;
  role: string;
  subrole?: string;
  frame: Frame;
  minimized: boolean;
  hidden: boolean;
  fullscreen: boolean;
  focused: boolean;
  capabilities: WindowObservation["capabilities"];
  constraints?: Constraints;
}

export function createFakePlatform(options: FakePlatformOptions): FakePlatform {
  const seed = options.seed ?? 1337;
  const rng = createXorshift32(seed);
  const clock = options.clock;

  const defaultDisplays: readonly FakeDisplaySpec[] = [
    makeDisplay(),
    makeDisplay({
      // Sits LEFT of the primary: negative-origin canonical coordinates.
      id: "display:sim-secondary",
      frame: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 38, width: 1920, height: 1042 },
      scale: 1,
      primary: false,
    }),
  ];

  let displays: SimDisplay[] = (options.displays ?? defaultDisplays).map((spec) => ({
    spec: makeDisplay(spec),
  }));
  const windows = new Map<WindowId, SimWindow>();
  let nextWindowNumber = 1;
  let nextPid = 4200 + rng.int(100);
  let focusedId: WindowId | null = null;
  /** What observations report; lags focusedId while deferral is active. */
  let visibleFocusedId: WindowId | null = null;
  let deferFocus = false;
  let withheldFocusEvent: PlatformEvent | null = null;
  const writeLog: FakeWriteRecord[] = [];
  let batchCallCount = 0;
  const batchEvents: {
    operationId: string;
    phase: "start" | "settle" | "finish";
    active: number;
  }[] = [];
  let activeBatchOperations = 0;
  const batchHistory: { writeEnd: number; operationIds: readonly string[] }[] = [];
  const rejectedBatchWrites = new Map<WindowId, PlatformError["code"]>();
  const rejectedBatchFocus = new Map<WindowId, PlatformError["code"]>();

  const emitFocusChanged = (id: WindowId | null): void => {
    if (deferFocus) {
      withheldFocusEvent = { kind: "focus_changed", windowId: id };
      return;
    }
    dispatch({ kind: "focus_changed", windowId: id });
  };

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
      case "minMaxClamp":
        return {
          movable: "supported",
          resizable: "supported",
          movableEvidence: "platform_report",
          resizableEvidence: "platform_report",
        };
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

  const observationOf = (w: SimWindow): WindowObservation => {
    const observation: MutableWindowObservation = {
      id: w.id,
      pid: w.pid,
      title: w.title,
      role: w.role,
      frame: { ...w.frame },
      minimized: w.minimized,
      hidden: w.hidden,
      fullscreen: w.fullscreen,
      focused: w.id === (deferFocus ? visibleFocusedId : focusedId),
      capabilities: capabilitiesOf(w),
    };
    if (w.bundleId !== undefined) observation.bundleId = w.bundleId;
    if (w.executablePath !== undefined) observation.executablePath = w.executablePath;
    if (w.subrole !== undefined && w.subrole !== null) observation.subrole = w.subrole;
    if (w.constraints !== undefined) observation.constraints = w.constraints;
    return observation;
  };

  const resolveWindow = (id: WindowId): SimWindow | undefined => windows.get(id);

  // --- animation (read-driven; deterministic, zero timers) ---

  const advanceAnimation = (w: SimWindow): void => {
    if (w.target === null) return;
    w.frame = stepTowardFrame(w.frame, w.target, animationFractionOf(w.personality));
    const t = w.target;
    if (
      w.frame.x === t.x &&
      w.frame.y === t.y &&
      w.frame.width === t.width &&
      w.frame.height === t.height
    ) {
      w.target = null;
    }
  };

  /**
   * Settle loop after component writes: advance the animation once per
   * virtual read, stop early on three identical reads or budget exhaustion.
   * Runs synchronously — no clock advancement required by callers.
   */
  interface SettledWindow {
    frame: Frame;
    stable: boolean;
  }

  const settleWindow = (w: SimWindow): SettledWindow => {
    let previous = JSON.stringify(w.frame);
    let stableReads = 0;
    for (let read = 0; read < SETTLE_SAMPLES; read++) {
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
    return { frame: { ...w.frame }, stable: w.target === null };
  };

  // --- write pipeline ---

  /**
   * Identity discipline (contract §4): consume any armed replacement BEFORE
   * applying the write; if the backing element was swapped, abort with
   * `stale` rather than mutating the replacement. The replacement also
   * changes the pid unless `samePid`; a forced subrole models same-pid
   * replacements that still differ in the identity fingerprint.
   */
  const beginWrite = (w: SimWindow): boolean => {
    if (w.replacementPending) {
      w.replacementPending = false;
      const d = w.replacementDescriptor ?? {};
      if (!d.samePid) {
        w.pid = nextPid;
        nextPid += 1;
      }
      if (d.subrole !== undefined) w.subrole = d.subrole === null ? undefined : d.subrole;
      w.replacementDescriptor = undefined;
      return false;
    }
    return true;
  };

  const workAreasAll = (): Frame[] => displays.map((d) => d.spec.workArea);

  const applyOffscreenRefusal = (frame: Frame): Frame => {
    const observations = sortedDisplays();
    if (observations.length === 0) return frame;
    // Monotone sliver model: a window may sit offscreen only within the
    // measured visibility limits of its nearest display corner; positions
    // more offscreen than the sliver clamp per-axis to exactly the limits
    // (real macOS retains fractional coordinates).
    const { frame: sliver, displayId: sliverDisplayId } = offscreenSliverTarget(
      frame,
      observations,
      (display) => {
        const match = displays.find((d) => d.spec.id === display.id);
        return match?.spec.visibility ?? { ...DEFAULT_VISIBILITY };
      },
    );
    const host = observations.find((d) => d.id === sliverDisplayId) ?? observations[0]!;
    const limits = (() => {
      const match = displays.find((d) => d.spec.id === host.id);
      return match?.spec.visibility ?? { ...DEFAULT_VISIBILITY };
    })();
    const leftHost = frame.x + frame.width / 2 < host.frame.x + host.frame.width / 2;
    const topHost = frame.y + frame.height / 2 < host.frame.y + host.frame.height / 2;
    const impliedH = leftHost
      ? frame.x + frame.width - host.frame.x
      : host.frame.x + host.frame.width - frame.x;
    const impliedV = topHost
      ? frame.y + frame.height - host.frame.y
      : host.frame.y + host.frame.height - frame.y;
    if (impliedH >= limits.horizontal && impliedV >= limits.vertical) return frame;
    const clampedX = leftHost
      ? Math.max(frame.x, host.frame.x - frame.width + limits.horizontal)
      : Math.min(frame.x, host.frame.x + host.frame.width - limits.horizontal);
    const clampedY = topHost
      ? Math.max(frame.y, host.frame.y - frame.height + limits.vertical)
      : Math.min(frame.y, host.frame.y + host.frame.height - limits.vertical);
    void sliver;
    return { x: clampedX, y: clampedY, width: frame.width, height: frame.height };
  };

  const applyPositionWrite = (w: SimWindow, point: Point): Frame => {
    if (w.personality.kind === "unmovable") return { ...w.frame };
    let next: Frame = { ...w.frame, x: point.x, y: point.y };
    if (w.personality.clampsToWorkArea ?? w.personality.kind === "workAreaClamp") {
      next = clampFrameIntoWorkArea(next, workAreasAll());
    }
    if (w.personality.refusesOffscreen !== false) next = applyOffscreenRefusal(next);
    return next;
  };

  const applySizeWrite = (w: SimWindow, size: Size): Frame => {
    if (w.personality.kind === "unmovable") return { ...w.frame };
    const constrained = clampSizeToConstraints(size, w.personality.constraints);
    if (anchorOf(w.personality) === "center") {
      // Reanchoring app: origin shifts so the visual center stays put — a
      // size-then-position sequence ends with position wrong unless position
      // is rewritten after the final size bookend.
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
    readonly apply: () => Frame;
  }

  const runWrite = (
    w: SimWindow,
    op: FakeWriteRecord["op"],
    requestedFrame: Frame,
    parts: readonly WritePart[],
  ): Effect.Effect<WriteObservation, PlatformError> =>
    Effect.gen(function* () {
      if (!beginWrite(w)) {
        return yield* failWith("stale", "window identity replaced behind the same handle");
      }
      for (const part of parts) {
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
      const settled = settleWindow(w);
      const record: FakeWriteRecord = {
        at: clock.now(),
        windowId: w.id,
        op,
        parts: parts.map((p) => p.component),
        requested: { ...requestedFrame },
        observed: settled.frame,
        stable: settled.stable,
      };
      writeLog.push(record);
      return {
        requested: record.requested,
        observed: settled.frame,
        stable: settled.stable,
      } satisfies WriteObservation;
    });

  // macOS-style bookends: size → position → size (contract §setWindowFrame).
  /** Canonical fingerprint — MUST mirror engine windowIdentityOf exactly. */
  const fingerprintOf = (
    pid: number,
    role: string | null | undefined,
    subrole: string | null | undefined,
  ): string => JSON.stringify([pid, role ?? null, subrole ?? null]);

  /** Atomic identity precondition: compared against live state BEFORE any
   * mutation; mismatch aborts `stale` leaving the window untouched. */
  const matchesExpected = (w: SimWindow, expected?: ExpectedWindowIdentity): boolean =>
    expected === undefined || fingerprintOf(w.pid, w.role, w.subrole) === expected.fingerprint;

  const setWindowFrame = (
    id: WindowId,
    frame: Frame,
    expected?: ExpectedWindowIdentity,
  ): Effect.Effect<WriteObservation, PlatformError> => {
    const w = resolveWindow(id);
    if (w === undefined) return failWith("not_found", `unknown window ${id}`);
    if (!matchesExpected(w, expected)) {
      return failWith("stale", "identity precondition mismatch");
    }
    const requested = (): Frame => ({ ...frame });
    return runWrite(w, "frame", requested(), [
      {
        component: "size",
        apply: () => applySizeWrite(w, { width: frame.width, height: frame.height }),
      },
      { component: "position", apply: () => applyPositionWrite(w, { x: frame.x, y: frame.y }) },
      {
        component: "size",
        apply: () => applySizeWrite(w, { width: frame.width, height: frame.height }),
      },
    ]);
  };

  const setWindowPosition = (
    id: WindowId,
    point: Point,
    expected?: ExpectedWindowIdentity,
  ): Effect.Effect<WriteObservation, PlatformError> => {
    const w = resolveWindow(id);
    if (w === undefined) return failWith("not_found", `unknown window ${id}`);
    if (!matchesExpected(w, expected)) {
      return failWith("stale", "identity precondition mismatch");
    }
    const requested: Frame = { ...w.frame, x: point.x, y: point.y };
    return runWrite(w, "position", requested, [
      { component: "position", apply: () => applyPositionWrite(w, point) },
    ]);
  };

  const setWindowSize = (
    id: WindowId,
    size: Size,
    expected?: ExpectedWindowIdentity,
  ): Effect.Effect<WriteObservation, PlatformError> => {
    const w = resolveWindow(id);
    if (w === undefined) return failWith("not_found", `unknown window ${id}`);
    if (!matchesExpected(w, expected)) {
      return failWith("stale", "identity precondition mismatch");
    }
    const requested: Frame = { ...w.frame, width: size.width, height: size.height };
    return runWrite(w, "size", requested, [
      { component: "size", apply: () => applySizeWrite(w, size) },
    ]);
  };

  const focusWindow = (
    id: WindowId,
    expected?: ExpectedWindowIdentity,
  ): Effect.Effect<PlatformFocusResult, PlatformError> =>
    Effect.gen(function* () {
      const w = resolveWindow(id);
      if (w === undefined) return yield* failWith("not_found", `unknown window ${id}`);
      if (!matchesExpected(w, expected)) {
        return yield* failWith("stale", "identity precondition mismatch");
      }
      if (!beginWrite(w)) {
        return yield* failWith("stale", "window identity replaced behind the same handle");
      }
      const changed = focusedId !== w.id;
      focusedId = w.id;
      if (changed) emitFocusChanged(w.id);
      return { frontmostPid: w.pid, focused: true, main: true };
    });

  const adapter: PlatformAdapter = {
    events: eventsStream,
    getTopology: (): Effect.Effect<TopologyObservation, PlatformError> =>
      Effect.sync(() => ({ displays: sortedDisplays() })),
    getWindows: (): Effect.Effect<ReadonlyArray<WindowObservation>, PlatformError> =>
      Effect.sync(() => [...windows.values()].map(observationOf)),
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
    executeBatch: (request) =>
      Effect.gen(function* () {
        batchCallCount += 1;
        const pending = new Map(
          request.operations.map((operation, index) => [
            operation.operationId,
            { operation, index },
          ]),
        );
        const results = new Map<string, PlatformBatchOperationResult>();
        let waveCount = 0;
        while (pending.size > 0) {
          waveCount += 1;
          if (waveCount > request.operations.length + 1) {
            throw new Error("fake batch scheduler failed to make progress");
          }
          const usedWindows = new Set<WindowId>();
          const ready = [...pending.values()].filter(({ operation }) => {
            if ((operation.dependsOn ?? []).some((id) => !results.has(id))) return false;
            if (usedWindows.has(operation.windowId)) return false;
            usedWindows.add(operation.windowId);
            return true;
          });
          if (ready.length === 0) {
            for (const { operation } of pending.values()) {
              results.set(operation.operationId, {
                operationId: operation.operationId,
                error: platformError("rejected", "cyclic or unknown batch dependency"),
              });
            }
            break;
          }
          activeBatchOperations = ready.length;
          for (const { operation } of ready) {
            batchEvents.push({
              operationId: operation.operationId,
              phase: "start",
              active: activeBatchOperations,
            });
          }
          const wave: PlatformBatchOperationResult[] = [];
          for (const { operation } of ready) {
            batchEvents.push({
              operationId: operation.operationId,
              phase: "settle",
              active: activeBatchOperations,
            });
            if (operation.kind === "focus") {
              const outcome = yield* Effect.either(
                Effect.gen(function* () {
                  const window = resolveWindow(operation.windowId);
                  if (window === undefined)
                    return yield* failWith("not_found", `unknown window ${operation.windowId}`);
                  if (!matchesExpected(window, operation.expectedIdentity)) {
                    return yield* failWith("stale", "window identity changed before focus");
                  }
                  return yield* focusWindow(operation.windowId);
                }),
              );
              activeBatchOperations -= 1;
              batchEvents.push({
                operationId: operation.operationId,
                phase: "finish",
                active: activeBatchOperations,
              });
              if (outcome._tag === "Left") {
                wave.push({ operationId: operation.operationId, error: outcome.left });
                continue;
              }
              const focus: PlatformFocusResult = outcome.right;
              const rejected = rejectedBatchFocus.get(operation.windowId);
              rejectedBatchFocus.delete(operation.windowId);
              wave.push({
                operationId: operation.operationId,
                ...focus,
                error:
                  rejected === undefined
                    ? undefined
                    : platformError(rejected, `simulated ${rejected} after AX focus`),
              });
            } else {
              const outcome = yield* Effect.either(
                setWindowFrame(operation.windowId, operation.frame, operation.expectedIdentity),
              );
              activeBatchOperations -= 1;
              batchEvents.push({
                operationId: operation.operationId,
                phase: "finish",
                active: activeBatchOperations,
              });
              if (outcome._tag === "Left") {
                wave.push({ operationId: operation.operationId, error: outcome.left });
                continue;
              }
              const write: WriteObservation = outcome.right;
              const rejected = rejectedBatchWrites.get(operation.windowId);
              rejectedBatchWrites.delete(operation.windowId);
              wave.push({
                operationId: operation.operationId,
                requested: write.requested,
                observed: write.observed,
                stable: write.stable,
                stableReads: write.stable ? STABLE_READS_TO_STOP : 0,
                error:
                  rejected === undefined
                    ? undefined
                    : platformError(rejected, `simulated ${rejected} after write`),
              });
            }
          }
          for (let index = 0; index < ready.length; index += 1) {
            const id = ready[index]!.operation.operationId;
            results.set(id, wave[index]!);
            pending.delete(id);
          }
        }
        const operations = request.operations.map((operation) =>
          results.get(operation.operationId)!,
        );
        batchHistory.push({
          writeEnd: writeLog.length,
          operationIds: request.operations.map((operation) => operation.operationId),
        });
        return {
          operations,
          completed: operations.filter((result) => result.error === undefined).length,
          failed: operations.filter((result) => result.error !== undefined).length,
        };
      }),
  };

  // --- controller ops ---

  const placeFrame = (spec: FakeWindowSpec): Frame => {
    const host =
      displays.find((d) => d.spec.id === spec.displayId) ??
      displays.find((d) => d.spec.primary) ??
      displays[0];
    const workArea = host?.spec.workArea ?? { x: 0, y: 0, width: 1512, height: 944 };
    const cascade = (windows.size % 5) * 32 + rng.int(8);
    return {
      x: spec.x ?? workArea.x + 80 + cascade,
      y: spec.y ?? workArea.y + 80 + cascade,
      width: spec.width ?? DEFAULT_WINDOW.width!,
      height: spec.height ?? DEFAULT_WINDOW.height!,
    };
  };

  const addWindow = (spec: FakeWindowSpec = {}): WindowId => {
    const id = spec.id ?? `window:sim:${nextWindowNumber}`;
    const numberForTitle = nextWindowNumber;
    nextWindowNumber += 1;
    const frame = placeFrame(spec);
    const bundleId = spec.bundleId;
    const window: SimWindow = {
      id,
      pid: spec.pid ?? nextPid,
      executablePath:
        spec.executablePath ??
        `/Applications/${(bundleId ?? "sim.app").split(".").pop()}/MacOS/sim`,
      title: spec.title ?? `Sim Window ${numberForTitle}`,
      role: spec.role ?? "AXWindow",
      personality: spec.personality ?? { kind: "normal" },
      frame,
      target: null,
      minimized: spec.minimized ?? false,
      hidden: spec.hidden ?? false,
      fullscreen: spec.fullscreen ?? false,
      replacementPending: false,
      initialFrame: { ...frame },
    };
    if (bundleId !== undefined) window.bundleId = bundleId;
    if (spec.subrole !== undefined) window.subrole = spec.subrole;
    if (spec.constraints !== undefined) window.constraints = spec.constraints;
    nextPid += 1;
    windows.set(id, window);
    if (focusedId === null && !window.minimized) {
      focusedId = id;
      visibleFocusedId = id;
    }
    dispatch({ kind: "window_added", window: observationOf(window) });
    return id;
  };

  const removeWindow = (id: WindowId): void => {
    if (!windows.has(id)) return;
    windows.delete(id);
    if (focusedId === id) {
      focusedId = [...windows.keys()][0] ?? null;
      visibleFocusedId = focusedId;
    }
    dispatch({ kind: "window_removed", windowId: id });
  };

  const focusWindowExternal = (id: WindowId | null): void => {
    if (id !== null && !windows.has(id)) return;
    focusedId = id;
    emitFocusChanged(id);
  };

  const releaseDeferredFocus = (): void => {
    visibleFocusedId = focusedId;
    withheldFocusEvent = null;
    // Re-report under the CURRENT real focus so observers converge.
    dispatch({ kind: "focus_changed", windowId: visibleFocusedId });
  };

  const driftWindow = (id: WindowId, dx: number, dy: number): void => {
    const w = windows.get(id);
    if (w === undefined) return;
    w.frame = { ...w.frame, x: w.frame.x + dx, y: w.frame.y + dy };
    w.initialFrame = { ...w.frame };
    dispatch({ kind: "window_changed", window: observationOf(w) });
  };

  const nudgeWindow = (id: WindowId, patch: Partial<Frame>): void => {
    const w = windows.get(id);
    if (w === undefined) return;
    w.frame = mergeDefined(w.frame, patch);
    dispatch({ kind: "window_changed", window: observationOf(w) });
  };

  const swapBackingElement = (
    id: WindowId,
    opts?: { readonly samePid?: boolean; readonly subrole?: string | null },
  ): void => {
    const w = windows.get(id);
    if (w === undefined) return;
    w.replacementPending = true;
    // `null` models a replacement whose subrole is explicitly ABSENT — the
    // descriptor drops the key so SimWindow keeps undefined (== null view).
    const o = opts ?? {};
    const descriptor: NonNullable<SimWindow["replacementDescriptor"]> = {};
    if (o.samePid !== undefined) descriptor.samePid = o.samePid;
    if (o.subrole !== undefined && o.subrole !== null) descriptor.subrole = o.subrole;
    w.replacementDescriptor = descriptor;
  };

  const connectDisplay = (spec: FakeDisplaySpec): void => {
    if (displays.some((d) => d.spec.id === spec.id)) return;
    displays.push({ spec: makeDisplay(spec) });
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

  return {
    adapter,
    seed,
    addWindow,
    removeWindow,
    swapBackingElement,
    connectDisplay,
    disconnectDisplay,
    updateWorkArea,
    setVisibilityLimits,
    focusWindowExternal,
    driftWindow,
    nudgeWindow,
    nudgeSilent: (id: WindowId, patch: Partial<Frame>): void => {
      const w = windows.get(id);
      if (w === undefined) return;
      w.frame = mergeDefined(w.frame, patch);
    },
    emitSleep: (): void => dispatch({ kind: "sleep" }),
    emitWake: (): void => dispatch({ kind: "wake" }),
    setDeferFocus: (deferred: boolean): void => {
      deferFocus = deferred;
      if (!deferred) releaseDeferredFocus();
    },
    releaseDeferredFocus,
    emitFocusEvent: (id: WindowId | null): void => {
      dispatch({ kind: "focus_changed", windowId: id });
    },
    displays: (): readonly DisplayObservation[] => sortedDisplays(),
    windowIds: (): readonly WindowId[] => [...windows.keys()],
    focusedWindowId: (): WindowId | null => focusedId,
    frameOf: (id: WindowId): Frame | null => {
      const w = windows.get(id);
      return w === undefined ? null : { ...w.frame };
    },
    writes: (): readonly FakeWriteRecord[] => [...writeLog],
    batchCalls: () => batchCallCount,
    batchTrace: () => [...batchEvents],
    batchHistory: () => [...batchHistory],
    rejectNextBatchWrite: (id, code = "not_controllable") => {
      rejectedBatchWrites.set(id, code);
    },
    rejectNextBatchFocus: (id, code = "rejected") => {
      rejectedBatchFocus.set(id, code);
    },
  };
}
