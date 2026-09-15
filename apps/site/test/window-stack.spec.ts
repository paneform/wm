import { describe, expect, it } from "vitest";
import { updateWindowStack } from "../src/lib/hero/window-stack.js";

describe("window render stack", () => {
  const ids = ["browser", "terminal", "editor"];

  it("raises the focused window and preserves the order below it", () => {
    const first = updateWindowStack([], ids, "browser");
    expect(first).toEqual(["terminal", "editor", "browser"]);
    const second = updateWindowStack(first, ids, "terminal");
    expect(second).toEqual(["editor", "browser", "terminal"]);
    expect(updateWindowStack(second, ids, "terminal")).toEqual(second);
  });

  it("removes closed windows and includes newly opened windows", () => {
    expect(updateWindowStack(ids, ["browser", "editor", "music"], "browser")).toEqual([
      "editor",
      "music",
      "browser",
    ]);
  });

  it("preserves history when focus is absent and resets with the session", () => {
    expect(updateWindowStack(ids, ids, null)).toEqual(ids);
    expect(updateWindowStack(ids, ids, "missing")).toEqual(ids);
    expect(updateWindowStack(ids, [], null)).toEqual([]);
  });
});
