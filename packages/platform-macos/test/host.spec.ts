import { describe, expect, test } from "vitest";
import { Effect, Exit, Stream } from "effect";
import { PassThrough } from "node:stream";
import { createMacOsSidecarAdapter } from "../src/host.ts";
import type { SidecarProcess, SpawnSidecar } from "../src/sidecar-process.ts";

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
        case "setWindowFrame": {
          const frame = message.frame as { x: number; y: number; width: number; height: number };
          emit({ reqId, result: { requested: frame, observed: frame, stable: true } });
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
    const exit = await Effect.runPromiseExit(adapter.permissionsStatus());
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("MacOsSidecarAdapter geometry wire shape", () => {
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
});
