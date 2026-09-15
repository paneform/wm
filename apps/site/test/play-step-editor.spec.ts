import { describe, expect, it } from "vitest";
import { beginReorderGesture, reorderItem } from "../src/lib/play/pure-step-editor.js";

describe("step editor reorder", () => {
  it("moves an entire draft without changing its metadata", () => {
    const first = { step: { command: "focus left", caption: "First", duration: 400, expect: {} } };
    const second = { step: { event: { kind: "sleep" }, caption: "Second", id: "sleep" } };

    const reordered = reorderItem([first, second], 0, 1);

    expect(reordered).toEqual([second, first]);
    expect(reordered[1]).toBe(first);
  });

  it("does not lose or duplicate items when moving across a page boundary", () => {
    const drafts = Array.from({ length: 21 }, (_, index) => ({ index }));

    const reordered = reorderItem(drafts, 19, 20);

    expect(reordered).toHaveLength(21);
    expect(reordered.map(({ index }) => index)).toEqual([
      ...Array.from({ length: 19 }, (_, index) => index),
      20,
      19,
    ]);
  });

  it("returns an unchanged copy for invalid moves", () => {
    const drafts = [{ index: 0 }, { index: 1 }];

    expect(reorderItem(drafts, -1, 1)).toEqual(drafts);
    expect(reorderItem(drafts, 0, 2)).toEqual(drafts);
    expect(reorderItem(drafts, 1, 1)).toEqual(drafts);
  });

  it("captures all state needed to cancel without losing draft data", () => {
    const drafts = [
      { step: { command: "focus left", caption: "Title", duration: 300 }, eventText: "suffix" },
      { step: { event: { kind: "sleep" }, expect: { focusedWindow: "one" } }, eventText: "event" },
    ];

    const gesture = beginReorderGesture(drafts, 1, false, 2, "Invalid event");
    const reordered = reorderItem(drafts, 1, 0);

    expect(reordered).toEqual([drafts[1], drafts[0]]);
    expect(gesture).toEqual({
      items: drafts,
      index: 1,
      unsaved: false,
      page: 2,
      error: "Invalid event",
    });
    expect(gesture.items[0]).toBe(drafts[0]);
  });

  it("creates independent snapshots for replacement sessions", () => {
    const oldGesture = beginReorderGesture([{ id: "old" }], 0, true, 1, "old error");
    const newGesture = beginReorderGesture([{ id: "new" }], 0, false, 0, "");

    expect(newGesture.items).toEqual([{ id: "new" }]);
    expect(newGesture.items).not.toEqual(oldGesture.items);
  });
});
