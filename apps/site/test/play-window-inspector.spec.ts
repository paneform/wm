import { describe, expect, it } from "vitest";
import { validateWindowConstraints } from "../src/lib/play/WindowInspector.svelte";

describe("validateWindowConstraints", () => {
  it("treats empty bounds as unset", () => {
    expect(
      validateWindowConstraints({
        minWidth: "",
        maxWidth: "",
        minHeight: "",
        maxHeight: "",
      }),
    ).toEqual({});
  });

  it("accepts positive ranges and rejects inverted or non-finite bounds", () => {
    expect(
      validateWindowConstraints({
        minWidth: "320",
        maxWidth: "1200",
        minHeight: "200",
        maxHeight: "900",
      }),
    ).toEqual({ minWidth: 320, maxWidth: 1200, minHeight: 200, maxHeight: 900 });
    expect(() =>
      validateWindowConstraints({
        minWidth: "800",
        maxWidth: "400",
        minHeight: "",
        maxHeight: "",
      }),
    ).toThrow(/Minimum width/);
    expect(() =>
      validateWindowConstraints({
        minWidth: "Infinity",
        maxWidth: "",
        minHeight: "",
        maxHeight: "",
      }),
    ).toThrow(/positive number/);
  });
});
