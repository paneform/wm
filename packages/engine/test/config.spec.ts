import { describe, expect, test } from "vitest";
import {
  ConfigInvalidError,
  GLOBAL_DEFAULT_SETTINGS,
  applyConfigDelta,
  applyConfigFull,
  effectiveSettings,
  globalSettings,
  parseConfig,
  parseConfigSafe,
  type Config,
} from "../src/config.ts";
import { BSP_DEFAULT_GAP, RESIZE_INCREMENT_DEFAULT } from "../src/constants.ts";

const baseConfig = (): Config => ({
  defaults: { mode: "floating", gap: 16 },
  workspaces: [{ name: "main", gap: 10, assign: [{ bundleId: "com.example.app" }] }],
});

describe("config parse validation", () => {
  test("a valid config parses and safe-parse reports ok", () => {
    const config = baseConfig();
    expect(parseConfig(config)).toEqual(config);
    expect(parseConfigSafe(config)).toEqual({ ok: true, config });
  });

  test("an empty object is valid; every section is optional", () => {
    expect(parseConfig({})).toEqual({});
  });

  test("unknown fields are errors at every level", () => {
    const candidates: unknown[] = [
      { nope: true },
      { defaults: { gap: 8, nope: 1 } },
      { workspaces: [{ name: "main", nope: 1 }] },
      { defaults: { margins: { top: 4, sideways: 1 } } },
      { workspaces: [{ name: "main", assign: [{ bundleId: "x", titleExtra: "y" }] }] },
    ];
    for (const candidate of candidates) {
      expect(() => parseConfig(candidate)).toThrow(ConfigInvalidError);
      const safe = parseConfigSafe(candidate);
      expect(safe.ok).toBe(false);
      if (!safe.ok) {
        expect(safe.error).toBeInstanceOf(ConfigInvalidError);
        expect(safe.error.issues.length).toBeGreaterThan(0);
        expect(safe.error.message).toContain("invalid config");
      }
    }
  });

  test("workspace names must be non-empty strings", () => {
    expect(() => parseConfig({ workspaces: [{ name: "" }] })).toThrow(ConfigInvalidError);
    expect(parseConfigSafe({ workspaces: [{ name: 7 }] }).ok).toBe(false);
  });

  test("mode literals are restricted to bsp|floating", () => {
    expect(parseConfigSafe({ defaults: { mode: "tiling" } }).ok).toBe(false);
    expect(parseConfigSafe({ workspaces: [{ name: "w", mode: "auto" }] }).ok).toBe(false);
    expect(parseConfigSafe({ defaults: { mode: "floating" } }).ok).toBe(true);
  });

  test("gap and resizeIncrement bounds are enforced where implemented", () => {
    for (const gap of [-1, 129]) {
      expect(parseConfigSafe({ defaults: { gap } }).ok).toBe(false);
      expect(parseConfigSafe({ workspaces: [{ name: "w", gap }] }).ok).toBe(false);
    }
    for (const resizeIncrement of [0, 0.005, 0.6, 1]) {
      expect(parseConfigSafe({ defaults: { resizeIncrement } }).ok).toBe(false);
    }
    expect(parseConfigSafe({ defaults: { gap: 128, resizeIncrement: 0.5 } }).ok).toBe(true);
    expect(parseConfigSafe({ defaults: { gap: 0, resizeIncrement: 0.01 } }).ok).toBe(true);
  });
});

describe("effective settings inheritance", () => {
  test("unconfigured workspaces fall back to built-in global defaults", () => {
    const settings = effectiveSettings({}, "anything");
    expect(settings).toEqual({
      name: "",
      mode: "bsp",
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      gap: BSP_DEFAULT_GAP,
      resizeIncrement: RESIZE_INCREMENT_DEFAULT,
      preferredDisplay: null,
      assign: [],
    });
    expect(globalSettings({})).toEqual(GLOBAL_DEFAULT_SETTINGS);
  });

  test("global defaults override the built-ins field by field", () => {
    const settings = effectiveSettings(
      {
        defaults: {
          mode: "floating",
          gap: 24,
          resizeIncrement: 0.1,
          margins: { top: 5, left: 3 },
        },
      },
      "unlisted",
    );
    expect(settings.mode).toBe("floating");
    expect(settings.gap).toBe(24);
    expect(settings.resizeIncrement).toBe(0.1);
    expect(settings.margins).toEqual({ top: 5, right: 0, bottom: 0, left: 3 });
  });

  test("partial global defaults keep built-in values for absent fields", () => {
    const settings = effectiveSettings({ defaults: { gap: 40 } }, "unlisted");
    expect(settings.mode).toBe("bsp");
    expect(settings.gap).toBe(40);
    expect(settings.resizeIncrement).toBe(RESIZE_INCREMENT_DEFAULT);
    expect(settings.margins).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  test("workspace settings override global defaults per field", () => {
    const settings = effectiveSettings(
      {
        defaults: {
          mode: "floating",
          gap: 16,
          resizeIncrement: 0.1,
          margins: { top: 5, left: 3 },
        },
        workspaces: [
          { name: "code", gap: 32, margins: { top: 9 } },
          { name: "other" },
        ],
      },
      "code",
    );
    expect(settings.name).toBe("code");
    expect(settings.mode).toBe("floating");
    expect(settings.gap).toBe(32);
    expect(settings.resizeIncrement).toBe(0.1);
    expect(settings.margins).toEqual({
      top: 9,
      right: 0,
      bottom: 0,
      left: 3,
    });
  });

  test("sibling workspaces without their own settings inherit globals untouched", () => {
    const config: Config = {
      defaults: { mode: "floating", gap: 16 },
      workspaces: [{ name: "code", gap: 32 }],
    };
    const sibling = effectiveSettings(config, "other");
    expect(sibling.gap).toBe(16);
    expect(sibling.mode).toBe("floating");

    const code = effectiveSettings(config, "code");
    expect(code.gap).toBe(32);
  });

  test("preferredDisplay and assign resolve only from the workspace entry", () => {
    const config: Config = {
      workspaces: [
        { name: "code", preferredDisplay: "display:abc", assign: [{ bundleId: "x.y" }] },
      ],
    };
    const code = effectiveSettings(config, "code");
    expect(code.preferredDisplay).toBe("display:abc");
    expect(code.assign).toEqual([{ bundleId: "x.y" }]);

    const unlisted = effectiveSettings(config, "unlisted");
    expect(unlisted.preferredDisplay).toBeNull();
    expect(unlisted.assign).toEqual([]);
  });

  test("globalSettings ignores the workspace section entirely", () => {
    const settings = globalSettings({
      defaults: { gap: 64 },
      workspaces: [{ name: "main", gap: 1 }],
    });
    expect(settings.gap).toBe(64);
  });
});

describe("delta reload atomicity", () => {
  test("a fully invalid candidate throws and leaves the prior config untouched", () => {
    const prior = baseConfig();
    const before = structuredClone(prior);
    expect(() =>
      applyConfigDelta(prior, { workspaces: [{ name: "", gap: 10_000 }] }),
    ).toThrow(ConfigInvalidError);
    expect(prior).toEqual(before);
  });

  test("a candidate that is partially valid is rejected whole (no partial merge)", () => {
    const prior = baseConfig();
    const before = structuredClone(prior);
    expect(() =>
      applyConfigDelta(prior, {
        defaults: { gap: 20 },
        workspaces: [{ name: "extra", mode: "nonexistent-mode" }],
      }),
    ).toThrow(ConfigInvalidError);
    expect(prior).toEqual(before);
  });

  test("parseConfigSafe keeps prior config on invalid hotload candidates", () => {
    const prior = baseConfig();
    const result = parseConfigSafe({ defaults: { gap: -3 } });
    expect(result.ok).toBe(false);
    expect(prior.defaults?.gap).toBe(16);
  });

  test("valid delta merges defaults field by field and appends new workspaces", () => {
    const prior = baseConfig();
    const merged = applyConfigDelta(prior, {
      defaults: { gap: 24 },
      workspaces: [
        { name: "main", resizeIncrement: 0.2 },
        { name: "scratch", mode: "floating" },
      ],
    });
    expect(merged).toEqual({
      defaults: { mode: "floating", gap: 24 },
      workspaces: [
        {
          name: "main",
          gap: 10,
          resizeIncrement: 0.2,
          assign: [{ bundleId: "com.example.app" }],
        },
        { name: "scratch", mode: "floating" },
      ],
    });
  });

  test("delta with absent sections reproduces the current config", () => {
    const prior = baseConfig();
    expect(applyConfigDelta(prior, {})).toEqual(prior);
  });

  test("merged delta feeds through to effective settings", () => {
    const merged = applyConfigDelta(baseConfig(), {
      defaults: { gap: 24 },
      workspaces: [{ name: "main", resizeIncrement: 0.2 }],
    });
    const settings = effectiveSettings(merged, "main");
    expect(settings.mode).toBe("floating");
    expect(settings.resizeIncrement).toBe(0.2);
    expect(settings.gap).toBe(10);
  });
});

describe("full reload semantics", () => {
  test("the validated candidate replaces config-derived intent wholesale", () => {
    const prior = baseConfig();
    const candidate = { workspaces: [{ name: "solo", gap: 12 }] };
    const next = applyConfigFull(prior, candidate);
    expect(next).toEqual(parseConfig(candidate));
    expect(next.workspaces?.map((ws) => ws.name)).toEqual(["solo"]);
  });

  test("workspaces absent from a full reload drop their config properties", () => {
    const next = applyConfigFull(baseConfig(), {});
    expect(next).toEqual({});
    expect(effectiveSettings(next, "main").gap).toBe(BSP_DEFAULT_GAP);
  });

  test("invalid full-reload candidates throw before any swap happens", () => {
    const prior = baseConfig();
    const before = structuredClone(prior);
    expect(() => applyConfigFull(prior, { defaults: { mode: "grid" } })).toThrow(
      ConfigInvalidError,
    );
    expect(prior).toEqual(before);
  });

  test("runtime overlay preservation is owned by the engine caller, not config.ts", () => {
    // applyConfigFull deliberately ignores its `current` argument: runtime state
    // (world membership/trees, manage overrides) never lives inside Config.
    // The caller that preserves it is engine.ts reloadConfigNow, which reassigns
    // only the config binding and leaves world/overrides untouched.
    const prior = baseConfig();
    const candidate = {};
    const next = applyConfigFull(prior, candidate);
    expect(next).not.toEqual(prior);
    expect(prior).toEqual(baseConfig());
  });
});
