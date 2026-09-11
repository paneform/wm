import { describe, expect, it } from "vitest";
import { MAX_SCENARIO_BYTES } from "../src/lib/play/scenario-url.js";
import { parseLocalConfig } from "../src/lib/play/local-config.js";

describe("local config", () => {
  it("parses comments and trailing commas through the config schema", () => {
    expect(parseLocalConfig('{ // config\n "defaults": { "gap": 8, }, }')).toEqual({
      defaults: { gap: 8 },
    });
  });
  it("rejects malformed JSONC, excess properties, and oversized input", () => {
    expect(() => parseLocalConfig("{")).toThrow("Invalid JSONC");
    expect(() => parseLocalConfig('{"unknown": true}')).toThrow("invalid config");
    expect(() => parseLocalConfig(" ".repeat(MAX_SCENARIO_BYTES + 1))).toThrow("size limit");
  });
});
