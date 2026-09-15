import { describe, expect, it } from "vitest";
import { isPlaygroundPath, requirePlayground } from "../src/lib/server/playground.js";

describe("playground release gate", () => {
  it.each([undefined, "false", "1", "TRUE", " true "])(
    "returns 404 without an exact opt-in (%s)",
    (flag) => {
      expect(() => requirePlayground({ PLAYGROUND_ENABLED: flag })).toThrow(
        expect.objectContaining({ status: 404 }),
      );
    },
  );

  it("rejects an enabled flag on Vercel production", () => {
    expect(() =>
      requirePlayground({ PLAYGROUND_ENABLED: "true", VERCEL_ENV: "production" }),
    ).toThrow(expect.objectContaining({ status: 404 }));
  });

  it.each([undefined, "development", "preview"])("allows opt-in in %s", (target) => {
    expect(requirePlayground({ PLAYGROUND_ENABLED: "true", VERCEL_ENV: target })).toBeUndefined();
  });

  it.each([
    "/wm/play",
    "/wm/play/",
    "/wm/play/hero/",
    "/wm/play/scenario.schema.json",
    "/wm/play/__data.json",
    "/wm/play/hero/__data.json",
    "/wm/play/index.html",
  ])("includes the entire playground subtree: %s", (path) => {
    expect(isPlaygroundPath(path)).toBe(true);
  });

  it.each(["/", "/wm/", "/wm/waitlist/", "/wm/playful", "/_app/immutable/app.js"])(
    "leaves unrelated routes alone: %s",
    (path) => {
      expect(isPlaygroundPath(path)).toBe(false);
    },
  );
});
