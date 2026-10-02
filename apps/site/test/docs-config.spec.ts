import { ConfigSchema } from "@paneform/layout";
import { JSONSchema } from "effect";
import { describe, expect, test } from "vitest";
import { configFieldDocs, validateConfigFieldDoc } from "../src/lib/docs/config-examples.js";
import { configReference, type ConfigFieldRef } from "../src/lib/docs/config-reference.js";

// The configuration doc must track the real config schema: documented keys,
// examples, and the hierarchical field reference are all validated against
// ConfigSchema's generated JSON Schema.

interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
  items?: SchemaNode;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  propertyNames?: SchemaNode;
  additionalProperties?: SchemaNode;
}

// SAFETY: JSONSchema.make returns a structurally compatible JSON Schema
// document; the walker only reads the standard keywords declared on SchemaNode.
const schema = JSONSchema.make(ConfigSchema) as SchemaNode;

describe("configuration doc examples", () => {
  const properties = schema.properties ?? {};
  test("keybinding examples reject retired command syntax", () => {
    expect(() =>
      validateConfigFieldDoc({
        key: "keybinds",
        summary: "Invalid",
        example: { "rshift 2": "workspace move-window 2" },
        notes: [],
      }),
    ).toThrow("Invalid keybind example");
  });

  test("every schema field is documented exactly once", () => {
    const documented = configFieldDocs.map((field) => field.key).sort();
    expect(documented).toEqual(Object.keys(properties).sort());
  });

  for (const field of configFieldDocs) {
    test(`${field.key} example decodes against its schema`, () => {
      expect(Object.keys(properties)).toContain(field.key);
      expect(() => validateConfigFieldDoc(field)).not.toThrow();
    });
  }
});

describe("configuration reference tree", () => {
  test("one reference entry per top-level schema field", () => {
    expect(configReference.map((entry) => entry.key).sort()).toEqual(
      Object.keys(schema.properties ?? {}).sort(),
    );
  });

  const failures: string[] = [];
  const referencedPaths = new Set<string>();
  const collectSchema = (
    node: SchemaNode,
    path: string,
    required: readonly string[],
    into: Map<string, { node: SchemaNode; required: readonly string[] }>,
  ): void => {
    into.set(path, { node, required });
    if (node.properties !== undefined) {
      for (const [key, child] of Object.entries(node.properties))
        collectSchema(child, path === "" ? key : `${path}.${key}`, node.required ?? [], into);
      return;
    }
    if (node.items !== undefined) {
      const items = node.items;
      if (items.properties !== undefined)
        for (const [key, child] of Object.entries(items.properties))
          collectSchema(child, `${path}[].${key}`, items.required ?? [], into);
    }
  };

  const schemaPaths = new Map<string, { node: SchemaNode; required: readonly string[] }>();
  for (const [key, child] of Object.entries(schema.properties ?? {}))
    collectSchema(child, key, schema.required ?? [], schemaPaths);

  const compare = (ref: ConfigFieldRef, path: string, required: readonly string[]): void => {
    referencedPaths.add(path);
    const entry = schemaPaths.get(path);
    if (entry === undefined) {
      failures.push(`${path}: reference documents a field the schema does not have`);
      return;
    }
    const shouldBeRequired = required.includes(ref.key);
    if (ref.required !== shouldBeRequired)
      failures.push(
        `${path}: reference says ${ref.required ? "required" : "optional"}, schema says ${shouldBeRequired ? "required" : "optional"}`,
      );
    const kind = ref.kind;
    const node = entry.node;
    if (kind.kind === "number") {
      if (node.type !== "number") failures.push(`${path}: schema is not a number`);
      if ((kind.minimum ?? null) !== (node.minimum ?? null))
        failures.push(`${path}: documented minimum ${kind.minimum} != schema ${node.minimum}`);
      if ((kind.maximum ?? null) !== (node.maximum ?? null))
        failures.push(`${path}: documented maximum ${kind.maximum} != schema ${node.maximum}`);
    } else if (kind.kind === "string") {
      if (node.type !== "string") failures.push(`${path}: schema is not a string`);
      if ((kind.minLength ?? null) !== (node.minLength ?? null))
        failures.push(
          `${path}: documented minLength ${kind.minLength} != schema ${node.minLength}`,
        );
    } else if (kind.kind === "enum") {
      expect(node.enum).toEqual(kind.values);
    } else if (kind.kind === "boolean") {
      if (node.type !== "boolean") failures.push(`${path}: schema is not a boolean`);
    } else if (kind.kind === "record") {
      if (node.propertyNames === undefined && node.additionalProperties === undefined)
        failures.push(`${path}: schema is not a record`);
    } else if (kind.kind === "object") {
      for (const child of kind.fields) compare(child, `${path}.${child.key}`, node.required ?? []);
    } else {
      const items = node.items;
      if (items === undefined) {
        failures.push(`${path}: schema array has no items`);
        return;
      }
      if (items.properties !== undefined)
        for (const child of kind.items)
          compare(child, `${path}[].${child.key}`, items.required ?? []);
    }
  };

  test("reference tree covers the schema exactly, with matching constraints", () => {
    for (const entry of configReference)
      compare(
        entry,
        entry.key,
        (schema.properties ?? {})[entry.key] !== undefined ? (schema.required ?? []) : [],
      );
    expect(failures).toEqual([]);
    expect([...referencedPaths].sort()).toEqual([...schemaPaths.keys()].sort());
  });
});
