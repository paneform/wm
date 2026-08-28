import { describe, expect, test } from "vitest";
import { Effect, Exit, Stream } from "effect";
import { PassThrough } from "node:stream";
import { createMacOsSidecarAdapter } from "../src/host.ts";
import type { SidecarProcess, SpawnSidecar } from "../src/sidecar-process.ts";
import { inheritedStdioSpawn } from "../src/sidecar-process.ts";

/**
 * Headless fake of the wm-sidecar wire behavior: echoes protocol results for
 * every op so adapter semantics are exercised without spawning Swift.
 */
interface FakeSidecar {
  readonly requests: Array<{ op: string; reqId?: string } & Record<string, unknown>>;
  readonly overrides: Map<string, (reqId: string) => unknown>;
  emit(message: unknown): void;
}

const makeSpawn = (): { spawn: SpawnSidecar; fake: FakeSidecar } => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: FakeSidecar["requests"] = [];
  const overrides = new Map<string, (reqId: string) => unknown>();
  const exitListeners: Array<(code: number | null) => void> = [];

  const emit = (message: unknown) => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  stdin.on("data", (chunk) => {
    for (const raw of String(chunk).split("\n")) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      const message = JSON.parse(trimmed) as { op: string; reqId?: string } & Record<string, unknown>;
      requests.push(message);
      const reqId = message.reqId ?? "";
      if (overrides.has(message.op)) {
        emit(overrides.get(message.op)!(reqId));
        continue;
      }
      switch (message.op) {
        case "subscribe":
          emit({ reqId, result: { subscribed: true } });
          break;
        case "permissionsStatus":
          emit({
            reqId,
            result: { permissions: { accessibility: true, screenRecording: false } },
          });
          break;
        case "requestPermissions":
          emit({
            reqId,
            result: { permissions: { accessibility: true, screenRecording: true } },
          });
          break;
        case "openPermissionsSettings":
          emit({ reqId, result: { opened: true } });
          break;
        case "configureKeybinds":
          emit({ reqId, result: { configured: Object.keys(message.keybinds as object).length } });
          break;
        case "focusWindow":
          emit({ reqId, result: { frontmostPid: 42, focused: true, main: true } });
          break;
        case "setWindowFrame": {
          const frame = message.frame as { x: number; y: number; width: number; height: number };
          emit({ reqId, result: { requested: frame, observed: frame, stable: true } });
          break;
        }
        case "executeBatch": {
          const operations = message.operations as Array<Record<string, unknown>>;
          emit({
            reqId,
            result: {
              operations: operations.map((operation) => ({
                operationId: operation.operationId,
                ...(operation.kind === "setFrame"
                  ? { requested: operation.frame, observed: operation.frame, stable: true }
                  : {}),
              })),
              completed: operations.length,
              failed: 0,
            },
          });
          break;
        }
      }
    }
  });

  const proc: SidecarProcess = {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    kill() {
      for (const listener of [...exitListeners]) listener(0);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
  };

  return { spawn: () => proc, fake: { requests, overrides, emit } };
};

const READY = {
  ready: true as const,
  version: "wm-sidecar test",
  accessibility: false,
  screenRecording: false,
};

describe("MacOsSidecarAdapter permission ops", () => {
  test("native-parent transport uses inherited protocol streams without spawning", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({
      spawn: inheritedStdioSpawn(input, output),
      sidecarPath: "native-host",
    }));
    input.write(`${JSON.stringify(READY)}\n`);
    expect((await adapter.whenReady).version).toBe("wm-sidecar test");

    const request = new Promise<{ reqId: string }>((resolve) => {
      output.on("data", (chunk) => {
        for (const line of String(chunk).trim().split("\n")) {
          const value = JSON.parse(line) as { op: string; reqId: string };
          if (value.op === "permissionsStatus") resolve(value);
        }
      });
    });
    const status = Effect.runPromise(adapter.permissionsStatus());
    const { reqId } = await request;
    input.write(`${JSON.stringify({
      reqId,
      result: { permissions: { accessibility: true, screenRecording: true } },
    })}\n`);
    await expect(status).resolves.toEqual({ accessibility: true, screenRecording: true });
    adapter.stop();
  });
  test("configures native keybinds and exposes matching actions", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    fake.emit(READY);
    await Effect.runPromise(adapter.configureKeybinds({ "rshift s": "workspace focus S" }));
    expect(fake.requests.find((request) => request.op === "configureKeybinds")).toMatchObject({
      keybinds: { "rshift s": "workspace focus S" },
    });
    const actions: string[] = [];
    Effect.runFork(Stream.runForEach(Stream.take(adapter.keybindActions, 1), (action) =>
      Effect.sync(() => actions.push(action)),
    ));
    fake.emit({ ev: "keybind", action: "workspace focus S" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(actions).toEqual(["workspace focus S"]);
    adapter.stop();
  });
  test("compound mutations use one sidecar request with ordered results", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    fake.emit(READY);
    const frame = { x: 1, y: 2, width: 300, height: 200 };
    const result = await Effect.runPromise(adapter.executeBatch!({ operations: [
      { operationId: "reveal", kind: "setFrame", windowId: "w1", frame, expectedIdentity: { fingerprint: "id1" } },
      { operationId: "focus", kind: "focus", windowId: "w1", expectedIdentity: { fingerprint: "id1" }, dependsOn: ["reveal"] },
    ] }));

    expect(fake.requests.filter((request) => request.op === "executeBatch")).toHaveLength(1);
    expect(fake.requests.filter((request) => request.op === "setWindowFrame" || request.op === "focusWindow")).toHaveLength(0);
    expect(result.operations.map((operation) => operation.operationId)).toEqual(["reveal", "focus"]);
    adapter.stop();
  });
  test("batch results preserve native errors and observations for engine policy", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    fake.emit(READY);
    fake.overrides.set("executeBatch", (reqId) => ({
      reqId,
      result: {
        operations: [
          {
            operationId: "resize",
            requested: { x: 0, y: 32, width: 1512, height: 950 },
            observed: { x: 0, y: 32, width: 723, height: 950 },
            stable: true,
            stableReads: 3,
            error: { code: "rejected", detail: "AX size rejected" },
          },
          {
            operationId: "focus",
            frontmostPid: 99,
            focused: true,
            main: true,
            error: { code: "rejected", detail: "frontmost check rejected" },
          },
        ],
        completed: 0,
        failed: 2,
      },
    }));

    const result = await Effect.runPromise(adapter.executeBatch!({ operations: [
      {
        operationId: "resize",
        kind: "setFrame",
        windowId: "w1",
        frame: { x: 0, y: 32, width: 1512, height: 950 },
        expectedIdentity: { fingerprint: "id1" },
      },
      {
        operationId: "focus",
        kind: "focus",
        windowId: "w1",
        expectedIdentity: { fingerprint: "id1" },
        dependsOn: ["resize"],
      },
    ] }));

    expect(result.operations[0]).toMatchObject({
      observed: { x: 0, width: 723 },
      stableReads: 3,
      error: { code: "rejected" },
    });
    expect(result.operations[1]).toMatchObject({
      focused: true,
      main: true,
      error: { code: "rejected" },
    });
    adapter.stop();
  });
  test("handshake resolves whenReady and triggers subscribe", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/fake/wm-sidecar" }));
    fake.emit(READY);

    expect(await adapter.whenReady).toEqual({
      version: "wm-sidecar test",
      accessibility: false,
      screenRecording: false,
    });
    expect(adapter.sidecarPath).toBe("/fake/wm-sidecar");
    expect(adapter.whenExited).toBeInstanceOf(Promise);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.requests.map((r) => r.op)).toContain("subscribe");
    adapter.stop();
  });

  test("permissionsStatus decodes the wrapped snapshot", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    fake.emit(READY);

    const status = await Effect.runPromise(adapter.permissionsStatus());
    expect(status).toEqual({ accessibility: true, screenRecording: false });
    const sent = fake.requests.find((r) => r.op === "permissionsStatus");
    expect(sent?.reqId).toMatch(/^r\d+$/);
    adapter.stop();
  });

  test("requestPermissions returns post-prompt statuses", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    fake.emit(READY);

    const status = await Effect.runPromise(adapter.requestPermissions());
    expect(status).toEqual({ accessibility: true, screenRecording: true });
    expect(fake.requests.some((r) => r.op === "requestPermissions")).toBe(true);
    adapter.stop();
  });

  test("openPermissionsSettings forwards the target pane", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    fake.emit(READY);

    await Effect.runPromise(adapter.openPermissionsSettings("accessibility"));
    expect(fake.requests.find((r) => r.op === "openPermissionsSettings")).toMatchObject({
      target: "accessibility",
    });
    adapter.stop();
  });

  test("invalid permission result fails structured, never silent", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    fake.emit(READY);
    fake.overrides.set("permissionsStatus", (reqId) => ({
      reqId,
      result: { permissions: { accessibility: "yes" } },
    }));

    const issues: string[] = [];
    Effect.runFork(
      Stream.runForEach(Stream.take(adapter.protocolErrors, 1), (issue) =>
        Effect.sync(() => issues.push(issue)),
      ),
    );

    const exit = await Effect.runPromiseExit(adapter.permissionsStatus());
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause;
      expect(String(failure)).toContain("unavailable");
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(issues.join("\n")).toContain("invalid permissionsStatus result");
    adapter.stop();
  });

  test("sidecar error envelopes map onto PlatformError codes", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    fake.emit(READY);
    fake.overrides.set("requestPermissions", (reqId) => ({
      reqId,
      error: { code: "permission", detail: "prompt refused" },
    }));

    const exit = await Effect.runPromiseExit(adapter.requestPermissions());
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("permission");
    }
    adapter.stop();
  });

  test("requests fail after stop", async () => {
    const { spawn } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    adapter.stop();
    await expect(adapter.whenExited).resolves.toBe(0);
    const exit = await Effect.runPromiseExit(adapter.permissionsStatus());
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("MacOsSidecarAdapter geometry wire shape", () => {
  test("classified write failures retain requested and observed frames", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    fake.emit(READY);
    fake.overrides.set("setWindowFrame", (reqId) => ({
      reqId,
      result: {
        requested: { x: 20, y: 52, width: 800, height: 600 },
        observed: { x: 10, y: 40, width: 700, height: 500 },
        stable: false,
        errorKind: "not_controllable",
      },
    }));

    const result = await Effect.runPromise(
      adapter.setWindowPosition("window:cg:37", { x: 20, y: 52 }),
    );
    expect(result).toEqual({
      requested: { x: 20, y: 52, width: 800, height: 600 },
      observed: { x: 10, y: 40, width: 700, height: 500 },
      stable: false,
      errorKind: "not_controllable",
    });
    adapter.stop();
  });

  test("position and size writes send complete FrameValue payloads", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    fake.emit(READY);

    await Effect.runPromise(adapter.setWindowPosition("window:cg:1", { x: 20, y: 52 }));
    await Effect.runPromise(adapter.setWindowSize("window:cg:1", { width: 800, height: 600 }));

    const writes = fake.requests.filter((r) => r.op === "setWindowFrame");
    expect(writes[0]).toMatchObject({
      mode: "position",
      frame: { x: 20, y: 52, width: 0, height: 0 },
    });
    expect(writes[1]).toMatchObject({
      mode: "size",
      frame: { x: 0, y: 0, width: 800, height: 600 },
    });
    adapter.stop();
  });

  test("expectedIdentity fingerprint rides the wire on guarded writes (round 3 issue 3)", async () => {
    const { spawn, fake } = makeSpawn();
    const adapter = Effect.runSync(createMacOsSidecarAdapter({ spawn, sidecarPath: "/x" }));
    fake.emit(READY);

    // REQUIRED-NULLABLE semantics collapse into one exact fingerprint token:
    // subrole is always present as null or the real value.
    const expected = {
      fingerprint: JSON.stringify([4242, "AXWindow", null]),
    };
    await Effect.runPromise(
      adapter.setWindowFrame("window:cg:9", { x: 5, y: 6, width: 7, height: 8 }, expected),
    );
    await Effect.runPromise(
      adapter.setWindowPosition("window:cg:9", { x: 9, y: 10 }, expected),
    );
    await Effect.runPromise(
      adapter.setWindowSize("window:cg:9", { width: 11, height: 12 }, expected),
    );

    const guardedWrites = fake.requests.filter((r) => r.op === "setWindowFrame");
    expect(guardedWrites.map(({ mode, expectedIdentity }) => ({ mode, expectedIdentity }))).toEqual([
      { mode: "frame", expectedIdentity: { fingerprint: '[4242,"AXWindow",null]' } },
      { mode: "position", expectedIdentity: { fingerprint: '[4242,"AXWindow",null]' } },
      { mode: "size", expectedIdentity: { fingerprint: '[4242,"AXWindow",null]' } },
    ]);

    // Omitted precondition stays absent on the wire.
    await Effect.runPromise(adapter.setWindowSize("window:cg:9", { width: 9, height: 10 }));
    const unguarded = fake.requests.filter((r) => r.op === "setWindowFrame").at(-1);
    expect("expectedIdentity" in (unguarded ?? {})).toBe(false);
    adapter.stop();
  });
});
