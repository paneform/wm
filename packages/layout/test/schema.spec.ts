import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import type { Command, StateSnapshot } from "../src/commands.ts";
import {
  Frame,
  GeometryRequest,
  PlatformEvent,
  Point,
  Size,
  WindowObservation,
  windowIdentityFingerprint,
  JsonValueSchema,
} from "../src/schema.ts";
import {
  decodeWireMessage,
  encodeWireMessage,
  wireEvent,
  wireResponseError,
  wireResponseOk,
  wireSnapshot,
  type JsonValue,
} from "../src/transport.ts";

const decoderOf = <A, I>(schema: Schema.Schema<A, I, never>) => Schema.decodeUnknownSync(schema);

const FRAME = { x: 0, y: 0, width: 800, height: 600 };

const CAPABILITIES = {
  movable: "supported",
  resizable: "supported",
  movableEvidence: "platform_report",
  resizableEvidence: "behavioral_probe",
} as const;

const windowObservation = () => ({
  id: "win:abc123",
  pid: 4242,
  role: "AXWindow",
  frame: FRAME,
  minimized: false,
  hidden: false,
  fullscreen: false,
  focused: true,
  capabilities: CAPABILITIES,
});

describe("primitive frame schemas", () => {
  test("valid point/size/frame decode unchanged", () => {
    expect(decoderOf(Point)({ x: -1920, y: 45 })).toEqual({ x: -1920, y: 45 });
    expect(decoderOf(Size)({ width: 1512, height: 982 })).toEqual({
      width: 1512,
      height: 982,
    });
    expect(decoderOf(Frame)(FRAME)).toEqual(FRAME);
  });

  test("missing or mistyped fields are rejected", () => {
    expect(() => decoderOf(Frame)({ x: 0, y: 0, width: 800 })).toThrow();
    expect(() => decoderOf(Frame)({ x: 0, y: 0, width: "800", height: 600 })).toThrow();
    expect(() => decoderOf(Point)({ x: 0 })).toThrow();
    expect(() => decoderOf(Point)({ x: true, y: 0 })).toThrow();
    expect(() => decoderOf(Size)({ width: 100, height: null })).toThrow();
  });
});

describe("WindowObservation boundaries", () => {
  test("identity fingerprint canonicalizes missing metadata as JSON null", () => {
    expect(windowIdentityFingerprint({ pid: 4242 })).toBe("[4242,null,null]");
    expect(windowIdentityFingerprint({ pid: 4242, role: "AXWindow" })).toBe(
      '[4242,"AXWindow",null]',
    );
    expect(windowIdentityFingerprint({ pid: 4242, role: null, subrole: null })).toBe(
      "[4242,null,null]",
    );
    expect(
      windowIdentityFingerprint({
        pid: 4242,
        role: "AXWindow",
        subrole: "AXStandardWindow",
      }),
    ).toBe('[4242,"AXWindow","AXStandardWindow"]');
  });

  test("a fully valid observation decodes", () => {
    const obs = windowObservation();
    expect(decoderOf(WindowObservation)(obs)).toEqual(obs);
  });

  test("capability state literals outside the closed union are rejected", () => {
    for (const bad of ["maybe", "yes", "", "SUPPORTED"]) {
      expect(() =>
        decoderOf(WindowObservation)({
          ...windowObservation(),
          capabilities: { ...CAPABILITIES, movable: bad },
        }),
      ).toThrow();
    }
  });

  test("evidence source literals outside the closed union are rejected", () => {
    expect(() =>
      decoderOf(WindowObservation)({
        ...windowObservation(),
        capabilities: { ...CAPABILITIES, resizableEvidence: "gut_feeling" },
      }),
    ).toThrow();
  });

  test("required structural fields are enforced", () => {
    const { role, ...withoutRole } = windowObservation();
    void role;
    expect(() => decoderOf(WindowObservation)(withoutRole)).toThrow();

    const { capabilities, ...withoutCapabilities } = windowObservation();
    void capabilities;
    expect(() => decoderOf(WindowObservation)(withoutCapabilities)).toThrow();

    expect(() =>
      decoderOf(WindowObservation)({
        ...windowObservation(),
        frame: { x: 0, y: 0, width: 800 },
      }),
    ).toThrow();
    expect(() => decoderOf(WindowObservation)({ ...windowObservation(), pid: "4242" })).toThrow();
    expect(() =>
      decoderOf(WindowObservation)({ ...windowObservation(), focused: "yes" }),
    ).toThrow();
  });

  test("optional fields validate when present", () => {
    expect(
      decoderOf(WindowObservation)({
        ...windowObservation(),
        constraints: { minWidth: 400 },
      }).constraints,
    ).toEqual({ minWidth: 400 });
    expect(() =>
      decoderOf(WindowObservation)({
        ...windowObservation(),
        constraints: { minWidth: "400" },
      }),
    ).toThrow();
    expect(() => decoderOf(WindowObservation)({ ...windowObservation(), subrole: 7 })).toThrow();
  });
});

describe("PlatformEvent union discriminators", () => {
  test("every documented kind decodes with valid payloads", () => {
    const events = [
      { kind: "topology_changed" },
      { kind: "window_added", window: windowObservation() },
      { kind: "window_removed", windowId: "win:gone" },
      { kind: "window_changed", window: windowObservation() },
      { kind: "focus_changed", windowId: "win:abc123" },
      { kind: "focus_changed", windowId: null },
      { kind: "space_changed" },
      { kind: "sleep" },
      { kind: "wake" },
    ];
    for (const event of events) {
      expect(decoderOf(PlatformEvent)(event)).toEqual(event);
    }
  });

  test("unknown kinds are rejected", () => {
    for (const kind of ["display_connected", "windows_changed", "tick", ""]) {
      expect(() => decoderOf(PlatformEvent)({ kind })).toThrow();
    }
  });

  test("payload shape must match the member struct", () => {
    expect(() => decoderOf(PlatformEvent)({ kind: "window_added" })).toThrow();
    expect(() =>
      decoderOf(PlatformEvent)({ kind: "window_added", window: { id: "win:x" } }),
    ).toThrow();
    expect(() => decoderOf(PlatformEvent)({ kind: "focus_changed" })).toThrow();
    expect(() => decoderOf(PlatformEvent)({ kind: "focus_changed", windowId: 42 })).toThrow();
    expect(() => decoderOf(PlatformEvent)({ kind: "window_removed" })).toThrow();
    expect(() => decoderOf(PlatformEvent)({ kind: "window_removed", windowId: 42 })).toThrow();
  });
});

describe("GeometryRequest boundaries", () => {
  test("attempts accepts the inclusive 1..5 integer range", () => {
    for (const attempts of [1, 2, 3, 4, 5]) {
      expect(decoderOf(GeometryRequest)({ windowId: "w", frame: FRAME, attempts })).toHaveProperty(
        "attempts",
        attempts,
      );
    }
  });

  test("attempts rejects out-of-range and non-integer values", () => {
    for (const attempts of [0, -1, 6, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decoderOf(GeometryRequest)({ windowId: "w", frame: FRAME, attempts })).toThrow();
    }
  });

  test("omitted optional fields remain omitted after decode", () => {
    const request = { windowId: "w", frame: FRAME };
    expect(decoderOf(GeometryRequest)(request)).toEqual(request);
  });

  test("tolerance must be a number when present", () => {
    expect(() =>
      decoderOf(GeometryRequest)({ windowId: "w", frame: FRAME, tolerance: "3" }),
    ).toThrow();
    expect(() =>
      decoderOf(GeometryRequest)({ windowId: "w", frame: FRAME, tolerance: null }),
    ).toThrow();
  });
});

describe("wire message round-trips", () => {
  test("request envelopes survive encode/decode unchanged", () => {
    const request = {
      v: 1,
      type: "request",
      id: "req-1",
      command: { type: "setWindowFrame", windowId: "win:abc123", frame: FRAME },
    } as const;
    expect(decodeWireMessage(encodeWireMessage(request))).toEqual(request);
  });

  test("successful responses survive encode/decode unchanged", () => {
    const response = wireResponseOk("req-2", { answer: 42, nested: { list: [1, 2] } });
    expect(decodeWireMessage(encodeWireMessage(response))).toEqual(response);
  });

  test("error responses survive encode/decode unchanged", () => {
    const response = wireResponseError("req-3", {
      code: "window_not_found",
      message: "unknown window win:nope",
    });
    expect(decodeWireMessage(encodeWireMessage(response))).toEqual(response);
  });

  test("event envelopes survive encode/decode unchanged", () => {
    const event = wireEvent(7, "topology", { displays: [] });
    expect(decodeWireMessage(encodeWireMessage(event))).toEqual(event);
  });

  test("snapshot envelopes survive encode/decode unchanged", () => {
    const snapshot: StateSnapshot = {
      epoch: 9,
      paused: false,
      health: "healthy",
      focusedWorkspace: "main",
      topology: [
        {
          id: "display:11111111-2222-3333-4444-555555555555",
          frame: { x: 0, y: 0, width: 1512, height: 982 },
          workArea: { x: 0, y: 38, width: 1512, height: 944 },
          scale: 2,
          primary: true,
        },
      ],
      windows: [
        {
          id: "win:abc123",
          pid: 4242,
          bundleId: "com.example.app",
          classification: "normal",
          managed: true,
          workspace: "main",
          floating: false,
          parked: false,
          frame: FRAME,
          capabilities: CAPABILITIES,
        },
      ],
      workspaces: [
        {
          name: "main",
          mode: "bsp",
          members: ["win:abc123"],
          floating: [],
          tree: { kind: "leaf", windowId: "win:abc123" },
          visibleOnDisplay: "display:11111111-2222-3333-4444-555555555555",
          preferredDisplay: null,
          pinnedDisplayOverride: null,
        },
      ],
      pendingTransactions: [{ id: "tx-1", coalesceKey: "focus:win:abc123", submittedAt: 17 }],
    };
    const envelope = wireSnapshot(snapshot);
    expect(decodeWireMessage(encodeWireMessage(envelope))).toEqual(envelope);

    const withUndefinedOptionals = wireSnapshot({
      ...snapshot,
      focusedWindow: undefined,
      windows: [{ ...snapshot.windows[0]!, title: undefined }],
    });
    const encoded = encodeWireMessage(withUndefinedOptionals);
    expect(encoded).not.toContain("focusedWindow");
    expect(encoded).not.toContain('"title"');
    expect(decodeWireMessage(encoded)).toEqual(envelope);
  });

  test("hand-written server frames decode", () => {
    expect(
      decodeWireMessage('{"v":1,"type":"request","id":"r1","command":{"type":"pause"}}'),
    ).toEqual({ v: 1, type: "request", id: "r1", command: { type: "pause" } });
  });
});

describe("JSON value boundaries", () => {
  test("accepts nested JSON values", () => {
    const value = { null: null, bool: true, number: 1.5, text: "x", nested: [1, { ok: false }] };
    expect(decoderOf(JsonValueSchema)(value)).toEqual(value);
    expect(wireResponseOk("json", value).data).toEqual(value);
    expect(wireEvent(1, "diagnostic", value).payload).toEqual(value);
  });

  test.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    () => undefined,
    Symbol("non-json"),
    1n,
    { omitted: undefined },
  ])("rejects non-JSON value %s", (value) => {
    expect(() => decoderOf(JsonValueSchema)(value)).toThrow();
    expect(() => wireResponseOk("json", value)).toThrow();
    expect(() => wireEvent(1, "diagnostic", value)).toThrow();
  });

  test.each([new Date("2026-01-01"), new (class Example {})()])(
    "rejects non-plain object %s directly and when nested",
    (value) => {
      expect(() => decoderOf(JsonValueSchema)(value)).toThrow();
      expect(() => decoderOf(JsonValueSchema)({ nested: [value] })).toThrow();
      expect(() =>
        encodeWireMessage({ v: 1, type: "response", id: "json", ok: true, data: value }),
      ).toThrow();
    },
  );

  test.each([
    [undefined],
    { nested: [undefined] },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: new Date("2026-01-01") },
    { value: new (class Example {})() },
  ])("encodeWireMessage rejects non-serializable value %s", (data) => {
    expect(() =>
      encodeWireMessage({ v: 1, type: "response", id: "json", ok: true, data }),
    ).toThrow();
  });

  test("accepts null-prototype dictionaries", () => {
    const value: Record<string, JsonValue> = Object.create(null);
    value.nested = [1, { ok: true }];
    expect(decoderOf(JsonValueSchema)(value)).toEqual(value);
  });
});

describe("hotkey parity commands — wire round-trips (bean wm-pmys)", () => {
  const requestEnvelope = (command: Command): string =>
    encodeWireMessage({
      v: 1,
      type: "request",
      id: "req-hotkey",
      command,
    });

  const rawRequestEnvelope = (command: JsonValue): string =>
    JSON.stringify({ v: 1, type: "request", id: "req-hotkey", command });

  test("every new hotkey command survives a wire encode/decode round-trip", () => {
    const commands = [
      { type: "togglePause" },
      { type: "moveFocusedWindowToWorkspace", workspace: "2" },
      { type: "moveFocusedWorkspaceToNextDisplay" },
      { type: "focusDirection", direction: "left" },
      { type: "moveDirection", direction: "up" },
    ] satisfies readonly Command[];
    for (const command of commands) {
      expect(decodeWireMessage(requestEnvelope(command))).toEqual({
        v: 1,
        type: "request",
        id: "req-hotkey",
        command,
      });
    }
  });

  test("direction literals outside the closed union are rejected", () => {
    for (const direction of ["diagonal", "LEFT", "", "north"]) {
      expect(() =>
        decodeWireMessage(rawRequestEnvelope({ type: "focusDirection", direction })),
      ).toThrow();
      expect(() =>
        decodeWireMessage(rawRequestEnvelope({ type: "moveDirection", direction })),
      ).toThrow();
    }
  });

  test("missing or excess fields are rejected on the wire", () => {
    expect(() =>
      decodeWireMessage(rawRequestEnvelope({ type: "togglePause", extra: 1 })),
    ).toThrow();
    expect(() =>
      decodeWireMessage(rawRequestEnvelope({ type: "moveFocusedWindowToWorkspace" })),
    ).toThrow();
    expect(() => decodeWireMessage(rawRequestEnvelope({ type: "focusDirection" }))).toThrow();
  });
});

describe("wire decode rejections", () => {
  test("non-JSON garbage is rejected", () => {
    expect(() => decodeWireMessage("hello")).toThrow(/invalid wire frame/);
  });

  test("malformed JSON is rejected", () => {
    expect(() => decodeWireMessage('{"v":1,"type":')).toThrow(/invalid wire frame/);
  });

  test("unknown type discriminators are rejected", () => {
    expect(() => decodeWireMessage('{"v":1,"type":"bogus"}')).toThrow();
  });

  test("wrong protocol version is rejected", () => {
    expect(() =>
      decodeWireMessage('{"v":2,"type":"event","seq":0,"topic":"t","payload":null}'),
    ).toThrow();
  });

  test("missing envelope fields are rejected", () => {
    expect(() => decodeWireMessage('{"v":1,"type":"request","id":"r1"}')).toThrow();
    expect(() => decodeWireMessage('{"v":1,"type":"response","id":"r1","ok":false}')).toThrow();
    expect(() => decodeWireMessage('{"v":1,"type":"snapshot"}')).toThrow();
  });

  test("unknown envelope fields preserve their established decode behavior", () => {
    const response = decodeWireMessage('{"v":1,"type":"response","id":"r1","ok":true}');
    expect(response).toHaveProperty("data", undefined);
    expect(decodeWireMessage(encodeWireMessage(response))).toEqual(response);
    const event = decodeWireMessage('{"v":1,"type":"event","seq":0,"topic":"t"}');
    expect(event).toHaveProperty("payload", undefined);
    expect(decodeWireMessage(encodeWireMessage(event))).toEqual(event);
    expect(() =>
      decodeWireMessage('{"v":1,"type":"response","id":"r1","ok":true,"data":{"x":1}}'),
    ).not.toThrow();
  });

  test("invalid command discriminators inside requests are rejected", () => {
    expect(() =>
      decodeWireMessage('{"v":1,"type":"request","id":"r1","command":{"type":"explode"}}'),
    ).toThrow();
  });

  test("excess envelope properties are rejected", () => {
    expect(() =>
      decodeWireMessage('{"v":1,"type":"event","seq":0,"topic":"t","payload":null,"extra":1}'),
    ).toThrow();
  });

  test("response ok/error variants cannot be mixed", () => {
    expect(() =>
      decodeWireMessage(
        '{"v":1,"type":"response","id":"r1","ok":true,"error":{"code":"x","message":"y"}}',
      ),
    ).toThrow();
    expect(() =>
      decodeWireMessage('{"v":1,"type":"response","id":"r1","ok":false,"data":1}'),
    ).toThrow();
  });
});
