import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Durable identification trail for rare failure signals (AX stalls,
 * unresponsive writes, repair attempts): one JSON object per line, bounded
 * by total entry count. Rare events make count-bounding cheap; the file is
 * rewritten keeping the newest entries when the bound is exceeded. */

export const DIAGNOSTICS_MAX_ENTRIES = 2000;

export function resolveDiagnosticsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["WM_DIAGNOSTICS"];
  if (configured !== undefined) {
    if (!path.isAbsolute(configured)) throw new Error("WM_DIAGNOSTICS must be an absolute path");
    return configured;
  }
  const home = env["HOME"] ?? os.homedir();
  const state = env["XDG_STATE_HOME"] ?? `${home}/.local/state`;
  if (!path.isAbsolute(state)) throw new Error("diagnostics state directory must be absolute");
  return `${state}/wm/diagnostics.jsonl`;
}

export interface DiagnosticsEntry {
  readonly ts: string;
  readonly topic: string;
  readonly payload: unknown;
}

export interface DiagnosticsLog {
  append(entry: DiagnosticsEntry): void;
}

export const createDiagnosticsLog = (
  file: string,
  options: {
    maxEntries?: number | undefined;
  } = {},
): DiagnosticsLog => {
  const maxEntries = options.maxEntries ?? DIAGNOSTICS_MAX_ENTRIES;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let entries: string[] = [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    entries = raw.length === 0 ? [] : raw.split("\n").filter((line) => line.length > 0);
  } catch {
    entries = [];
  }
  const truncated = entries.length > maxEntries;
  if (truncated) entries = entries.slice(-maxEntries);

  const rewrite = (): void => {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${entries.join("\n")}\n`, { flag: "wx" });
      fs.renameSync(temporary, file);
    } catch {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // best effort
      }
    }
  };

  if (truncated) rewrite();

  return {
    append(entry: DiagnosticsEntry): void {
      try {
        entries.push(JSON.stringify(entry));
        if (entries.length > maxEntries) {
          entries = entries.slice(-maxEntries);
          rewrite();
          return;
        }
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
      } catch {
        // Diagnostics must never take the daemon down.
      }
    },
  };
};
