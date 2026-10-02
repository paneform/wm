import { ConfigSchema } from "@paneform/layout";
import { JSONSchema } from "effect";
import { describe, expect, test } from "vitest";
import { configFieldDocs, validateConfigFieldDoc } from "../src/lib/docs/config-examples.js";

// The configuration doc's examples must track the real config schema: every
// documented key must exist on ConfigSchema, and every example must decode.

describe("configuration doc examples", () => {
  const schema = JSONSchema.make(ConfigSchema);
  const properties = "properties" in schema ? (schema.properties ?? {}) : {};

  test("every schema field is documented exactly once", () => {
    const documented = configFieldDocs.map((field) => field.key).sort();
    expect(documented).toEqual(Object.keys(properties).sort());
  });

  for (const field of configFieldDocs) {
    test(`${field.key} example decodes against its schema`, () => {
      expect(Object.keys(properties)).toContain(field.key);
      expect(() => validateConfigFieldDoc(field)).not.toThrow();
      expect(field.notes.length).toBeGreaterThan(0);
    });
  }
  test("keybinding examples reject retired syntax even when the config schema accepts strings", () => {
    expect(() =>
      validateConfigFieldDoc({
        key: "keybinds",
        summary: "Invalid",
        example: { "rshift 2": "workspace move-window 2" },
        notes: [],
      }),
    ).toThrow("Invalid keybind example");
  });
});
