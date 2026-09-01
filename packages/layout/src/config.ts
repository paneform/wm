import { Schema } from "effect";
import type { WorkspaceMode } from "./world.js";
import { BSP_DEFAULT_GAP, RESIZE_INCREMENT_DEFAULT } from "./constants.js";

// Config — docs/rewrite/engine-guide.md §Config.
// JSONC is parsed by the host; the engine receives a plain object and
// Schema-validates it. Unknown fields are errors. Workspaces inherit global
// defaults field-by-field.

const MarginSchema = Schema.Number.pipe(Schema.nonNegative());

export const MarginsSchema = Schema.Struct({
  top: Schema.optional(MarginSchema),
  right: Schema.optional(MarginSchema),
  bottom: Schema.optional(MarginSchema),
  left: Schema.optional(MarginSchema),
});
export interface Margins extends Schema.Schema.Type<typeof MarginsSchema> {}

export const MatcherSchema = Schema.Struct({
  bundleId: Schema.optional(Schema.String),
  executablePath: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  subrole: Schema.optional(Schema.String),
});
export interface Matcher extends Schema.Schema.Type<typeof MatcherSchema> {}

const ModeSchema = Schema.Literal("bsp", "floating");

const GapSchema = Schema.Number.pipe(Schema.between(0, 128));
const ResizeIncrementSchema = Schema.Number.pipe(Schema.between(0.01, 0.5));

export const GlobalDefaultsSchema = Schema.Struct({
  mode: Schema.optional(ModeSchema),
  margins: Schema.optional(MarginsSchema),
  gap: Schema.optional(GapSchema),
  resizeIncrement: Schema.optional(ResizeIncrementSchema),
});
export interface GlobalDefaults extends Schema.Schema.Type<typeof GlobalDefaultsSchema> {}

export const DisplayConfigSchema = Schema.Struct({
  display: Schema.String.pipe(Schema.minLength(1)),
  margins: Schema.optional(MarginsSchema),
  gap: Schema.optional(GapSchema),
});
export interface DisplayConfig extends Schema.Schema.Type<typeof DisplayConfigSchema> {}

export const WorkspaceConfigSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  preferredDisplay: Schema.optional(Schema.String),
  mode: Schema.optional(ModeSchema),
  margins: Schema.optional(MarginsSchema),
  gap: Schema.optional(GapSchema),
  resizeIncrement: Schema.optional(ResizeIncrementSchema),
  assign: Schema.optional(Schema.Array(MatcherSchema)),
});
export interface WorkspaceConfig extends Schema.Schema.Type<typeof WorkspaceConfigSchema> {}

export const KeybindsSchema = Schema.Record({
  key: Schema.String.pipe(Schema.minLength(1)),
  value: Schema.String.pipe(Schema.minLength(1)),
});
export interface Keybinds extends Schema.Schema.Type<typeof KeybindsSchema> {}

export const ConfigSchema = Schema.Struct({
  defaults: Schema.optional(GlobalDefaultsSchema),
  displays: Schema.optional(Schema.Array(DisplayConfigSchema)),
  workspaces: Schema.optional(Schema.Array(WorkspaceConfigSchema)),
  keybinds: Schema.optional(KeybindsSchema),
});
export interface Config extends Schema.Schema.Type<typeof ConfigSchema> {}

export class ConfigInvalidError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`invalid config: ${issues.join("; ")}`);
    this.name = "ConfigInvalidError";
    this.issues = issues;
  }
}

/** Validate a raw candidate object. Unknown fields are errors. */
export function parseConfig(raw: unknown): Config {
  try {
    const config = Schema.decodeUnknownSync(ConfigSchema, { onExcessProperty: "error" })(raw);
    const selectors = config.displays?.map((entry) => entry.display) ?? [];
    if (selectors.some((selector) => !selector.startsWith("display:"))) {
      throw new ConfigInvalidError(["display selectors must be stable display IDs"]);
    }
    if (new Set(selectors).size !== selectors.length) {
      throw new ConfigInvalidError(["display selectors must be unique"]);
    }
    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigInvalidError([message]);
  }
}

/** Non-throwing variant for hotload paths that must keep prior config. */
export function parseConfigSafe(
  raw: unknown,
): { ok: true; config: Config } | { ok: false; error: ConfigInvalidError } {
  try {
    return { ok: true, config: parseConfig(raw) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ConfigInvalidError ? error : new ConfigInvalidError([String(error)]),
    };
  }
}

// ---------------------------------------------------------------------------
// Effective settings — field-by-field workspace inheritance
// ---------------------------------------------------------------------------

export interface EffectiveWorkspaceSettings {
  name: string;
  mode: WorkspaceMode;
  margins: Required<Margins>;
  gap: number;
  resizeIncrement: number;
  preferredDisplay: string | null;
  assign: readonly Matcher[];
}

export const GLOBAL_DEFAULT_SETTINGS: EffectiveWorkspaceSettings = {
  name: "",
  mode: "bsp",
  margins: { top: 0, right: 0, bottom: 0, left: 0 },
  gap: BSP_DEFAULT_GAP,
  resizeIncrement: RESIZE_INCREMENT_DEFAULT,
  preferredDisplay: null,
  assign: [],
};

function mergeMargins(base: Required<Margins>, override: Margins | undefined): Required<Margins> {
  if (override === undefined) return base;
  return {
    top: override.top ?? base.top,
    right: override.right ?? base.right,
    bottom: override.bottom ?? base.bottom,
    left: override.left ?? base.left,
  };
}

function mergeOptionalMargins(
  base: Margins | undefined,
  override: Margins | undefined,
): Margins | undefined {
  if (override === undefined) return base;
  if (base === undefined) return override;
  return {
    top: override.top ?? base.top,
    right: override.right ?? base.right,
    bottom: override.bottom ?? base.bottom,
    left: override.left ?? base.left,
  };
}

/** Field-by-field precedence: global defaults, matched display, workspace. */
export function effectiveSettings(
  config: Config,
  workspaceName: string,
  displayId?: string,
): EffectiveWorkspaceSettings {
  const defaults = config.defaults;
  let effective: EffectiveWorkspaceSettings = {
    ...GLOBAL_DEFAULT_SETTINGS,
    mode: defaults?.mode ?? GLOBAL_DEFAULT_SETTINGS.mode,
    gap: defaults?.gap ?? GLOBAL_DEFAULT_SETTINGS.gap,
    resizeIncrement: defaults?.resizeIncrement ?? GLOBAL_DEFAULT_SETTINGS.resizeIncrement,
    margins: mergeMargins(GLOBAL_DEFAULT_SETTINGS.margins, defaults?.margins),
  };

  const display =
    displayId === undefined
      ? undefined
      : config.displays?.find((entry) => entry.display === displayId);
  if (display !== undefined) {
    effective = {
      ...effective,
      gap: display.gap ?? effective.gap,
      margins: mergeMargins(effective.margins, display.margins),
    };
  }

  const configured = config.workspaces?.find((ws) => ws.name === workspaceName);
  if (configured !== undefined) {
    effective = {
      ...effective,
      name: configured.name,
      mode: configured.mode ?? effective.mode,
      gap: configured.gap ?? effective.gap,
      resizeIncrement: configured.resizeIncrement ?? effective.resizeIncrement,
      margins: mergeMargins(effective.margins, configured.margins),
      preferredDisplay: configured.preferredDisplay ?? null,
      assign: configured.assign ?? [],
    };
  }
  return effective;
}

/** Global defaults used for workspaces not present in config. */
export function globalSettings(config: Config): EffectiveWorkspaceSettings {
  return effectiveSettings(config, "\u0000none");
}

// ---------------------------------------------------------------------------
// Reload application — docs/spec.md §Configuration
// ---------------------------------------------------------------------------

/**
 * Delta hotload: merge the validated candidate into the current config.
 * Present fields change; absent fields stay. Workspaces merge by name
 * field-by-field; new names are appended. Invalid candidates are rejected
 * BEFORE any merge so the prior config is preserved atomically.
 */
export function applyConfigDelta(current: Config, rawCandidate: unknown): Config {
  const candidate = parseConfig(rawCandidate);

  const mergedDefaults: GlobalDefaults | undefined =
    candidate.defaults === undefined
      ? current.defaults
      : current.defaults === undefined
        ? candidate.defaults
        : {
            mode: candidate.defaults.mode ?? current.defaults.mode,
            margins: mergeOptionalMargins(current.defaults.margins, candidate.defaults.margins),
            gap: candidate.defaults.gap ?? current.defaults.gap,
            resizeIncrement: candidate.defaults.resizeIncrement ?? current.defaults.resizeIncrement,
          };

  const displaysById = new Map<string, DisplayConfig>();
  for (const display of current.displays ?? []) displaysById.set(display.display, display);
  for (const display of candidate.displays ?? []) {
    const existing = displaysById.get(display.display);
    displaysById.set(
      display.display,
      existing === undefined
        ? display
        : {
            display: display.display,
            margins: mergeOptionalMargins(existing.margins, display.margins),
            gap: display.gap ?? existing.gap,
          },
    );
  }

  const byName = new Map<string, WorkspaceConfig>();
  for (const ws of current.workspaces ?? []) byName.set(ws.name, ws);
  for (const ws of candidate.workspaces ?? []) {
    const existing = byName.get(ws.name);
    if (existing === undefined) {
      byName.set(ws.name, ws);
      continue;
    }
    byName.set(ws.name, {
      name: ws.name,
      preferredDisplay: ws.preferredDisplay ?? existing.preferredDisplay,
      mode: ws.mode ?? existing.mode,
      margins: mergeOptionalMargins(existing.margins, ws.margins),
      gap: ws.gap ?? existing.gap,
      resizeIncrement: ws.resizeIncrement ?? existing.resizeIncrement,
      assign: ws.assign ?? existing.assign,
    });
  }

  const workspaces = byName.size > 0 ? [...byName.values()] : undefined;
  const displays = displaysById.size > 0 ? [...displaysById.values()] : undefined;
  return {
    ...(mergedDefaults === undefined ? {} : { defaults: mergedDefaults }),
    ...(displays === undefined ? {} : { displays }),
    ...(workspaces === undefined ? {} : { workspaces }),
    ...(candidate.keybinds === undefined
      ? current.keybinds === undefined
        ? {}
        : { keybinds: current.keybinds }
      : { keybinds: candidate.keybinds }),
  };
}

/**
 * Full reload: replace config-derived intent wholesale. Absent configured
 * workspaces drop their CONFIG properties; runtime state (membership, trees)
 * lives outside Config and is preserved by the caller. The candidate is fully
 * validated before the swap.
 */
export function applyConfigFull(_current: Config, rawCandidate: unknown): Config {
  return parseConfig(rawCandidate);
}
