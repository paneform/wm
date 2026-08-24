import { Schema } from "effect";

const Attempts = Schema.Number.pipe(Schema.between(1, 5), Schema.int());

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

export const WindowObservation = Schema.Struct({
  id: Schema.String,
  pid: Schema.Number,
  bundleId: Schema.optional(Schema.String),
  executablePath: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
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
);
export type WriteErrorKind = typeof WriteErrorKind.Type;

export const WriteObservation = Schema.Struct({
  requested: Frame,
  observed: Frame,
  stable: Schema.Boolean,
  errorKind: Schema.optional(WriteErrorKind),
});
export interface WriteObservation extends Schema.Schema.Type<typeof WriteObservation> {}

export const PlatformErrorCode = Schema.Literal(
  "not_found",
  "not_controllable",
  "stale",
  "ambiguous",
  "rejected",
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
  Schema.Struct({ kind: Schema.Literal("window_removed"), windowId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("window_changed"), window: WindowObservation }),
  Schema.Struct({ kind: Schema.Literal("focus_changed"), windowId: Schema.NullOr(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("space_changed") }),
  Schema.Struct({ kind: Schema.Literal("sleep") }),
  Schema.Struct({ kind: Schema.Literal("wake") }),
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
});
export interface GeometryRequest extends Schema.Schema.Type<typeof GeometryRequest> {}
