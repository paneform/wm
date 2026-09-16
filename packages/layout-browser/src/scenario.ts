import {
  DisplayConfigSchema,
  ConfigSchema,
  GlobalDefaultsSchema,
  MatcherSchema,
  parseConfig,
  WorkspaceConfigSchema,
} from "@paneform/layout";
import { JSONSchema, Schema } from "effect";
import { parseScenarioCommand } from "./scenario-commands.js";

export { parseScenarioCommand };

const described = <S extends Schema.Schema.Any>(schema: S, description: string) =>
  schema.annotations({ description });

const boundedString = (maximum: number, description: string) =>
  Schema.String.pipe(Schema.maxLength(maximum), Schema.annotations({ description }));
const safeRecordKey = Schema.String.pipe(Schema.minLength(1), Schema.pattern(/^(?!__proto__$).*$/));
const id = boundedString(128, "A non-empty portable identifier.").pipe(
  Schema.minLength(1),
  Schema.pattern(/^(?!__proto__$).*$/),
);
const workspace = Schema.NullOr(
  boundedString(128, "A non-empty workspace name, or null when unassigned.").pipe(
    Schema.minLength(1),
  ),
);
const coordinate = Schema.Number.pipe(
  Schema.between(-10_000_000, 10_000_000),
  Schema.annotations({ description: "A finite screen coordinate." }),
);
const dimension = Schema.Number.pipe(
  Schema.between(Number.MIN_VALUE, 10_000_000),
  Schema.annotations({ description: "A positive finite screen dimension." }),
);
const osRuleOverride = Schema.Number.pipe(
  Schema.between(Number.MIN_VALUE, 10_000),
  Schema.annotations({ description: "A positive finite OS constraint distance." }),
);

export const OsRulesSchema = Schema.Union(
  Schema.Literal("none"),
  Schema.Struct({
    kind: Schema.Literal("macos"),
    horizontalFallback: Schema.optional(osRuleOverride),
    bottomVisible: Schema.optional(osRuleOverride),
  }),
).annotations({ description: "Optional simulated operating-system window constraints." });
export type ScenarioOsRules = typeof OsRulesSchema.Encoded;

export const SimulationOptionsSchema = Schema.Struct({
  os: OsRulesSchema,
}).annotations({ description: "Optional platform simulation behavior." });
export type SimulationOptions = typeof SimulationOptionsSchema.Encoded;

const FrameSchema = Schema.Struct({
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
}).annotations({
  description: "A physical screen rectangle.",
  examples: [{ x: 80, y: 60, width: 960, height: 720 }],
});

const PartialFrameSchema = Schema.Struct({
  x: Schema.optional(coordinate),
  y: Schema.optional(coordinate),
  width: Schema.optional(dimension),
  height: Schema.optional(dimension),
}).annotations({ description: "The frame fields that must match." });

const ConstraintsSchema = Schema.Struct({
  minWidth: Schema.optional(dimension),
  maxWidth: Schema.optional(dimension),
  minHeight: Schema.optional(dimension),
  maxHeight: Schema.optional(dimension),
}).annotations({ description: "Known physical size limits. Each limit is independent." });

const WindowMetadataFields = {
  title: Schema.optional(boundedString(512, "A display title; it may contain sensitive text.")),
  bundleId: Schema.optional(boundedString(512, "An application bundle identifier.")),
  role: Schema.optional(boundedString(128, "A platform accessibility role.")),
  subrole: Schema.optional(boundedString(128, "A platform accessibility subrole.")),
  constraints: Schema.optional(ConstraintsSchema),
  minimized: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  fullscreen: Schema.optional(Schema.Boolean),
} as const;

export const SimulationWindowSchema = Schema.Struct({
  id,
  frame: FrameSchema,
  workspace: Schema.optionalWith(workspace, { default: () => "1" as const }).annotations({
    description:
      "Workspace membership. An omitted value defaults to workspace 1; null is unassigned.",
    default: "1",
  }),
  floating: Schema.optional(Schema.Boolean),
  ...WindowMetadataFields,
}).annotations({ description: "An exact initial simulated window." });
export type SimulationWindow = typeof SimulationWindowSchema.Encoded;

const PhysicalDisplaySchema = Schema.Struct({
  id,
  frame: FrameSchema,
  workArea: Schema.optional(FrameSchema),
  scale: Schema.optionalWith(dimension, { default: () => 1 }).annotations({
    description: "Display scale. An omitted value defaults to 1.",
    default: 1,
  }),
  primary: Schema.optional(Schema.Boolean),
}).annotations({ description: "Physical facts about a connected display." });

export const SimulationDisplaySchema = Schema.Struct({
  id,
  frame: FrameSchema,
  workArea: Schema.optional(FrameSchema),
  scale: Schema.optionalWith(dimension, { default: () => 1 }).annotations({
    description: "Display scale. An omitted value defaults to 1.",
    default: 1,
  }),
  primary: Schema.optional(Schema.Boolean),
  workspace,
}).annotations({ description: "A connected display and its required workspace assignment." });
export type SimulationDisplay = typeof SimulationDisplaySchema.Encoded;

const EventWindowSchema = Schema.Struct({
  id,
  frame: FrameSchema,
  ...WindowMetadataFields,
}).annotations({
  description: "Physical window facts; workspace and floating policy are intentionally absent.",
});

export const ScenarioEventSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("window_added"),
    window: EventWindowSchema,
    focus: Schema.optional(Schema.Boolean).annotations({
      description:
        "Focus the new window within the same step, before layout settles. Omission retains ordinary background-add behavior.",
    }),
  }),
  Schema.Struct({ kind: Schema.Literal("window_changed"), window: EventWindowSchema }),
  Schema.Struct({ kind: Schema.Literal("window_removed"), windowId: id }),
  Schema.Struct({ kind: Schema.Literal("focus_changed"), windowId: Schema.NullOr(id) }),
  Schema.Struct({
    kind: Schema.Literal("topology_changed"),
    topology: Schema.Array(PhysicalDisplaySchema).pipe(Schema.maxItems(16)),
  }),
  Schema.Struct({ kind: Schema.Literal("space_changed") }),
  Schema.Struct({ kind: Schema.Literal("sleep") }),
  Schema.Struct({ kind: Schema.Literal("wake") }),
).annotations({ description: "A simplified physical platform event." });
export type ScenarioEvent = typeof ScenarioEventSchema.Encoded;

const WindowExpectationSchema = Schema.Struct({
  exists: Schema.optional(Schema.Boolean),
  workspace: Schema.optional(workspace),
  floating: Schema.optional(Schema.Boolean),
  frame: Schema.optional(PartialFrameSchema),
});

const ExpectedWindowsSchema = Schema.Record({
  key: id,
  value: WindowExpectationSchema,
}).annotations({
  description: "Expected windows, limited to 100 identifiers.",
  jsonSchema: { maxProperties: 100 },
});

export const ScenarioExpectationSchema = Schema.Struct({
  focusedWindow: Schema.optional(Schema.NullOr(id)),
  focusedWorkspace: Schema.optional(workspace),
  paused: Schema.optional(Schema.Boolean),
  wmRunning: Schema.optional(Schema.Boolean),
  windows: Schema.optional(ExpectedWindowsSchema),
  error: Schema.optional(boundedString(128, "The expected command error code.")),
}).annotations({ description: "Optional state or command-error assertions after a step settles." });
export type ScenarioExpectation = typeof ScenarioExpectationSchema.Type;

const StepPresentationFields = {
  caption: Schema.optional(boundedString(2_000, "Presentation text shown with this step.")),
  duration: Schema.optional(
    Schema.Number.pipe(
      Schema.between(0, 60_000),
      Schema.annotations({ description: "Presentation duration in milliseconds." }),
    ),
  ),
  expect: Schema.optional(ScenarioExpectationSchema),
} as const;

export const ScenarioStepSchema = Schema.Union(
  Schema.Struct({
    command: boundedString(4_096, "One wm CLI command parsed as data, never by a shell.").pipe(
      Schema.minLength(1),
      Schema.annotations({
        examples: ["window focus right", "window move left", "workspace move-window T", "retile"],
      }),
    ),
    ...StepPresentationFields,
  }),
  Schema.Struct({ event: ScenarioEventSchema, ...StepPresentationFields }),
).annotations({
  description: "Exactly one command or event plus optional presentation and assertions.",
});
export type ScenarioStep = typeof ScenarioStepSchema.Encoded;

export const SimulationStateSchema = Schema.Struct({
  topology: Schema.Array(SimulationDisplaySchema).pipe(Schema.maxItems(16)),
  windows: Schema.Array(SimulationWindowSchema).pipe(Schema.maxItems(100)),
  focusedWindow: Schema.optionalWith(Schema.NullOr(id), { default: () => null }).annotations({
    description: "Initially focused window. An omitted value means no focused window.",
    default: null,
  }),
  focusedWorkspace: Schema.optionalWith(workspace, { default: () => null }).annotations({
    description: "Initially focused workspace. An omitted value means no focused workspace.",
    default: null,
  }),
  paused: Schema.optional(Schema.Boolean),
  wmRunning: Schema.optionalWith(Schema.Boolean, { default: () => true }).annotations({
    description: "Whether a window-manager engine is running. An omitted value defaults to true.",
    default: true,
  }),
}).annotations({ description: "The exact physical scene imported before playback." });
export type SimulationState = typeof SimulationStateSchema.Encoded;

const PresentationDevicesSchema = Schema.Record({
  key: safeRecordKey,
  value: Schema.Literal("laptop", "display"),
}).annotations({
  description: "Per-display device shell overrides, limited to 16 display identifiers.",
  jsonSchema: { maxProperties: 16 },
});

export const PresentationSchema = Schema.Struct({
  device: Schema.optionalWith(Schema.Literal("laptop", "display"), {
    default: () => "laptop" as const,
  }),
  devices: Schema.optional(PresentationDevicesSchema),
  showKeyboard: Schema.optionalWith(Schema.Boolean, { default: () => true }).annotations({
    description: "Show the laptop keyboard. Standalone displays do not include a keyboard.",
  }),
  showDock: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  showTopBar: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  allowMove: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  allowResize: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  animate: Schema.optionalWith(Schema.Boolean, { default: () => true }),
}).annotations({ description: "Optional UI-only playback and device-shell choices." });
export type Presentation = typeof PresentationSchema.Encoded;

const PortableMatcherSchema = Schema.Struct({
  ...MatcherSchema.fields,
  bundleId: Schema.optional(boundedString(512, "A bounded bundle identifier matcher.")),
  executablePath: Schema.optional(boundedString(512, "A bounded executable path matcher.")),
  title: Schema.optional(boundedString(512, "A bounded title regular expression.")),
  role: Schema.optional(boundedString(512, "A bounded accessibility role matcher.")),
  subrole: Schema.optional(boundedString(512, "A bounded accessibility subrole matcher.")),
});
const PortableWorkspaceConfigSchema = Schema.Struct({
  ...WorkspaceConfigSchema.fields,
  name: boundedString(128, "A bounded non-empty workspace name.").pipe(Schema.minLength(1)),
  preferredDisplay: Schema.optional(
    boundedString(128, "A bounded preferred display identifier.").pipe(Schema.minLength(1)),
  ),
  assign: Schema.optional(Schema.Array(PortableMatcherSchema).pipe(Schema.maxItems(100))),
});
const PortableKeybindsSchema = Schema.Record({
  key: safeRecordKey,
  value: Schema.String,
}).annotations({
  description: "Key bindings, limited to 500 entries.",
  jsonSchema: { maxProperties: 500 },
});
const PortableConfigSchema = Schema.Struct({
  ...ConfigSchema.fields,
  defaults: Schema.optional(GlobalDefaultsSchema),
  displays: Schema.optional(Schema.Array(DisplayConfigSchema).pipe(Schema.maxItems(16))),
  workspaces: Schema.optional(
    Schema.Array(PortableWorkspaceConfigSchema).pipe(Schema.maxItems(100)),
  ),
  keybinds: Schema.optional(PortableKeybindsSchema),
});

export const LayoutScenarioSchema = Schema.Struct({
  $schema: Schema.optional(
    boundedString(2_000, "An editor hint identifying the JSON Schema; it has no runtime meaning."),
  ),
  config: Schema.optional(PortableConfigSchema),
  presentation: Schema.optional(PresentationSchema),
  simulation: Schema.optional(SimulationOptionsSchema),
  state: SimulationStateSchema,
  steps: Schema.optional(Schema.Array(ScenarioStepSchema).pipe(Schema.maxItems(500))),
}).annotations({
  identifier: "LayoutScenario",
  title: "Paneform layout scenario",
  description:
    "A portable, data-only initial layout and deterministic sequence of commands or events.",
});
export type LayoutScenario = typeof LayoutScenarioSchema.Encoded;

type DecodedLayoutScenario = typeof LayoutScenarioSchema.Type;

export const scenarioJsonSchema = {
  ...JSONSchema.make(LayoutScenarioSchema),
  $id: "https://paneform.com/wm/play/scenario.schema.json",
};

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function validateConstraints(
  value: { constraints?: typeof ConstraintsSchema.Type | undefined },
  label: string,
): void {
  const limits = value.constraints;
  if (
    limits?.minWidth !== undefined &&
    limits.maxWidth !== undefined &&
    limits.minWidth > limits.maxWidth
  )
    throw new Error(`${label} minWidth must not exceed maxWidth`);
  if (
    limits?.minHeight !== undefined &&
    limits.maxHeight !== undefined &&
    limits.minHeight > limits.maxHeight
  )
    throw new Error(`${label} minHeight must not exceed maxHeight`);
}

function requireReference(known: ReadonlySet<string>, value: string, label: string): void {
  if (!known.has(value)) throw new Error(`${label} references unknown id "${value}"`);
}

/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This bounded preflight deliberately inspects untrusted JSON data before full schema decoding. Own data descriptors avoid invoking getters. */
function ownValue(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function assertArrayLimit(value: unknown, maximum: number, label: string): void {
  if (Array.isArray(value) && value.length > maximum)
    throw new Error(`${label} exceeds ${maximum} items`);
}

function assertRecordLimit(value: unknown, maximum: number, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const keys = Object.keys(value);
  if (keys.includes("__proto__")) throw new Error(`${label} contains reserved key "__proto__"`);
  if (keys.length > maximum) throw new Error(`${label} exceeds ${maximum} properties`);
}

// This cheap pass bounds collections before Effect traverses malformed entries and builds diagnostics.
function preflightScenario(input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;
  const state = ownValue(input, "state");
  if (typeof state === "object" && state !== null && !Array.isArray(state)) {
    assertArrayLimit(ownValue(state, "windows"), 100, "state.windows");
    assertArrayLimit(ownValue(state, "topology"), 16, "state.topology");
  }

  const config = ownValue(input, "config");
  if (typeof config === "object" && config !== null && !Array.isArray(config)) {
    const displays = ownValue(config, "displays");
    const workspaces = ownValue(config, "workspaces");
    assertArrayLimit(displays, 16, "config.displays");
    assertArrayLimit(workspaces, 100, "config.workspaces");
    assertRecordLimit(ownValue(config, "keybinds"), 500, "config.keybinds");
    if (Array.isArray(workspaces) && workspaces.length <= 100) {
      for (const [index, entry] of workspaces.entries()) {
        if (typeof entry === "object" && entry !== null && !Array.isArray(entry))
          assertArrayLimit(ownValue(entry, "assign"), 100, `config.workspaces[${index}].assign`);
      }
    }
  }

  const presentation = ownValue(input, "presentation");
  if (typeof presentation === "object" && presentation !== null && !Array.isArray(presentation))
    assertRecordLimit(ownValue(presentation, "devices"), 16, "presentation.devices");

  const steps = ownValue(input, "steps");
  assertArrayLimit(steps, 500, "steps");
  if (!Array.isArray(steps) || steps.length > 500) return;
  for (const [index, step] of steps.entries()) {
    if (typeof step !== "object" || step === null || Array.isArray(step)) continue;
    const expectation = ownValue(step, "expect");
    if (typeof expectation === "object" && expectation !== null && !Array.isArray(expectation))
      assertRecordLimit(ownValue(expectation, "windows"), 100, `steps[${index}].expect.windows`);
    const event = ownValue(step, "event");
    if (typeof event === "object" && event !== null && !Array.isArray(event))
      assertArrayLimit(ownValue(event, "topology"), 16, `steps[${index}].event.topology`);
  }
}
/* oxlint-enable anti-slop/no-object-parameters, anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

function validateScenario(scenario: DecodedLayoutScenario): void {
  const initialWindowIds = scenario.state.windows.map((window) => window.id);
  const initialDisplayIds = scenario.state.topology.map((display) => display.id);
  const windows = new Set(initialWindowIds);
  let displays = new Set(initialDisplayIds);
  const possibleDisplays = new Set(initialDisplayIds);
  const workspaces = new Set<string>();

  assertUnique(initialWindowIds, "initial window ids");
  assertUnique(initialDisplayIds, "initial display ids");
  const displayWorkspaces = scenario.state.topology
    .map((display) => display.workspace)
    .filter((value): value is string => value !== null);
  assertUnique(displayWorkspaces, "display workspaces");
  for (const name of displayWorkspaces) workspaces.add(name);
  for (const window of scenario.state.windows) {
    if (window.workspace !== null) workspaces.add(window.workspace);
    validateConstraints(window, `window "${window.id}" constraints`);
  }
  if (scenario.state.topology.filter((display) => display.primary === true).length > 1)
    throw new Error("initial topology may contain at most one primary display");
  if (scenario.state.wmRunning === false && scenario.state.paused === true)
    throw new Error("stopped window manager cannot be paused");
  if (scenario.state.focusedWindow !== null)
    requireReference(windows, scenario.state.focusedWindow, "focusedWindow");
  if (scenario.state.focusedWorkspace !== null)
    requireReference(workspaces, scenario.state.focusedWorkspace, "focusedWorkspace");

  for (const [index, step] of (scenario.steps ?? []).entries()) {
    if ("command" in step && "event" in step)
      throw new Error(`step ${index + 1} must contain exactly one command or event`);

    if ("command" in step) {
      const command = parseScenarioCommand(step.command);
      if (command.type !== "service") {
        if (command.type === "subscribe")
          throw new Error(`step ${index + 1} uses unsupported subscribe`);
        if ("windowId" in command)
          requireReference(windows, command.windowId, `step ${index + 1} command`);
        if ("displayId" in command)
          requireReference(displays, command.displayId, `step ${index + 1} command`);
        if ("workspace" in command && command.workspace !== undefined)
          workspaces.add(command.workspace);
        if (command.type === "focusWorkspace") workspaces.add(command.name);
      }
    } else {
      const event = step.event;
      switch (event.kind) {
        case "window_added":
          if (windows.has(event.window.id))
            throw new Error(`step ${index + 1} adds existing window "${event.window.id}"`);
          windows.add(event.window.id);
          if (windows.size > 100) throw new Error(`step ${index + 1} exceeds 100 live windows`);
          validateConstraints(event.window, `step ${index + 1} window constraints`);
          break;
        case "window_changed":
          requireReference(windows, event.window.id, `step ${index + 1} event`);
          validateConstraints(event.window, `step ${index + 1} window constraints`);
          break;
        case "window_removed":
          requireReference(windows, event.windowId, `step ${index + 1} event`);
          windows.delete(event.windowId);
          break;
        case "focus_changed":
          if (event.windowId !== null)
            requireReference(windows, event.windowId, `step ${index + 1} event`);
          break;
        case "topology_changed": {
          const ids = event.topology.map((display) => display.id);
          assertUnique(ids, `step ${index + 1} topology display ids`);
          if (event.topology.filter((display) => display.primary === true).length > 1)
            throw new Error(`step ${index + 1} topology may contain at most one primary display`);
          displays = new Set(ids);
          for (const id of ids) possibleDisplays.add(id);
          break;
        }
      }
    }

    const expectation = step.expect;
    if (!("command" in step) && expectation?.error !== undefined)
      throw new Error(`step ${index + 1} event cannot expect a command error`);
    if (expectation?.focusedWindow !== undefined && expectation.focusedWindow !== null)
      requireReference(windows, expectation.focusedWindow, `step ${index + 1} expectation`);
    for (const [windowId, expected] of Object.entries(expectation?.windows ?? {})) {
      if (expected.exists !== false)
        requireReference(windows, windowId, `step ${index + 1} expectation`);
    }
  }
  for (const displayId of Object.keys(scenario.presentation?.devices ?? {}))
    requireReference(possibleDisplays, displayId, "presentation.devices");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the public untrusted JSON boundary.
export function parseScenario(input: unknown): LayoutScenario {
  preflightScenario(input);
  const scenario = Schema.decodeUnknownSync(LayoutScenarioSchema, {
    onExcessProperty: "error",
    errors: "first",
  })(input);
  if (scenario.config !== undefined) parseConfig(scenario.config);
  validateScenario(scenario);
  return scenario;
}
