import { Either, Schema } from "effect";
import {
  type ExpectedWindowIdentity,
  PlatformEvent,
  TopologyObservation,
  WindowObservation,
  WriteObservation,
} from "@wm/engine";

/**
 * Wire schemas for the sidecar protocol (docs/rewrite/platform-contract.md
 * §macOS sidecar wire protocol). EVERY message crossing the boundary is
 * schema-validated; invalid inbound messages surface as structured protocol
 * errors, never silently.
 */

// ---------------------------------------------------------------------------
// Engine → sidecar requests (encoded, not decoded — kept for reference/tests)
// ---------------------------------------------------------------------------

export interface SetWindowFrameRequest {
  readonly op: "setWindowFrame";
  readonly reqId: string;
  readonly id: string;
  readonly frame: { x: number; y: number; width: number; height: number };
  readonly mode: "frame" | "position" | "size";
  /**
   * Atomic identity precondition (generic adapter contract §4): the sidecar
   * MUST re-validate against live window metadata immediately before any
   * component mutation and respond `stale` without writing on mismatch.
   */
  readonly expectedIdentity?: ExpectedWindowIdentity;
}

export type SidecarRequest =
  | { readonly op: "subscribe"; readonly reqId: string }
  | { readonly op: "getTopology"; readonly reqId: string }
  | { readonly op: "getWindows"; readonly reqId: string }
  | { readonly op: "getWindow"; readonly reqId: string; readonly id: string }
  | SetWindowFrameRequest
  | { readonly op: "executeBatch"; readonly reqId: string; readonly operations: readonly unknown[] }
  | { readonly op: "focusWindow"; readonly reqId: string; readonly id: string }
  | { readonly op: "ping"; readonly reqId: string }
  | { readonly op: "permissionsStatus"; readonly reqId: string }
  | { readonly op: "requestPermissions"; readonly reqId: string }
  | { readonly op: "configureKeybinds"; readonly reqId: string; readonly keybinds: Readonly<Record<string, string>> }
  | {
      readonly op: "openPermissionsSettings";
      readonly reqId: string;
      readonly target: SettingsTarget;
    };

export type SettingsTarget = "accessibility" | "screenRecording";

// ---------------------------------------------------------------------------
// Sidecar → engine: handshake
// ---------------------------------------------------------------------------

export const ReadyMessage = Schema.Struct({
  ready: Schema.Literal(true),
  version: Schema.String,
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
});
export interface ReadyMessage extends Schema.Schema.Type<typeof ReadyMessage> {}

// ---------------------------------------------------------------------------
// Sidecar → engine: results, correlated by reqId. The result payload shape
// depends on the originating op.
// ---------------------------------------------------------------------------

export type ResultSchemaFor = {
  ping: typeof PingResult;
  subscribe: typeof SubscribeResult;
  getTopology: typeof TopologyResult;
  getWindows: typeof WindowsResult;
  getWindow: typeof WindowResult;
  setWindowFrame: typeof WriteObservation;
  executeBatch: typeof BatchResult;
  focusWindow: typeof FocusResult;
  permissionsStatus: typeof PermissionsResult;
  requestPermissions: typeof PermissionsResult;
  openPermissionsSettings: typeof OpenedResult;
  configureKeybinds: typeof KeybindsConfiguredResult;
};

const BatchOperationResult = Schema.Struct({
  operationId: Schema.String,
  requested: Schema.optional(Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number })),
  observed: Schema.optional(Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number })),
  stable: Schema.optional(Schema.Boolean),
  stableReads: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.Struct({
    code: Schema.Literal("not_found", "not_controllable", "stale", "ambiguous", "rejected", "permission", "unavailable"),
    detail: Schema.optional(Schema.String),
  })),
});
export const BatchResult = Schema.Struct({
  operations: Schema.Array(BatchOperationResult),
  completed: Schema.Number,
  failed: Schema.Number,
});

export const PingResult = Schema.Struct({
  pong: Schema.Literal(true),
  version: Schema.optional(Schema.String),
});
export const SubscribeResult = Schema.Struct({
  subscribed: Schema.Literal(true),
});
export const TopologyResult = Schema.Struct({ topology: TopologyObservation });
export const WindowsResult = Schema.Struct({
  windows: Schema.Array(WindowObservation),
});
/** Absent window decodes to null per the contract. */
export const WindowResult = Schema.Struct({
  window: Schema.NullOr(WindowObservation),
});
export const FocusResult = Schema.Struct({ focused: Schema.Literal(true) });

// ---------------------------------------------------------------------------
// Permissions (TCC). Status/request responses share one shape; the request
// invocation itself is owned by the sidecar executable.
// ---------------------------------------------------------------------------

export const PermissionStatus = Schema.Struct({
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
});
export interface PermissionStatus extends Schema.Schema.Type<typeof PermissionStatus> {}

export const PermissionsResult = Schema.Struct({ permissions: PermissionStatus });
export const OpenedResult = Schema.Struct({ opened: Schema.Literal(true) });
export const KeybindsConfiguredResult = Schema.Struct({ configured: Schema.Number });

export const ErrorBody = Schema.Struct({
  code: Schema.String,
  detail: Schema.optional(Schema.String),
});

const ResultEnvelopeBase = {
  reqId: Schema.String,
};

export const ResultEnvelope = Schema.Struct({
  ...ResultEnvelopeBase,
  result: Schema.Unknown,
});

export const ErrorEnvelope = Schema.Struct({
  reqId: Schema.optional(Schema.String),
  error: ErrorBody,
});

// ---------------------------------------------------------------------------
// Sidecar → engine: events
// ---------------------------------------------------------------------------

const EventEnvelope = Schema.Struct({ ev: Schema.String });

export const KeybindActionEvent = Schema.Struct({
  ev: Schema.Literal("keybind"),
  action: Schema.String,
});

/**
 * Validates a raw event line against the PlatformEvent union and maps it to
 * the engine representation. Returns the mapped event, or a description of
 * why the message was invalid (never throws, never drops silently).
 */
const eventByKind: Record<string, Schema.Struct.Type<never>> = {
  topology_changed: Schema.Struct({ kind: Schema.Literal("topology_changed") }),
  window_added: Schema.Struct({
    kind: Schema.Literal("window_added"),
    window: WindowObservation,
  }),
  window_removed: Schema.Struct({
    kind: Schema.Literal("window_removed"),
    windowId: Schema.String,
  }),
  window_changed: Schema.Struct({
    kind: Schema.Literal("window_changed"),
    window: WindowObservation,
  }),
  focus_changed: Schema.Struct({
    kind: Schema.Literal("focus_changed"),
    windowId: Schema.NullOr(Schema.String),
  }),
  space_changed: Schema.Struct({ kind: Schema.Literal("space_changed") }),
  sleep: Schema.Struct({ kind: Schema.Literal("sleep") }),
  wake: Schema.Struct({ kind: Schema.Literal("wake") }),
};

export type ProtocolIssue = { readonly reason: string };

export function decodePlatformEvent(
  raw: unknown,
): Either.Either<PlatformEvent, ProtocolIssue> {
  const envelope = Schema.decodeUnknownEither(EventEnvelope)(raw);
  if (Either.isLeft(envelope)) {
    return Either.left({ reason: "not an event envelope" });
  }
  const name = envelope.right.ev;
  const schema = eventByKind[name];
  if (schema === undefined) {
    return Either.left({ reason: `unknown event "${name}"` });
  }
  // The sidecar emits `ev`; the engine union discriminates on `kind`.
  const payload: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? { ...raw } : {};
  delete payload.ev;
  payload.kind = name;
  // Runtime validation against the member schema; the result is asserted to
  // the engine's PlatformEvent union (the schema map above is exhaustive).
  const decoded = Schema.decodeUnknownEither(eventByKind[name] as never)(payload) as Either.Either<
    unknown,
    unknown
  >;
  if (Either.isLeft(decoded)) {
    return Either.left({ reason: `invalid "${name}" event payload` });
  }
  return Either.right(decoded.right as PlatformEvent);
}

// ---------------------------------------------------------------------------
// Error mapping: sidecar error strings → PlatformError codes (closed union).
// invalid_request/internal are host-side bugs surfaced as `unavailable`.
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "not_found",
  "not_controllable",
  "stale",
  "ambiguous",
  "rejected",
  "permission",
  "unavailable",
]);

export function mapErrorCode(code: string): string {
  return KNOWN_CODES.has(code) ? code : "unavailable";
}
