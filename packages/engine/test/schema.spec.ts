import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import type { StateSnapshot } from "../src/commands.ts";
import {
  Frame,
  GeometryRequest,
  PlatformEvent,
  Point,
  Size,
  WindowObservation,
} from "../src/schema.ts";
import {
  decodeWireMessage,
  encodeWireMessage,
  wireEvent,
  wireResponseError,
  wireResponseOk,
  wireSnapshot,
} from "../src/transport.ts";

const decoderOf = <A, I>(schema: Schema.Schema<A, I, never>) =>
  Schema.decodeUnknownSync(schema);

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
    expect(() =>
      decoderOf(WindowObservation)({ ...windowObservation(), pid: "4242" }),
    ).toThrow();
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
    expect(() =>
      decoderOf(WindowObservation)({ ...windowObservation(), subrole: 7 }),
    ).toThrow();
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
    expect(() =>
      decoderOf(PlatformEvent)({ kind: "focus_changed", windowId: 42 }),
    ).toThrow();
    expect(() => decoderOf(PlatformEvent)({ kind: "window_removed" })).toThrow();
    expect(() =>
      decoderOf(PlatformEvent)({ kind: "window_removed", windowId: 42 }),
    ).toThrow();
  });
});

describe("GeometryRequest boundaries", () => {
  test("attempts accepts the inclusive 1..5 integer range", () => {
    for (const attempts of [1, 2, 3, 4, 5]) {
      expect(decoderOf(GeometryRequest)({ windowId: "w", frame: FRAME, attempts }))
        .toHaveProperty("attempts", attempts);
    }
  });

  test("attempts rejects out-of-range and non-integer values", () => {
    for (const attempts of [0, -1, 6, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        decoderOf(GeometryRequest)({ windowId: "w", frame: FRAME, attempts }),
      ).toThrow();
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
      pendingTransactions: [
        { id: "tx-1", coalesceKey: "focus:win:abc123", submittedAt: 17 },
      ],
    };
    const envelope = wireSnapshot(snapshot);
    expect(decodeWireMessage(encodeWireMessage(envelope))).toEqual(envelope);
  });

  test("hand-written server frames decode", () => {
    expect(
      decodeWireMessage('{"v":1,"type":"request","id":"r1","command":{"type":"pause"}}'),
    ).toEqual({ v: 1, type: "request", id: "r1", command: { type: "pause" } });
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
      decodeWireMessage(
        '{"v":2,"type":"event","seq":0,"topic":"t","payload":null}',
      ),
    ).toThrow();
  });

  test("missing envelope fields are rejected", () => {
    expect(() => decodeWireMessage('{"v":1,"type":"request","id":"r1"}')).toThrow();
    expect(() =>
      decodeWireMessage('{"v":1,"type":"response","id":"r1","ok":false}'),
    ).toThrow();
    expect(() => decodeWireMessage('{"v":1,"type":"snapshot"}')).toThrow();
  });

  test("Schema.Unknown envelope fields are currently optional (transport gap)", () => {
    const okMissingData = decodeWireMessage(
      '{"v":1,"type":"response","id":"r1","ok":true}',
    );
    expect("data" in okMissingData).toBe(true);
    expect((okMissingData as { data?: unknown }).data).toBeUndefined();

    const eventMissingPayload = decodeWireMessage(
      '{"v":1,"type":"event","seq":0,"topic":"t"}',
    ) as { payload?: unknown };
    expect(eventMissingPayload.payload).toBeUndefined();

    expect(() =>
      decodeWireMessage('{"v":1,"type":"response","id":"r1","ok":true,"data":{"x":1}}'),
    ).not.toThrow();
  });

  test("invalid command discriminators inside requests are rejected", () => {
    expect(() =>
      decodeWireMessage(
        '{"v":1,"type":"request","id":"r1","command":{"type":"explode"}}',
      ),
    ).toThrow();
  });

  test("excess envelope properties are rejected", () => {
    expect(() =>
      decodeWireMessage(
        '{"v":1,"type":"event","seq":0,"topic":"t","payload":null,"extra":1}',
      ),
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
