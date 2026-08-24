#!/usr/bin/env node
import { Effect, Exit } from "effect";
import { createEngine } from "@wm/engine";
import { attachWebSocketServer } from "./ws-server.ts";
import { clockNode } from "./clock-node.ts";
import { createFileConfigSource, resolveConfigPath } from "./config-file.ts";
import { parseArgs, USAGE } from "./cli-args.ts";

const DEFAULT_PORT = 17832;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help || (parsed.command === null && !parsed.serve)) {
    console.log(USAGE);
    return parsed.help ? 0 : parsed.command === null && !parsed.serve ? 1 : 0;
  }

  const port = Number(parsed.flags["port"] ?? DEFAULT_PORT);

  if (!parsed.serve) {
    // Client mode: one request over the daemon's WebSocket, print JSON.
    const { WebSocket } = await import("ws");
    const url = String(parsed.flags["url"] ?? `ws://127.0.0.1:${port}`);
    const socket = new WebSocket(url);
    const result = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon connection timed out")), 5000);
      socket.on("open", () => {
        socket.send(
          JSON.stringify({ v: 1, type: "request", id: crypto.randomUUID(), command: parsed.command }),
        );
      });
      socket.on("message", (raw) => {
        clearTimeout(timer);
        resolve(String(raw));
      });
      socket.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    socket.close();
    const message = JSON.parse(result) as { ok: boolean };
    console.log(JSON.stringify(message, null, 2));
    return message.ok ? 0 : 1;
  }

  // Daemon mode: engine + macOS adapter + config watcher + WebSocket server.
  const platform = await import("@wm/platform-macos");
  const adapter = await Effect.runPromise(platform.createMacOsSidecarAdapter({}));
  const configSource = createFileConfigSource(resolveConfigPath());
  const engine = await Effect.runPromise(createEngine({ adapter, configSource, clock: clockNode }));
  await Effect.runPromise(engine.start());

  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  attachWebSocketServer(server, {
    handle: async (command) => {
      const exit = await Effect.runPromiseExit(engine.execute(command));
      if (Exit.isSuccess(exit)) return { ok: true, data: exit.value };
      throw exit.cause;
    },
    snapshot: () => Effect.runPromise(engine.state()),
    events: () => engine.events(),
  });
  console.log(JSON.stringify({ ready: true, port }));
  return await new Promise(() => {});
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
