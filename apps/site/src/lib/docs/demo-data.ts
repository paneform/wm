import { commandDocs, type DocumentedCommand } from "@paneform/layout";
import { parseScenario, type LayoutScenario } from "@paneform/layout-browser";
import { demoManifest, type CommandDemo } from "./demo-manifest.js";
import { scenarioFiles } from "./scenario-files.js";
import { formatDemoCaption } from "./demo-caption.js";

export interface DemoSituation {
  slug: string;
  title: string;
  intro: string;
  scenario: LayoutScenario;
}

export function demoSituations(definition: CommandDemo): DemoSituation[] {
  if (definition.kind !== "desktop") return [];
  return definition.situations.map((descriptor) => {
    formatDemoCaption(descriptor.intro, `${descriptor.file} intro`);
    return { ...descriptor, scenario: parseDocsScenario(scenarioFiles[descriptor.file]) };
  });
}

/** Docs-specific presentation rules do not restrict playground or hero scenarios. */
export function parseDocsScenario<Input>(source: Input): LayoutScenario {
  const scenario = parseScenario(source);
  for (const [index, step] of (scenario.steps ?? []).entries()) {
    if (step.caption !== undefined) formatDemoCaption(step.caption, `Step ${index + 1} caption`);
  }
  return scenario;
}

export function demoDefinitions(doc: DocumentedCommand): CommandDemo[] {
  const identities = new Set(doc.forms.flatMap((form) => (form.type ? [form.type] : [])));
  return [
    ...[...identities].map((id) => demoManifest[id]),
    ...Object.entries(demoManifest)
      .filter(([id]) => id === doc.slug)
      .map(([, definition]) => definition),
  ];
}

export function demosForCommand(slug: string): DemoSituation[] | undefined {
  const doc = commandDocs.find((item) => item.slug === slug);
  if (!doc) return undefined;
  const situations = demoDefinitions(doc).flatMap(demoSituations);
  return situations.length ? situations : undefined;
}
