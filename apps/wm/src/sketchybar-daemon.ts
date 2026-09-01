#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import type { StateSnapshot } from "@paneform/layout";
import { legacySketchybarSnapshot } from "./sketchybar.ts";

const url = process.env["WM_URL"] ?? "ws://127.0.0.1:17832";
const configDir = process.env["CONFIG_DIR"] ?? `${process.env["HOME"]}/.config/sketchybar`;
const snapshotPath = `${configDir}/state/wm-state.json`;
let backoff = 250;
let latestSnapshot: StateSnapshot | undefined;
let publishing = false;

const trigger = (): Promise<void> =>
  new Promise((resolve) => {
    const child = spawn("sketchybar", ["--trigger", "wm_workspace_change"], {
      stdio: "ignore",
    });
    child.once("error", (error) => {
      console.error(`[wm-sketchybar] trigger failed: ${String(error)}`);
      resolve();
    });
    child.once("close", () => resolve());
  });

const publish = async (snapshot: StateSnapshot): Promise<void> => {
  await mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
  const temporary = `${snapshotPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(legacySketchybarSnapshot(snapshot))}\n`, { mode: 0o600 });
  await rename(temporary, snapshotPath);
  await trigger();
};

const queuePublish = (snapshot: StateSnapshot): void => {
  latestSnapshot = snapshot;
  if (publishing) return;
  publishing = true;
  void (async () => {
    while (latestSnapshot !== undefined) {
      const next = latestSnapshot;
      latestSnapshot = undefined;
      try {
        await publish(next);
      } catch (error) {
        console.error(`[wm-sketchybar] publish failed: ${String(error)}`);
      }
    }
    publishing = false;
  })();
};

const connect = (): void => {
  const socket = new WebSocket(url);
  let refreshPending = false;
  let refreshQueued = false;

  const refresh = (): void => {
    if (refreshPending) {
      refreshQueued = true;
      return;
    }
    refreshPending = true;
    socket.send(JSON.stringify({
      v: 1,
      type: "request",
      id: `state-${crypto.randomUUID()}`,
      command: { type: "getState" },
    }));
  };

  socket.on("open", () => {
    socket.send(JSON.stringify({
      v: 1,
      type: "request",
      id: `subscribe-${crypto.randomUUID()}`,
      command: { type: "subscribe" },
    }));
  });
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as Record<string, unknown>;
    if (message["type"] === "snapshot") {
      backoff = 250;
      queuePublish(message["snapshot"] as StateSnapshot);
      return;
    }
    if (message["type"] === "event") {
      refresh();
      return;
    }
    const payload = message["data"] as { type?: string; snapshot?: StateSnapshot } | undefined;
    if (message["type"] === "response" && payload?.type === "state" && payload.snapshot !== undefined) {
      refreshPending = false;
      queuePublish(payload.snapshot);
      if (refreshQueued) {
        refreshQueued = false;
        refresh();
      }
    }
  });
  socket.on("close", () => {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
  socket.on("error", () => socket.close());
};

connect();
