import { describe, expect, it } from "vitest";

import { mapSurfaceWindows } from "$lib/desktop/surface-adapter.js";

const frame = { x: 1, y: 2, width: 300, height: 200 };

describe("surface adapter", () => {
  it("preserves arbitrary IDs and omits unresolved windows", () => {
    const titles = new Map([["window:any/42", "Fallback title"]]);
    expect(
      mapSurfaceWindows(
        [
          { id: "window:any/42", frame },
          { id: "unknown", frame },
        ],
        ({ id }) => titles.get(id) ?? null,
      ),
    ).toEqual([{ id: "window:any/42", title: "Fallback title", frame }]);
  });

  it("keeps empty and null mappings generic", () => {
    expect(mapSurfaceWindows([], () => "unused")).toEqual([]);
    expect(mapSurfaceWindows([{ id: "unmapped", frame }], () => null)).toEqual([]);
  });
});
