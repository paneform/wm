import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDiagnosticsLog, resolveDiagnosticsPath } from "../src/diagnostics-log.ts";

const tempFile = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-diagnostics-"));
  return path.join(dir, "diagnostics.jsonl");
};

const readLines = (file: string): string[] =>
  fs.readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);

describe("diagnostics log (bean wm-site)", () => {
  test("resolves the state path and honors an explicit override", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wm-home-"));
    expect(resolveDiagnosticsPath({ HOME: home })).toBe(`${home}/.local/state/wm/diagnostics.jsonl`);
    const override = `${home}/state/diag.jsonl`;
    expect(resolveDiagnosticsPath({ WM_DIAGNOSTICS: override })).toBe(override);
  });

  test("appends entries and bounds the file to the newest entries", () => {
    const file = tempFile();
    const log = createDiagnosticsLog(file, { maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      log.append({ ts: `t${i}`, topic: "diagnostic", payload: { code: "ax_stall", pid: i } });
    }
    const entries = readLines(file).map((line) => JSON.parse(line) as {
      ts: string;
      topic: string;
      payload: { pid: number };
    });
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ ts: "t2", topic: "diagnostic" });
    expect(entries[2]?.payload.pid).toBe(4);
  });

  test("preserves prior entries across restarts", () => {
    const file = tempFile();
    createDiagnosticsLog(file, { maxEntries: 5 }).append({
      ts: "t0",
      topic: "diagnostic",
      payload: { code: "ax_stall" },
    });
    createDiagnosticsLog(file, { maxEntries: 5 }).append({
      ts: "t1",
      topic: "repair",
      payload: { detail: "recovered" },
    });
    const entries = readLines(file).map((line) => JSON.parse(line) as {
      ts: string;
      payload: { code?: string };
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.payload).toEqual({ code: "ax_stall" });
    expect(entries[1]?.ts).toBe("t1");
  });

  test("drops oversized history at startup without failing", () => {
    const file = tempFile();
    fs.writeFileSync(
      file,
      Array.from({ length: 10 }, (_, i) => `{"ts":"t${i}","topic":"diagnostic","payload":{}}`).join("\n") +
        "\n",
    );
    createDiagnosticsLog(file, { maxEntries: 4 });
    const entries = readLines(file).map((line) => JSON.parse(line) as { ts: string });
    expect(entries).toHaveLength(4);
    expect(entries[0]?.ts).toBe("t6");
  });
});
