/** One documented node of the configuration tree. Numeric/enum/string
 * constraints are structural so docs-config.spec.ts can verify them against
 * the real schema instead of trusting prose. */
export interface ConfigFieldRef {
  readonly key: string;
  readonly required: boolean;
  readonly description: string;
  readonly kind:
    | {
        readonly kind: "number";
        readonly minimum?: number;
        readonly maximum?: number;
        readonly unit?: string;
      }
    | { readonly kind: "string"; readonly minLength?: number }
    | { readonly kind: "enum"; readonly values: readonly [string, string, ...string[]] }
    | { readonly kind: "boolean" }
    | { readonly kind: "record" }
    | { readonly kind: "array"; readonly items: readonly ConfigFieldRef[] }
    | { readonly kind: "object"; readonly fields: readonly ConfigFieldRef[] };
}

const marginPoints = (
  key: "top" | "right" | "bottom" | "left",
  description: string,
): ConfigFieldRef => ({
  key,
  required: false,
  description,
  kind: { kind: "number", minimum: 0, unit: "points" },
});

const marginsObject = (): ConfigFieldRef => ({
  key: "margins",
  required: false,
  description: "Empty space kept between the tiled area and the screen edges.",
  kind: {
    kind: "object",
    fields: [
      marginPoints("top", "Points reserved above the tiled area (the menu bar lives here)."),
      marginPoints("right", "Points reserved to the right of the tiled area."),
      marginPoints("bottom", "Points reserved below the tiled area."),
      marginPoints("left", "Points reserved to the left of the tiled area."),
    ],
  },
});

const modeField = (): ConfigFieldRef => ({
  key: "mode",
  required: false,
  description: "Tiling algorithm: bsp partitions the work area; floating leaves windows alone.",
  kind: { kind: "enum", values: ["bsp", "floating"] },
});

const gapField = (): ConfigFieldRef => ({
  key: "gap",
  required: false,
  description: "Gap between tiled window edges.",
  kind: { kind: "number", minimum: 0, maximum: 128, unit: "points" },
});

const resizeIncrementField = (): ConfigFieldRef => ({
  key: "resizeIncrement",
  required: false,
  description:
    "Resize step for keyboard and programmatic resizes, as a fraction of the display size (0.05 ≈ 5%).",
  kind: { kind: "number", minimum: 0.01, maximum: 0.5 },
});

const displayIdField = (): ConfigFieldRef => ({
  key: "display",
  required: true,
  description: "Stable display id, as listed by wm display list.",
  kind: { kind: "string", minLength: 1 },
});

/** The full configuration tree, hierarchically. One entry per top-level
 * Config field; docs-config.spec.ts checks this against ConfigSchema. */
export const configReference: readonly ConfigFieldRef[] = [
  {
    key: "defaults",
    required: false,
    description: "Fallback layout settings for every display and workspace.",
    kind: {
      kind: "object",
      fields: [modeField(), marginsObject(), gapField(), resizeIncrementField()],
    },
  },
  {
    key: "displays",
    required: false,
    description: "Per-display overrides, matched by stable display id.",
    kind: {
      kind: "array",
      items: [displayIdField(), marginsObject(), gapField()],
    },
  },
  {
    key: "workspaces",
    required: false,
    description: "Workspace definitions: layout settings, display affinity, and window assignment.",
    kind: {
      kind: "array",
      items: [
        {
          key: "name",
          required: true,
          description: "Workspace identity, used in keybinds, CLI commands, and the status bar.",
          kind: { kind: "string", minLength: 1 },
        },
        {
          key: "preferredDisplay",
          required: false,
          description: "Display this workspace prefers when revealed from parked state.",
          kind: { kind: "string" },
        },
        modeField(),
        marginsObject(),
        gapField(),
        resizeIncrementField(),
        {
          key: "assign",
          required: false,
          description:
            "Matchers that route newly observed windows into this workspace; the first matching workspace wins.",
          kind: {
            kind: "array",
            items: [
              {
                key: "bundleId",
                required: false,
                description: "Matches the application bundle id exactly, case-insensitively.",
                kind: { kind: "string" },
              },
              {
                key: "executablePath",
                required: false,
                description: "Matches the executable path exactly, case-insensitively.",
                kind: { kind: "string" },
              },
              {
                key: "title",
                required: false,
                description: "Regular expression matched against the window title.",
                kind: { kind: "string" },
              },
              {
                key: "role",
                required: false,
                description: "Matches the accessibility role exactly.",
                kind: { kind: "string" },
              },
              {
                key: "subrole",
                required: false,
                description: "Matches the accessibility subrole exactly.",
                kind: { kind: "string" },
              },
            ],
          },
        },
      ],
    },
  },
  {
    key: "keybinds",
    required: false,
    description: "Chord-to-command bindings, applied natively while the daemon runs.",
    kind: { kind: "record" },
  },
  {
    key: "experiments",
    required: false,
    description: "Opt-in behavior experiments.",
    kind: {
      kind: "object",
      fields: [
        {
          key: "directionalMoveGroups",
          required: false,
          description:
            "Directional edge moves may claim a whole adjacent subtree, preserving grouped layouts.",
          kind: { kind: "boolean" },
        },
      ],
    },
  },
];

/** Pre-order flattening with depth for rendering. */
export interface FlatConfigField {
  readonly key: string;
  readonly path: string;
  readonly required: boolean;
  readonly description: string;
  readonly typeText: string;
  readonly depth: number;
}

export function flattenReference(field: ConfigFieldRef): readonly FlatConfigField[] {
  const rows: FlatConfigField[] = [];
  const visit = (node: ConfigFieldRef, depth: number, path: string): void => {
    const kind = node.kind;
    let typeText: string;
    switch (kind.kind) {
      case "number": {
        const bounds =
          kind.minimum !== undefined || kind.maximum !== undefined
            ? ` ${kind.minimum ?? "-∞"}–${kind.maximum ?? "∞"}`
            : "";
        typeText = `number${bounds}${kind.unit !== undefined ? ` ${kind.unit}` : ""}`;
        break;
      }
      case "string":
        typeText = kind.minLength !== undefined ? "non-empty text" : "text";
        break;
      case "enum":
        typeText = kind.values.join(" | ");
        break;
      case "boolean":
        typeText = "true | false";
        break;
      case "record":
        typeText = "map of chord → command";
        break;
      case "array":
        typeText = "list";
        break;
      case "object":
        typeText = "settings";
        break;
    }
    rows.push({
      key: node.key,
      path,
      required: node.required,
      description: node.description,
      typeText,
      depth,
    });
    if (kind.kind === "object")
      for (const child of kind.fields) visit(child, depth + 1, `${path}.${child.key}`);
    if (kind.kind === "array")
      for (const child of kind.items) visit(child, depth + 1, `${path}[].${child.key}`);
  };
  visit(field, 0, field.key);
  return rows;
}
