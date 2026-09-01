import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import { CommandError, type Command, type StateSnapshot } from "@paneform/layout";
import { decodeWireMessage } from "@paneform/layout";
import { createFileConfigSource } from "../src/config-file.ts";
import { attachWebSocketServer } from "../src/ws-server.ts";
import { clockNode } from "../src/clock-node.ts";
import { executeEngineCommand } from "../src/command-handler.ts";
import WebSocket, { WebSocketServer } from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("daemon over the wire (node-host integration)", () => {
  test("engine command result is wrapped exactly once by the wire response", async () => {
    const result = { type: "ok" as const, detail: "resumed" };
    const engine = { execute: () => Effect.succeed(result) };

    await expect(executeEngineCommand(engine, { type: "resume" })).resolves.toEqual(result);
  });

  test("engine command failures retain their typed wire error", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const engine = {
      execute: () => Effect.fail(new CommandError({ code: "paused", message: "engine is paused" })),
    };
    attachWebSocketServer(server, {
      handle: (command) => executeEngineCommand(engine, command),
      snapshot: async () => ({ epoch: 0 }) as unknown as StateSnapshot,
      events: () => Stream.empty,
    });
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve) => client.on("open", resolve));

    const reply = await new Promise<string>((resolve, reject) => {
      client.on("message", (raw) => resolve(String(raw)));
      client.on("error", reject);
      client.send(JSON.stringify({ v: 1, type: "request", id: "fail", command: { type: "resume" } }));
    });

    expect(JSON.parse(reply)).toMatchObject({
      ok: false,
      error: { code: "paused", message: "engine is paused" },
    });
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("request → response envelope round-trip through a stub handle", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const url = `ws://127.0.0.1:${address.port}`;

    attachWebSocketServer(server, {
      handle: async (command: Command) => ({ echoed: command.type }),
      snapshot: async () => ({ epoch: 0 }) as unknown as StateSnapshot,
      events: () => Stream.empty,
    });

    const client = new WebSocket(url);
    await new Promise<void>((resolve) => client.on("open", resolve));

    const reply = await new Promise<string>((resolve, reject) => {
      client.on("message", (raw) => resolve(String(raw)));
      client.on("error", reject);
      client.send(
        JSON.stringify({ v: 1, type: "request", id: "r1", command: { type: "getState" } }),
      );
    });
    const decoded = decodeWireMessage(reply);
    expect(decoded.type).toBe("response");
    if (decoded.type === "response" && decoded.ok) {
      expect((decoded.data as { echoed: string }).echoed).toBe("getState");
    } else {
      throw new Error("expected ok response");
    }

    // Malformed inbound gets a structured error response (never a crash).
    const bad = await new Promise<string>((resolve) => {
      client.once("message", (raw) => resolve(String(raw)));
      client.send("not json at all");
    });
    expect(JSON.parse(bad)).toMatchObject({ ok: false, error: { code: "invalid_request" } });

    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("hotkey parity commands ride the shared Command wire schema (bean wm-pmys)", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const url = `ws://127.0.0.1:${address.port}`;

    attachWebSocketServer(server, {
      handle: async (command: Command) => ({ echoed: command.type, command }),
      snapshot: async () => ({ epoch: 0 }) as unknown as StateSnapshot,
      events: () => Stream.empty,
    });

    const commands = [
      { type: "togglePause" },
      { type: "moveFocusedWindowToWorkspace", workspace: "2" },
      { type: "moveFocusedWorkspaceToNextDisplay" },
      { type: "focusDirection", direction: "left" },
      { type: "moveDirection", direction: "down" },
    ];

    for (const [index, command] of commands.entries()) {
      const client = new WebSocket(url);
      await new Promise<void>((resolve) => client.on("open", resolve));
      const reply = await new Promise<string>((resolve, reject) => {
        client.on("message", (raw) => resolve(String(raw)));
        client.on("error", reject);
        client.send(
          JSON.stringify({ v: 1, type: "request", id: `hk-${index}`, command }),
        );
      });
      client.close();
      const decoded = decodeWireMessage(reply);
      expect(decoded.type).toBe("response");
      if (decoded.type !== "response" || !decoded.ok) throw new Error("expected ok response");
      expect((decoded.data as { echoed: string }).echoed).toBe(command.type);
    }

    // An invalid direction literal is rejected at the schema boundary.
    const client = new WebSocket(url);
    await new Promise<void>((resolve) => client.on("open", resolve));
    const badReply = await new Promise<string>((resolve, reject) => {
      client.on("message", (raw) => resolve(String(raw)));
      client.on("error", reject);
      client.send(
        JSON.stringify({
          v: 1,
          type: "request",
          id: "hk-bad",
          command: { type: "focusDirection", direction: "diagonal" },
        }),
      );
    });
    client.close();
    expect(JSON.parse(badReply)).toMatchObject({ ok: false, error: { code: "invalid_request" } });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("limit probe command and structured result round-trip over the wire", () => {
    const request = decodeWireMessage(JSON.stringify({
      v: 1,
      type: "request",
      id: "probe-1",
      command: { type: "probeWindowLimits", windowId: "window:1" },
    }));
    expect(request).toMatchObject({ command: { type: "probeWindowLimits", windowId: "window:1" } });

    const result = {
      type: "windowLimitsProbe",
      windowId: "window:1",
      identity: "[1,\"AXWindow\",null]",
      originalFrame: { x: 10, y: 20, width: 800, height: 600 },
      restoredFrame: { x: 10, y: 20, width: 800, height: 600 },
      testedRanges: { width: { min: 1, max: 1512 }, height: { min: 1, max: 944 } },
      findings: {
        minWidth: { kind: "exact", value: 320 },
        minHeight: { kind: "exact", value: 200 },
        maxWidth: { kind: "noClampThrough", value: 1512 },
        maxHeight: { kind: "exact", value: 800 },
      },
      profileUpdated: true,
    };
    const response = decodeWireMessage(JSON.stringify({
      v: 1,
      type: "response",
      id: "probe-1",
      ok: true,
      data: result,
    }));
    expect(response).toMatchObject({ ok: true, data: result });
  });

  test("config source parses JSONC through the engine boundary", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-engine-host-"));
    const file = path.join(dir, "config.jsonc");
    fs.writeFileSync(file, '{ /* c */ "gap": 8, "workspaces": [] }\n');
    const source = createFileConfigSource(file);
    expect(await Effect.runPromise(source.load())).toEqual({ gap: 8, workspaces: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("real clock sleeps without error (sanity)", async () => {
    await Effect.runPromise(clockNode.sleep(1));
    expect(clockNode.now()).toBeGreaterThan(0);
  });
});
