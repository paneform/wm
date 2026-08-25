import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import type { Command, StateSnapshot } from "@wm/engine";
import { decodeWireMessage } from "@wm/engine";
import { createFileConfigSource } from "../src/config-file.ts";
import { attachWebSocketServer } from "../src/ws-server.ts";
import { clockNode } from "../src/clock-node.ts";
import WebSocket, { WebSocketServer } from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("daemon over the wire (node-host integration)", () => {
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
