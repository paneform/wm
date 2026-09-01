import { Schema } from "effect";
import { Command } from "./commands.js";
import { StateSnapshot } from "./commands.js";
import { WIRE_PROTOCOL_VERSION } from "./constants.js";
import { JsonSerializableValueSchema, JsonValueSchema, type JsonValue } from "./schema.js";

// Wire message envelopes — docs/rewrite/domain-schema.md §Wire protocol.
// JSON text frames; every message has { v, type } discriminator and is
// Schema-validated on receipt. Shared by CLI/WebSocket/renderer.

const V = Schema.Literal(WIRE_PROTOCOL_VERSION);

export type { JsonValue } from "./schema.js";

export const WireError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
export type WireError = typeof WireError.Type;

export const WireRequest = Schema.Struct({
  v: V,
  type: Schema.Literal("request"),
  id: Schema.String,
  command: Command,
});
export type WireRequest = Schema.Schema.Type<typeof WireRequest>;

export type WireResponse =
  | {
      readonly v: typeof WIRE_PROTOCOL_VERSION;
      readonly type: "response";
      readonly id: string;
      readonly ok: true;
      readonly data: unknown;
    }
  | {
      readonly v: typeof WIRE_PROTOCOL_VERSION;
      readonly type: "response";
      readonly id: string;
      readonly ok: false;
      readonly error: WireError;
    };

export const WireResponse: Schema.Schema<WireResponse> = Schema.Union(
  Schema.Struct({
    v: V,
    type: Schema.Literal("response"),
    id: Schema.String,
    ok: Schema.Literal(true),
    data: Schema.Unknown,
  }),
  Schema.Struct({
    v: V,
    type: Schema.Literal("response"),
    id: Schema.String,
    ok: Schema.Literal(false),
    error: WireError,
  }),
);

export interface WireEvent {
  readonly v: typeof WIRE_PROTOCOL_VERSION;
  readonly type: "event";
  readonly seq: number;
  readonly topic: string;
  readonly payload: unknown;
}

export const WireEvent: Schema.Schema<WireEvent> = Schema.Struct({
  v: V,
  type: Schema.Literal("event"),
  seq: Schema.Number,
  topic: Schema.String,
  payload: Schema.Unknown,
});

/** Full committed state on subscribe or gap recovery. */
export const WireSnapshot = Schema.Struct({
  v: V,
  type: Schema.Literal("snapshot"),
  snapshot: StateSnapshot,
});
export type WireSnapshot = Schema.Schema.Type<typeof WireSnapshot>;

export type WireMessage = WireRequest | WireResponse | WireEvent | WireSnapshot;
export const WireMessage: Schema.Schema<WireMessage> = Schema.Union(
  WireRequest,
  WireResponse,
  WireEvent,
  WireSnapshot,
);

export function encodeWireMessage(message: WireMessage): string {
  return JSON.stringify(Schema.decodeUnknownSync(JsonSerializableValueSchema)(message));
}

export function decodeWireMessage(text: string): WireMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid wire frame: not JSON (${String(error)})`);
  }
  return Schema.decodeUnknownSync(WireMessage, { onExcessProperty: "error" })(raw);
}

export function wireResponseOk<Input>(
  id: string,
  data: Input,
): Extract<WireResponse, { readonly ok: true }> {
  return {
    v: WIRE_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: true,
    data: Schema.decodeUnknownSync(JsonValueSchema)(data),
  };
}

export function wireResponseError(id: string, error: WireError): WireResponse {
  return { v: WIRE_PROTOCOL_VERSION, type: "response", id, ok: false, error };
}

export function wireEvent<Input>(seq: number, topic: string, payload: Input): WireEvent {
  return {
    v: WIRE_PROTOCOL_VERSION,
    type: "event",
    seq,
    topic,
    payload: Schema.decodeUnknownSync(JsonValueSchema)(payload),
  };
}

export function wireSnapshot(snapshot: StateSnapshot): WireSnapshot {
  return { v: WIRE_PROTOCOL_VERSION, type: "snapshot", snapshot };
}
