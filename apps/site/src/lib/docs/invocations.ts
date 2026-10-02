import { parseCommandText, type DocumentedCommand } from "@paneform/layout";

export interface InvocationRow {
  method: "CLI" | "Keybind" | "WebSocket" | "Scenario";
  syntax: string;
  note?: string;
}

const examples = { w1: "<window>", '"2"': '"<workspace>"', "display:main": "<display>" } as const;
function placeholders(value: string): string {
  return Object.entries(examples)
    .reduce((text, [example, name]) => text.replaceAll(example, name), value)
    .replace(/\b(left|right|up|down)\b/g, "<direction>");
}

export function invocationRows(doc: DocumentedCommand): InvocationRow[] {
  const forms = doc.slug.endsWith("-directional") ? doc.forms.slice(0, 1) : doc.forms;
  const rows: InvocationRow[] = forms.map((form) => ({
    method: "CLI",
    syntax: placeholders(form.syntax),
    note: form.description,
  }));
  const first = forms.find((form) => form.type && form.example);
  if (!first?.example) return rows;
  const action = placeholders(first.syntax.slice(3));
  rows.push({
    method: "Keybind",
    syntax: `"<chord>": "${action}"`,
    note: "Assign a shortcut to a concrete command in your config.",
  });
  const result = parseCommandText(first.example);
  if (!result.ok) return rows;
  const command = result.value;
  rows.push({
    method: "WebSocket",
    syntax: placeholders(JSON.stringify(command, null, 2)),
    note: "Send a command payload to the local service.",
  });
  rows.push({
    method: "Scenario",
    syntax: `"${action}"`,
    note: "Use this command in a playground or docs scenario.",
  });
  return rows;
}
