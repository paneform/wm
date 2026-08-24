import { Effect, Stream } from "effect";
import type { ConfigSource } from "@wm/engine";
import * as fs from "node:fs";

const DEBOUNCE_MS = 150;

/** Strip JSONC comments and trailing commas so the result is valid JSON. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env["WM_CONFIG"]) return env["WM_CONFIG"];
  const xdg = env["XDG_CONFIG_HOME"] ?? `${env["HOME"] ?? "~"}/.config`;
  return `${xdg}/wm/config.jsonc`;
}

/**
 * File-backed ConfigSource: JSONC on disk; changes() debounced from fs.watch.
 */
export function createFileConfigSource(path: string): ConfigSource {
  return {
    // Parse failures surface as defects: the engine treats an unloadable
    // config source as fatal rather than a recoverable error.
    load: (): Effect.Effect<unknown> =>
      Effect.sync(() => JSON.parse(stripJsonc(fs.readFileSync(path, "utf8") as string))),
    changes: () =>
      Stream.asyncPush<void>((emit) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const schedule = () => {
              if (timer !== null) clearTimeout(timer);
              timer = setTimeout(() => {
                timer = null;
                emit.single(undefined);
              }, DEBOUNCE_MS);
            };
            const watcher = fs.watch(path, schedule);
            return { watcher, timerRef: () => timer };
          }),
          (handle) =>
            Effect.sync(() => {
              handle.watcher.close();
            }),
        ),
      ),
  };
}
