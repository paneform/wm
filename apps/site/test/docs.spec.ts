import { readdirSync } from "node:fs";
import {
  commandDocs,
  commandPaths,
  serviceCommandPaths,
  parseCommandText,
  CommandErrorCode,
} from "@paneform/layout";
import { parseScenarioCommand, playbackSteps, runScenario } from "@paneform/layout-browser";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { demoDefinitions, demosForCommand, parseDocsScenario } from "../src/lib/docs/demo-data.js";
import { demoManifest } from "../src/lib/docs/demo-manifest.js";
import { scenarioFiles } from "../src/lib/docs/scenario-files.js";
import { formatDemoCaption } from "../src/lib/docs/demo-caption.js";

describe("documentation sources", () => {
  it("covers every command and service form with a demo or an explicit reason", () => {
    expect(commandDocs.flatMap((doc) => doc.forms)).toHaveLength(
      commandPaths.length + serviceCommandPaths.length,
    );
    for (const doc of commandDocs) {
      expect(demoDefinitions(doc).length, doc.slug).toBeGreaterThan(0);
      for (const form of doc.forms) {
        expect(form.description).not.toBe("");
        if (form.type && form.example) expect(parseCommandText(form.example).type).toBe(form.type);
      }
      for (const issue of doc.errors) {
        expect(Schema.decodeUnknownSync(CommandErrorCode)(issue.code)).toBe(issue.code);
        expect(issue.meaning).toBeTruthy();
        expect(issue.action).toBeTruthy();
      }
      const situations = demosForCommand(doc.slug) ?? [];
      expect(new Set(situations.map((item) => item.slug)).size).toBe(situations.length);
    }
    // The explicit-ID form is a separate situation on the focused-workspace page.
    expect(demosForCommand("windows/move-to-workspace")).toHaveLength(3);
  });

  it("links every scenario file exactly once without missing or orphaned files", () => {
    const files = readdirSync(new URL("../src/lib/docs/demos/", import.meta.url))
      .filter((file) => file.endsWith(".json"))
      .sort();
    const referenced = Object.values(demoManifest).flatMap((definition) =>
      definition.kind === "desktop" ? definition.situations.map((item) => item.file) : [],
    );
    expect([...referenced].sort()).toEqual(files);
    expect(Object.keys(scenarioFiles).sort()).toEqual(files);
  });

  for (const [id, definition] of Object.entries(demoManifest)) {
    if (definition.kind === "unavailable") {
      it(`explains the scenario exception for ${id}`, () =>
        expect(definition.reason.trim()).not.toBe(""));
      continue;
    }
    for (const descriptor of definition.situations)
      it(`runs ${id}/${descriptor.slug} and validates every expectation`, async () => {
        formatDemoCaption(descriptor.intro, `${descriptor.file} intro`);
        const scenario = parseDocsScenario(scenarioFiles[descriptor.file]);
        const steps = playbackSteps(scenario);
        expect(steps).toHaveLength(1);
        const step = steps[0]!;
        expect("command" in step).toBe(true);
        if ("command" in step) {
          const command = parseScenarioCommand(step.command);
          expect(command.type === "service" ? `service/${command.action}` : command.type).toBe(id);
        }
        expect(
          scenario.steps?.every((item) => item.expect && Object.keys(item.expect).length > 0),
        ).toBe(true);
        expect(scenario.state.windows.length).toBeLessThanOrEqual(4);
        expect(scenario.presentation?.interactive).toBe(false);
        expect(scenario.presentation?.showDock).toBe(false);
        await runScenario(scenario);
      });
  }
});
