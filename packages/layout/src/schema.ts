import { Schema } from "effect";

const Attempts = Schema.Number.pipe(Schema.between(1, 5), Schema.int());

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface JsonSerializableObject {
  readonly [key: string]: JsonSerializableValue | undefined;
}

export type JsonSerializableValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonSerializableValue[]
  | JsonSerializableObject;

const PlainJsonObject = Schema.declare((value: unknown): value is JsonObject => {
  if (Object(value) !== value || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
});

const PlainJsonSerializableObject = Schema.declare(
  (value: unknown): value is JsonSerializableObject => {
    if (Object(value) !== value || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  },
);

export const JsonValueSchema: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.Null,
    Schema.Boolean,
    Schema.JsonNumber,
    Schema.String,
    Schema.Array(JsonValueSchema),
    PlainJsonObject.pipe(
      Schema.compose(Schema.Record({ key: Schema.String, value: JsonValueSchema })),
    ),
  ),
);

export const JsonSerializableValueSchema: Schema.Schema<JsonSerializableValue> = Schema.suspend(
  () =>
    Schema.Union(
      Schema.Null,
      Schema.Boolean,
      Schema.JsonNumber,
      Schema.String,
      Schema.Array(JsonSerializableValueSchema),
      PlainJsonSerializableObject.pipe(
        Schema.compose(
          Schema.Record({
            key: Schema.String,
            value: Schema.Union(JsonSerializableValueSchema, Schema.Undefined),
          }),
        ),
      ),
    ),
);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const Point = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});
export interface Point extends Schema.Schema.Type<typeof Point> {}

export const Size = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
});
export interface Size extends Schema.Schema.Type<typeof Size> {}

/** Canonical OS space: top-left of primary display origin, y-down, integer points. */
export const Frame = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export interface Frame extends Schema.Schema.Type<typeof Frame> {}

export type DisplayId = string;
export type WindowId = string;
export type WorkspaceName = string;

// ---------------------------------------------------------------------------
// Observations (platform → engine)
// ---------------------------------------------------------------------------

export const DisplayObservation = Schema.Struct({
  id: Schema.String,
  nativeId: Schema.optional(Schema.String),
  frame: Frame,
  workArea: Frame,
  scale: Schema.Number,
  primary: Schema.Boolean,
});
export interface DisplayObservation extends Schema.Schema.Type<typeof DisplayObservation> {}

export const TopologyObservation = Schema.Struct({
  displays: Schema.Array(DisplayObservation),
});
export interface TopologyObservation extends Schema.Schema.Type<typeof TopologyObservation> {}

export const CapabilityState = Schema.Literal("unknown", "supported", "fixed", "inconclusive");
export type CapabilityState = typeof CapabilityState.Type;

export const EvidenceSource = Schema.Literal(
  "platform_report",
  "behavioral_probe",
  "geometry_operation",
);
export type EvidenceSource = typeof EvidenceSource.Type;

export const Capabilities = Schema.Struct({
  movable: CapabilityState,
  resizable: CapabilityState,
  movableEvidence: EvidenceSource,
  resizableEvidence: EvidenceSource,
});
export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}

export const Constraints = Schema.Struct({
  minWidth: Schema.optional(Schema.Number),
  maxWidth: Schema.optional(Schema.Number),
  minHeight: Schema.optional(Schema.Number),
  maxHeight: Schema.optional(Schema.Number),
});
export interface Constraints extends Schema.Schema.Type<typeof Constraints> {}

export const WindowIdentity = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  appName: Schema.optional(Schema.String),
});
export interface WindowIdentity extends Schema.Schema.Type<typeof WindowIdentity> {}

export const WindowObservation = Schema.Struct({
  ...WindowIdentity.fields,
  pid: Schema.Number,
  /** Opaque lifetime token; changes when a native handle or process is reused. */
  instanceId: Schema.optional(Schema.String),
  bundleId: Schema.optional(Schema.String),
  executablePath: Schema.optional(Schema.String),
  role: Schema.String,
  subrole: Schema.optional(Schema.String),
  frame: Frame,
  minimized: Schema.Boolean,
  hidden: Schema.Boolean,
  fullscreen: Schema.Boolean,
  focused: Schema.Boolean,
  capabilities: Capabilities,
  constraints: Schema.optional(Constraints),
});
export interface WindowObservation extends Schema.Schema.Type<typeof WindowObservation> {}

export const WindowInventory = Schema.Struct({
  windows: Schema.Array(WindowObservation),
  unavailableWindowIds: Schema.Array(Schema.String),
  closedWindowIds: Schema.Array(Schema.String),
});
export interface WindowInventory extends Schema.Schema.Type<typeof WindowInventory> {}

/** Titles, geometry and state-dependent subroles are not lifetime identifiers. */
export const sameWindowInstance = (a: WindowObservation, b: WindowObservation): boolean =>
  a.id === b.id &&
  a.pid === b.pid &&
  (a.instanceId !== undefined || b.instanceId !== undefined
    ? a.instanceId === b.instanceId
    : a.role === b.role && a.bundleId === b.bundleId && a.executablePath === b.executablePath);

export const WindowClass = Schema.Literal("normal", "transient", "system", "uncertain");
export type WindowClass = typeof WindowClass.Type;

// ---------------------------------------------------------------------------
// Platform write outcomes
// ---------------------------------------------------------------------------

export const WriteErrorKind = Schema.Literal(
  "rejected",
  "not_found",
  "not_controllable",
  "stale",
  "ambiguous",
  "unresponsive",
);
export type WriteErrorKind = typeof WriteErrorKind.Type;

/**
 * Identity precondition attached to generic write primitives: the adapter
 * MUST atomically re-validate this against the live window immediately
 * before any component mutation and abort with `PlatformError { stale }`
 * (leaving the window untouched) on mismatch (contract §4).
 *
 * A single REQUIRED fingerprint deliberately avoids the absent-vs-null JSON
 * ambiguity of optional metadata fields: it is
 * `JSON.stringify([pid, role ?? null, subrole ?? null])`, so a replacement
 * with an optional fourth instanceId element when the platform supplies one.
 * A replacement sharing pid+role but carrying ANY subrole (including null vs non-null)
 * produces a different fingerprint and is rejected as stale.
 */
export const ExpectedWindowIdentity = Schema.Struct({
  fingerprint: Schema.String,
});
export interface ExpectedWindowIdentity extends Schema.Schema.Type<typeof ExpectedWindowIdentity> {}

/** Canonical cross-adapter identity token used by guarded window writes. */
export const windowIdentityFingerprint = (observation: {
  pid: number;
  role?: string | null | undefined;
  subrole?: string | null | undefined;
  instanceId?: string | undefined;
}): string =>
  JSON.stringify([
    observation.pid,
    observation.role ?? null,
    observation.subrole ?? null,
    ...(observation.instanceId === undefined ? [] : [observation.instanceId]),
  ]);

export const WriteObservation = Schema.Struct({
  requested: Frame,
  observed: Frame,
  stable: Schema.Boolean,
  stableReads: Schema.optional(Schema.Number),
  errorKind: Schema.optional(WriteErrorKind),
  /** Wall-clock duration of the adapter's whole write operation, in ms. */
  durationMs: Schema.optional(Schema.Number),
  /** Owning app's AX messaging was stalled at settle time — clamp-shaped
   * evidence from this write must not be learned (bean wm-ixs4). */
  appStalled: Schema.optional(Schema.Boolean),
});
export interface WriteObservation extends Schema.Schema.Type<typeof WriteObservation> {}

export const PlatformErrorCode = Schema.Literal(
  "not_found",
  "not_controllable",
  "stale",
  "ambiguous",
  "rejected",
  "unresponsive",
  "permission",
  "unavailable",
);
export type PlatformErrorCode = typeof PlatformErrorCode.Type;

export class PlatformError extends Schema.TaggedError<PlatformError>()("PlatformError", {
  code: PlatformErrorCode,
  detail: Schema.optional(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Platform events (hints; engine reconciles via snapshots)
// ---------------------------------------------------------------------------

export const PlatformEvent = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("topology_changed") }),
  Schema.Struct({ kind: Schema.Literal("window_added"), window: WindowObservation }),
  Schema.Struct({
    kind: Schema.Literal("window_removed"),
    windowId: Schema.String,
    /** Positive destruction evidence, not an inventory-diff absence. */
    closed: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("window_changed"), window: WindowObservation }),
  Schema.Struct({ kind: Schema.Literal("focus_changed"), windowId: Schema.NullOr(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("space_changed") }),
  Schema.Struct({ kind: Schema.Literal("sleep") }),
  Schema.Struct({ kind: Schema.Literal("wake") }),
  /** Telemetry-only hints: an app's AX messaging started/stopped timing out. */
  Schema.Struct({
    kind: Schema.Literal("ax_stall"),
    pid: Schema.Number,
    app: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("ax_recover"), pid: Schema.Number }),
);
export type PlatformEvent = typeof PlatformEvent.Type;

// ---------------------------------------------------------------------------
// Geometry outcome classification
// ---------------------------------------------------------------------------

export const GeometryOutcome = Schema.Literal(
  "exact",
  "constrained",
  "progressing",
  "stableClamp",
  "failed",
);
export type GeometryOutcome = typeof GeometryOutcome.Type;

export const GeometryRequest = Schema.Struct({
  windowId: Schema.String,
  frame: Frame,
  tolerance: Schema.optional(Schema.Number),
  attempts: Schema.optional(Attempts),
  acceptance: Schema.optional(Schema.Literal("parkingStablePositionClamp")),
});
export interface GeometryRequest extends Schema.Schema.Type<typeof GeometryRequest> {}
