#!/usr/bin/env node
import { Effect, Stream } from "effect";
import { ConfigInvalidError, createEngine, type Command } from "@wm/engine";
import type { MacOsSidecarAdapter } from "@wm/platform-macos";
import { attachWebSocketServer } from "./ws-server.ts";
import { clockNode } from "./clock-node.ts";
import { executeEngineCommand } from "./command-handler.ts";
import { createFileConfigSource, resolveConfigPath } from "./config-file.ts";
import { buildKeybindCommand, parseArgs, USAGE } from "./cli-args.ts";
import {
  errorReport,
  exitCodeFor,
  runPermissionFlow,
  type PermissionClient,
  type PermissionCommand,
} from "./permissions.ts";

const DEFAULT_PORT = 17832;

/** Bridge the effect-based sidecar adapter onto the promise-shaped client
 * used by local permission workflows (injectable for tests). */
export const adapterToPermissionClient = (adapter: MacOsSidecarAdapter): PermissionClient => ({
  sidecarPath: adapter.sidecarPath,
  whenReady: adapter.whenReady,
  permissionsStatus: () => Effect.runPromise(adapter.permissionsStatus()),
  requestPermissions: () => Effect.runPromise(adapter.requestPermissions()),
  openSettings: (target) => Effect.runPromise(adapter.openPermissionsSettings(target)),
  stop: () => adapter.stop(),
});

const printReport = (report: unknown): void => {
  console.log(JSON.stringify(report, null, 2));
};

/** `wm doctor` / `wm permissions request`: spawn the sidecar directly — the
 * daemon WebSocket is never contacted and the engine is never started. */
async function runPermissionsCommand(
  command: PermissionCommand,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const { createMacOsSidecarAdapter } = await import("@wm/platform-macos");
  const requestedPath = flags["sidecar"];
  const sidecarOptions =
    typeof requestedPath === "string" && requestedPath.length > 0 ? { sidecarPath: requestedPath } : {};
  try {
    const adapter = await Effect.runPromise(createMacOsSidecarAdapter(sidecarOptions));
    const report = await runPermissionFlow(command, adapterToPermissionClient(adapter), {
      openSettingsAfterRequest: flags["open-settings"] === true,
    });
    printReport(report);
    return exitCodeFor(report);
  } catch (cause) {
    printReport(errorReport(command, cause));
    return 1;
  }
}

/** Daemon startup gate: Accessibility is required; Screen Recording degrades.
 * Fails BEFORE engine.start so a half-permissioned daemon never runs. */
async function gateDaemonPermissions(adapter: MacOsSidecarAdapter): Promise<number> {
  const ready = await adapter.whenReady;
  if (!ready.accessibility) {
    adapter.stop();
    console.error(JSON.stringify({
      ready: false,
      error: {
        code: "permission",
        message: "Accessibility is not granted to wm-sidecar; the daemon cannot observe or manage windows.",
        remediation: 'Run "wm permissions request" and approve the prompt, then restart "wm serve".',
      },
    }));
    return 1;
  }
  if (!ready.screenRecording) {
    console.error(JSON.stringify({
      warning: {
        code: "permission_degraded",
        message: "Screen Recording is not granted; window titles and off-process app names degrade.",
        remediation: 'Optional: run "wm permissions request" or open System Settings > Privacy & Security > Screen Recording.',
      },
    }));
  }
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help || (parsed.command === null && !parsed.serve && parsed.localCommand === null)) {
    console.log(USAGE);
    return parsed.help ? 0 : parsed.command === null && !parsed.serve ? 1 : 0;
  }
  if (parsed.localCommand !== null) {
    return runPermissionsCommand(parsed.localCommand, parsed.flags);
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
  const nativeStdio = process.env["WM_NATIVE_STDIO"] === "1";
  const { WebSocketServer } = await import("ws");
  const server = await new Promise<InstanceType<typeof WebSocketServer>>((resolve, reject) => {
    const candidate = new WebSocketServer({
      host: "127.0.0.1",
      port,
      maxPayload: 64 * 1024,
      verifyClient: (info: { origin?: string }) => info.origin === undefined,
    });
    candidate.once("listening", () => resolve(candidate));
    candidate.once("error", reject);
  });
  const platform = await import("@wm/platform-macos");
  const requestedSidecar = parsed.flags["sidecar"];
  const adapter = await Effect.runPromise(
    platform.createMacOsSidecarAdapter(
      nativeStdio
        ? { sidecarPath: "native-host", spawn: platform.inheritedStdioSpawn() }
        : typeof requestedSidecar === "string" && requestedSidecar.length > 0
        ? { sidecarPath: requestedSidecar }
        : {},
    ),
  );
  if ((await gateDaemonPermissions(adapter)) !== 0) {
    server.close();
    return 1;
  }
  let keybindCommands = new Map<string, Command>();
  let nativeConfigReady = false;
  const configSource = createFileConfigSource(resolveConfigPath(), (config) => {
    const keybinds = config.keybinds ?? {};
    return Effect.gen(function* () {
      const commands = yield* Effect.try({
        try: () => new Map(Object.values(keybinds).map((action) => {
          const command = buildKeybindCommand(action);
          if (command === null) throw new Error(`invalid keybind action: ${action}`);
          return [action, command] as const;
        })),
        catch: (error) => new ConfigInvalidError([String(error)]),
      });
      yield* adapter.configureKeybinds(keybinds).pipe(
        Effect.mapError((error) => new ConfigInvalidError([String(error)])),
      );
      keybindCommands = commands;
      nativeConfigReady = true;
    });
  });
  const engine = await Effect.runPromise(createEngine({
    adapter,
    configSource,
    clock: clockNode,
    initiallyPaused: parsed.flags["observe-only"] === true,
  }));
  await Effect.runPromise(engine.start());
  if (!nativeConfigReady) {
    await Effect.runPromise(engine.stop());
    adapter.stop();
    server.close();
    throw new Error("native keybind configuration failed during startup");
  }
  Effect.runFork(
    Stream.runForEach(adapter.keybindActions, (action) => {
      const command = keybindCommands.get(action);
      if (command === undefined) {
        return Effect.sync(() => console.error(`[keybind] ignored unconfigured action: ${action}`));
      }
      return Effect.tryPromise({
        try: () => executeEngineCommand(engine, command),
        catch: (error) => error,
      }).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => console.error(`[keybind] command failed: ${String(error)}`))),
        Effect.asVoid,
      );
    }),
  );

  attachWebSocketServer(server, {
    handle: (command) => executeEngineCommand(engine, command),
    snapshot: () => Effect.runPromise(engine.state()),
    events: () => engine.events(),
  });
  if (process.env["WM_SKETCHYBAR_BRIDGE"] === "1") {
    await import("./sketchybar-daemon.ts");
  }
  (nativeStdio ? console.error : console.log)(JSON.stringify({ ready: true, port }));
  return await new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (exitCode = 0, stopAdapter = true): void => {
      if (stopping) return;
      stopping = true;
      for (const client of server.clients) client.terminate();
      server.close();
      void Promise.race([
        Effect.runPromise(engine.stop()),
        new Promise<void>((done) => setTimeout(done, 2_000)),
      ]).finally(() => {
          if (stopAdapter) adapter.stop();
          resolve(exitCode);
      });
    };
    process.once("SIGINT", () => stop());
    process.once("SIGTERM", () => stop());
    void adapter.whenExited.then(() => stop(1, false));
  });
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
