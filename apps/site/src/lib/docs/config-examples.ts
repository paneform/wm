import {
  ExperimentsSchema,
  GlobalDefaultsSchema,
  DisplayConfigSchema,
  KeybindsSchema,
  WorkspaceConfigSchema,
  parseCommandText,
  isEngineCommand,
} from "@paneform/layout";
import type { Config } from "@paneform/layout";
import type { ParseError } from "effect/ParseResult";
import { Either, Schema } from "effect";

export interface ConfigFieldDoc<K extends keyof Config & string = keyof Config & string> {
  readonly key: K;
  readonly summary: string;
  /** The value written under this key in a config document. */
  readonly example: Config[K];
  readonly notes: readonly string[];
}

/** Hand-written examples; validateConfigFieldDoc checks each against the
 * matching layout schema, and docs-config.spec.ts keeps keys in sync with
 * ConfigSchema's properties. */
export const configFieldDocs: readonly [
  ConfigFieldDoc<"defaults">,
  ConfigFieldDoc<"displays">,
  ConfigFieldDoc<"workspaces">,
  ConfigFieldDoc<"keybinds">,
  ConfigFieldDoc<"experiments">,
] = [
  {
    key: "defaults",
    summary: "Workspace layout defaults, applied to every display and workspace.",
    example: { mode: "bsp", margins: { top: 32 }, gap: 8, resizeIncrement: 0.05 },
    notes: [
      "Every key is optional; per-display and per-workspace values override these field-by-field.",
      "Effective fallbacks: mode bsp, gap 8, resizeIncrement 0.05, margins 0 on every side.",
      "gap accepts 0–128 points, resizeIncrement 0.01–0.5, margins are non-negative points.",
    ],
  },
  {
    key: "displays",
    summary: "Per-display overrides, matched by stable display id.",
    example: [
      {
        display: "display:37d8832a-2d66-02ca-b9f7-8f30a301b230",
        margins: { top: 0 },
        gap: 0,
      },
    ],
    notes: [
      "wm display list lists the stable ids; margins and gap override the defaults for that display.",
    ],
  },
  {
    key: "workspaces",
    summary: "Workspace definitions, display affinity, and window assignment matchers.",
    example: [
      {
        name: "B",
        preferredDisplay: "display:37d8832a-2d66-02ca-b9f7-8f30a301b230",
        mode: "bsp",
        margins: { top: 32 },
        gap: 8,
        assign: [{ bundleId: "app.zen-browser.zen" }],
      },
    ],
    notes: [
      "name is required — it is the workspace's identity in keybinds, CLI commands, and the bar.",
      "assign matchers accept bundleId, executablePath, title (regex), role, and subrole; the first matching workspace claims the window.",
    ],
  },
  {
    key: "keybinds",
    summary: "Chord-to-command bindings, applied natively while the daemon runs.",
    example: { "rshift 1": "workspace focus 1", "lshift rshift 2": "window assign 2" },
    notes: [
      "Modifiers are side-aware: rshift and lshift match those physical keys; shift matches either.",
    ],
  },
  {
    key: "experiments",
    summary: "Opt-in behavior experiments.",
    example: { directionalMoveGroups: false },
    notes: [
      "directionalMoveGroups lets directional edge moves claim a whole adjacent subtree; default false.",
    ],
  },
];

function fail(key: string, detail: ParseError): Error {
  return new Error(`example for ${key} does not match its schema: ${String(detail)}`);
}

/** Decode a field doc's example against its schema; throws with context. */
export const validateConfigFieldDoc = (field: ConfigFieldDoc): void => {
  switch (field.key) {
    case "defaults": {
      const decoded = Schema.decodeUnknownEither(GlobalDefaultsSchema)(field.example);
      if (Either.isLeft(decoded)) throw fail(field.key, decoded.left);
      return;
    }
    case "displays": {
      const decoded = Schema.decodeUnknownEither(Schema.Array(DisplayConfigSchema))(field.example);
      if (Either.isLeft(decoded)) throw fail(field.key, decoded.left);
      return;
    }
    case "workspaces": {
      const decoded = Schema.decodeUnknownEither(Schema.Array(WorkspaceConfigSchema))(
        field.example,
      );
      if (Either.isLeft(decoded)) throw fail(field.key, decoded.left);
      return;
    }
    case "keybinds": {
      const decoded = Schema.decodeUnknownEither(KeybindsSchema)(field.example);
      if (Either.isLeft(decoded)) throw fail(field.key, decoded.left);
      for (const action of Object.values(decoded.right)) {
        const parsed = parseCommandText(action);
        if (!parsed.ok) throw new Error(`Invalid keybind example: ${parsed.error.message}`);
        if (!isEngineCommand(parsed.value))
          throw new Error(`Keybind example is not an engine command: ${action}`);
      }
      return;
    }
    case "experiments": {
      const decoded = Schema.decodeUnknownEither(ExperimentsSchema)(field.example);
      if (Either.isLeft(decoded)) throw fail(field.key, decoded.left);
      return;
    }
  }
};
