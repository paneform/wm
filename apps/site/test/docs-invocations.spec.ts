import { commandDocs, documentedFields, parseCommandText } from "@paneform/layout";
import { describe, expect, it } from "vitest";
import { argumentRows, invocationRows } from "../src/lib/docs/invocations.js";

describe("websocket payload docs", () => {
  it("derives documented fields for every key of every documented form example", () => {
    for (const doc of commandDocs) {
      for (const form of doc.forms) {
        if (!form.type || !form.example) continue;
        const result = parseCommandText(form.example);
        expect(result.ok, form.example).toBe(true);
        if (!result.ok) continue;
        const fields = documentedFields(form.type);
        for (const key of Object.keys(result.value)) {
          const field = fields.find((candidate) => candidate.name === key);
          expect(field, `${form.type} field ${key}`).toBeDefined();
          expect(field?.summary, `${form.type} field ${key}`).toMatch(
            /^(Required|Optional)( — [^]+)?\.$/,
          );
        }
      }
    }
  });

  it("marks the discriminator required and target/flag fields optional", () => {
    const float = documentedFields("floatWindow");
    expect(float.find((field) => field.name === "type")?.required).toBe(true);
    expect(float.find((field) => field.name === "windowId")?.required).toBe(false);
    expect(float.find((field) => field.name === "toggle")?.required).toBe(false);
    const assign = documentedFields("moveWindowToWorkspace");
    expect(assign.find((field) => field.name === "workspace")?.required).toBe(true);
    expect(assign.find((field) => field.name === "follow")?.required).toBe(false);
    const retile = documentedFields("retile");
    expect(retile.find((field) => field.name === "workspace")?.required).toBe(false);
  });

  it("shows one CLI row and one fully-optioned websocket payload per page", () => {
    const float = commandDocs.find((doc) => doc.slug === "windows/float");
    if (float === undefined) throw new Error("windows/float page is missing");
    const rows = invocationRows(float);
    expect(rows.filter((row) => row.method === "CLI")).toHaveLength(1);
    expect(rows.filter((row) => row.method === "CLI")[0]?.syntax).toBe("wm window float");
    const wsRows = rows.filter((row) => row.method === "WebSocket");
    expect(wsRows).toHaveLength(1);
    const names = (wsRows[0]?.fields ?? []).map((field) => field.name).sort();
    expect(names).toEqual(["toggle", "type", "windowId"]);
    for (const field of wsRows[0]?.fields ?? [])
      expect(field.required).toBe(field.name === "type");
    expect(wsRows[0]?.note).toContain(
      "equivalent to wm window float --window <window> --toggle",
    );
  });

  it("shows both syntaxes for every float argument", () => {
    const float = commandDocs.find((doc) => doc.slug === "windows/float");
    if (float === undefined) throw new Error("windows/float page is missing");
    expect(argumentRows(float)).toEqual([
      {
        name: "windowId",
        text: "--window <window>",
        wire: '"windowId": "<window>"',
        required: false,
        description:
          "the window the command should target. If omitted, the focused window is used.",
      },
      {
        name: "toggle",
        text: "--toggle",
        wire: '"toggle": true',
        required: false,
        description: "toggles the targeted window between floating and tiling behavior.",
      },
    ]);
  });

  it("maps positionals and inverted flags to their wire fields", () => {
    const assign = commandDocs.find((doc) => doc.slug === "windows/assign");
    if (assign === undefined) throw new Error("windows/assign page is missing");
    const rows = argumentRows(assign);
    const workspace = rows.find((row) => row.name === "workspace");
    expect(workspace).toMatchObject({
      text: "<workspace>",
      wire: '"workspace": "<workspace>"',
      required: true,
      description: "the destination workspace.",
    });
    const follow = rows.find((row) => row.name === "follow");
    expect(follow).toMatchObject({
      text: "--no-follow",
      wire: '"follow": false',
      required: false,
      description: "keeps the current workspace in view instead of following the assigned window.",
    });
  });

  it("documents options the chosen payload omits with sampled wire values", () => {
    const observe = commandDocs.find((doc) => doc.slug === "windows/observe");
    if (observe === undefined) throw new Error("windows/observe page is missing");
    const pid = argumentRows(observe).find((row) => row.name === "pid");
    expect(pid).toMatchObject({
      text: "--pid <process-id>",
      wire: '"pid": "<process-id>"',
      required: false,
    });
  });

  it("prefers the window-targeted spelling, then the last, on field-count ties", () => {
    const observe = commandDocs.find((doc) => doc.slug === "windows/observe");
    const pause = commandDocs.find((doc) => doc.slug === "system/pause");
    if (observe === undefined || pause === undefined) throw new Error("pages are missing");
    const observeWs = invocationRows(observe).find((row) => row.method === "WebSocket");
    expect(observeWs?.syntax).toContain('"windowId"');
    expect(observeWs?.syntax).not.toContain('"pid"');
    const pauseWs = invocationRows(pause).find((row) => row.method === "WebSocket");
    expect(pauseWs?.syntax).toContain('"togglePause"');
  });
});
