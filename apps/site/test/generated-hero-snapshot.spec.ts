import { describe, expect, it } from "vitest";

import { createHeroSimulation } from "../src/lib/hero/create-hero-simulation.js";
import { generatedHeroSnapshot } from "../src/lib/hero/generated-hero-snapshot.js";
import { fastForwardHeroSimulation, normalizeHeroSnapshot } from "../src/lib/hero/hero-snapshot.js";

describe("generated hero snapshot", () => {
  it("matches a fresh runtime fast-forward", async () => {
    const simulation = await createHeroSimulation();
    try {
      expect(normalizeHeroSnapshot(await fastForwardHeroSimulation(simulation))).toEqual(
        generatedHeroSnapshot,
      );
    } finally {
      await simulation.dispose();
    }
  });
});
