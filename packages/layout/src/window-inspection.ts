import { Schema } from "effect";
import { JsonValueSchema, WindowObservation } from "./schema.js";

export const AXQueryResult = Schema.Struct({
  scope: Schema.Literal("window", "application", "system"),
  attribute: Schema.String,
  errorCode: Schema.Int,
  errorName: Schema.String,
  valueType: Schema.String,
  value: JsonValueSchema,
}).pipe(
  Schema.filter(
    (query) => query.errorCode === 0 || (query.value === null && query.valueType === "none"),
    { message: () => "failed AX queries must not carry a usable value" },
  ),
);
export interface AXQueryResult extends Schema.Schema.Type<typeof AXQueryResult> {}

const AXRawWindow = Schema.Struct({
  index: Schema.Int,
  identity: Schema.Struct({
    pid: Schema.NullOr(Schema.Int),
    pidErrorCode: Schema.Int,
    matchesTarget: Schema.Boolean,
  }),
  queries: Schema.Array(AXQueryResult),
});

export const WindowDiagnostics = Schema.Struct({
  platform: Schema.Literal("macos-ax"),
  capturedAt: Schema.String,
  observer: Schema.Struct({
    pid: Schema.Int,
    bundleId: Schema.NullOr(Schema.String),
    accessibility: Schema.Boolean,
    screenRecording: Schema.Boolean,
  }),
  target: Schema.Struct({
    windowId: Schema.NullOr(Schema.String),
    pid: Schema.NullOr(Schema.Int),
    registered: Schema.Boolean,
    activationPolicy: Schema.NullOr(Schema.Int),
    active: Schema.NullOr(Schema.Boolean),
    hidden: Schema.NullOr(Schema.Boolean),
  }),
  nsFrontmostPidBefore: Schema.NullOr(Schema.Int),
  nsFrontmostPidAfter: Schema.NullOr(Schema.Int),
  resolutionError: Schema.NullOr(Schema.String),
  queries: Schema.Array(AXQueryResult),
  rawWindows: Schema.optional(Schema.Array(AXRawWindow)),
});
export interface WindowDiagnostics extends Schema.Schema.Type<typeof WindowDiagnostics> {}

export const WindowInspection = Schema.Struct({
  window: Schema.NullOr(WindowObservation),
  diagnostics: Schema.optional(WindowDiagnostics),
});
export interface WindowInspection extends Schema.Schema.Type<typeof WindowInspection> {}
