import {
  documentedFields,
  isEngineCommand,
  optionSummary,
  parseCommandText,
  type Command,
  type DocumentedCommand,
} from "@paneform/layout";

export interface InvocationRow {
  method: "CLI" | "Keybind" | "WebSocket" | "Scenario";
  syntax: string;
  note?: string;
  /** WebSocket rows: payload fields colored required/optional and hover-documented. */
  fields?: readonly PayloadField[];
}

export interface PayloadField {
  readonly name: string;
  readonly value: string;
  readonly required: boolean;
  readonly summary: string;
}

export interface ArgumentRow {
  /** Wire field name; the WebSocket payload key. */
  readonly name: string;
  /** CLI/scenario/keybind spelling; null when text cannot express the field. */
  readonly text: string | null;
  /** WebSocket spelling, e.g. `"windowId": "<window>"`. */
  readonly wire: string;
  readonly required: boolean;
  readonly description: string;
}

const examples = { w1: "<window>", '"2"': '"<workspace>"', "display:main": "<display>" } as const;
function placeholders(value: string): string {
  return Object.entries(examples)
    .reduce((text, [example, name]) => text.replaceAll(example, name), value)
    .replace(/\b(left|right|up|down)\b/g, "<direction>");
}

const payloadFields = <T extends { readonly type: string }>(
  command: T,
): readonly PayloadField[] => {
  const docs = documentedFields(command.type);
  return Object.entries(command).map(([name, value]) => {
    const doc = docs.find((field) => field.name === name);
    return {
      name,
      value: placeholders(JSON.stringify(value)),
      required: doc?.required ?? true,
      summary: doc?.summary ?? "Required.",
    };
  });
};

interface ChosenPayload {
  readonly form: DocumentedCommand["forms"][number];
  readonly command: Command;
  readonly fields: readonly PayloadField[];
}

/** The most complete spelling carries every non-exclusive option; ties prefer
 * the window-targeted form, then the last. */
const chosenPayload = (doc: DocumentedCommand): ChosenPayload | null => {
  const forms = doc.slug.endsWith("-directional") ? doc.forms.slice(0, 1) : doc.forms;
  const parsed = forms
    .map((form) => {
      if (!form.type || !form.example) return null;
      const result = parseCommandText(form.example);
      return result.ok && isEngineCommand(result.value) ? { form, command: result.value } : null;
    })
    .filter((entry) => entry !== null);
  const first = parsed.at(0);
  if (first === undefined) return null;
  const chosen = parsed.reduce((best, candidate) => {
    const bestKeys = Object.keys(best.command).length;
    const candidateKeys = Object.keys(candidate.command).length;
    if (candidateKeys !== bestKeys) return candidateKeys > bestKeys ? candidate : best;
    const bestTarget = "windowId" in best.command ? 1 : 0;
    const candidateTarget = "windowId" in candidate.command ? 1 : 0;
    if (candidateTarget !== bestTarget) return candidateTarget > bestTarget ? candidate : best;
    return candidate;
  });
  return { ...chosen, fields: payloadFields(chosen.command) };
};

export function invocationRows(doc: DocumentedCommand): InvocationRow[] {
  const forms = doc.slug.endsWith("-directional") ? doc.forms.slice(0, 1) : doc.forms;
  const rows: InvocationRow[] = [];
  const base = forms.at(0);
  if (base !== undefined)
    rows.push({
      method: "CLI",
      syntax: placeholders(base.syntax),
      note: base.description,
    });
  const chosen = chosenPayload(doc);
  if (chosen === null) return rows;
  const action = placeholders((base ?? chosen.form).syntax.slice(3));
  rows.push({
    method: "Keybind",
    syntax: `"<chord>": "${action}"`,
    note: "Assign a shortcut to a concrete command in your config.",
  });
  rows.push({
    method: "WebSocket",
    syntax: placeholders(JSON.stringify(chosen.command, null, 2)),
    fields: chosen.fields,
    note: `Send a command payload to the local service; equivalent to ${placeholders(chosen.form.syntax)}.`,
  });
  rows.push({
    method: "Scenario",
    syntax: `"${action}"`,
    note: "Use this command in a playground or docs scenario.",
  });
  return rows;
}

/** Wire field → CLI flag when the text syntax expresses the field as a flag. */
const flagForField = new Map<string, string>([
  ["windowId", "window"],
  ["toggle", "toggle"],
  ["pid", "pid"],
  ["workspace", "workspace"],
  ["follow", "no-follow"],
]);

/** Sample wire values for fields the chosen payload omits. */
const fieldSamples = new Map<string, string>([
  ["windowId", '"<window>"'],
  ["pid", '"<process-id>"'],
  ["toggle", "true"],
  ["follow", "false"],
  ["workspace", '"<workspace>"'],
]);

/** Text spelling of fields the CLI expresses as bare positionals. */
const positionalText = new Map<string, string>([
  ["point", "<x-coordinate> <y-coordinate>"],
  ["size", "<width> <height>"],
  ["workspace", "<workspace>"],
  ["name", "<workspace>"],
  ["displayId", "<display>"],
  ["direction", "<direction>"],
]);
const positionalTextByType = new Map<string, Map<string, string>>([
  ["setWorkspaceMode", new Map([["mode", "bsp | floating"]])],
  ["reloadConfig", new Map([["mode", "delta | full"]])],
]);

const flagsOfSyntax = (syntax: string): Map<string, string | null> => {
  const flags = new Map<string, string | null>();
  const tokens = syntax.split(" ");
  for (const [index, token] of tokens.entries()) {
    if (!token.startsWith("--")) continue;
    const next = tokens[index + 1];
    flags.set(token.slice(2), next !== undefined && next.startsWith("<") ? next : null);
  }
  return flags;
};

/** Every command argument in both syntaxes, keyed to the WebSocket payload. */
export function argumentRows(doc: DocumentedCommand): readonly ArgumentRow[] {
  const chosen = chosenPayload(doc);
  if (chosen === null) return [];
  const present = new Map(Object.entries(chosen.command));
  const flags = new Map<string, string | null>();
  for (const form of doc.forms)
    for (const [flag, placeholder] of flagsOfSyntax(form.syntax))
      if (!flags.has(flag)) flags.set(flag, placeholder);
  const rows: ArgumentRow[] = [];
  for (const field of documentedFields(chosen.command.type)) {
    if (field.name === "type") continue;
    const flag = flagForField.get(field.name);
    const placeholder = flag === undefined ? undefined : flags.get(flag);
    let text: string | null = null;
    let description = "";
    if (flag !== undefined && placeholder !== undefined) {
      text = `--${flag}${placeholder === null ? "" : ` ${placeholder}`}`;
      description = optionSummary(doc.slug, flag);
    }
    if (text === null)
      text =
        positionalTextByType.get(chosen.command.type)?.get(field.name) ??
        positionalText.get(field.name) ??
        null;
    if (description === "")
      description = field.summary.replace(/^(Required|Optional) — /, "").replace(/^\.$/, "");
    const value = present.get(field.name);
    rows.push({
      name: field.name,
      text,
      wire: `"${field.name}": ${
        value === undefined
          ? (fieldSamples.get(field.name) ?? "…")
          : placeholders(JSON.stringify(value))
      }`,
      required: field.required,
      description,
    });
  }
  return rows;
}
