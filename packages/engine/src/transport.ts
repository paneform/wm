import { Schema } from "effect";
import { Command } from "./commands.ts";
import { StateSnapshot } from "./commands.ts";
import { WIRE_PROTOCOL_VERSION } from "./constants.ts";

// Wire message envelopes — docs/rewrite/domain-schema.md §Wire protocol.
// JSON text frames; every message has { v, type } discriminator and is
// Schema-validated on receipt. Shared by CLI/WebSocket/renderer.

const V = Schema.Literal(WIRE_PROTOCOL_VERSION);

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

export const WireResponse = Schema.Union(
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
export type WireResponse = Schema.Schema.Type<typeof WireResponse>;

export const WireEvent = Schema.Struct({
  v: V,
  type: Schema.Literal("event"),
  seq: Schema.Number,
  topic: Schema.String,
  payload: Schema.Unknown,
});
export type WireEvent = Schema.Schema.Type<typeof WireEvent>;

/** Full committed state on subscribe or gap recovery. */
export const WireSnapshot = Schema.Struct({
  v: V,
  type: Schema.Literal("snapshot"),
  snapshot: StateSnapshot,
});
export type WireSnapshot = Schema.Schema.Type<typeof WireSnapshot>;

export const WireMessage = Schema.Union(
  WireRequest,
  WireResponse,
  WireEvent,
  WireSnapshot,
);
export type WireMessage = typeof WireMessage.Type;

export function encodeWireMessage(message: WireMessage): string {
  return JSON.stringify(message);
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

export function wireResponseOk(id: string, data: unknown): WireResponse {
  return { v: WIRE_PROTOCOL_VERSION, type: "response", id, ok: true, data };
}

export function wireResponseError(id: string, error: WireError): WireResponse {
  return { v: WIRE_PROTOCOL_VERSION, type: "response", id, ok: false, error };
}

export function wireEvent(seq: number, topic: string, payload: unknown): WireEvent {
  return { v: WIRE_PROTOCOL_VERSION, type: "event", seq, topic, payload };
}

export function wireSnapshot(snapshot: StateSnapshot): WireSnapshot {
  return { v: WIRE_PROTOCOL_VERSION, type: "snapshot", snapshot };
}
