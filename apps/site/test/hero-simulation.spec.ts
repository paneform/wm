import { describe, expect, it } from "vitest";

import {
  createHeroSimulation,
  HERO_APPS,
  HERO_WORKSPACES,
  macBookDisplay,
  MACBOOK_DISPLAY_ID,
  STUDIO_DISPLAY_ID,
} from "../src/lib/hero/create-hero-simulation.js";
import { fastForwardHeroSimulation } from "../src/lib/hero/hero-snapshot.js";

describe("hero simulation", () => {
  it.each([false, true])("focuses an existing window with Paneform running=%s", async (running) => {
    const simulation = await createHeroSimulation();
    try {
      await simulation.activateApp("Browser");
      await simulation.activateApp("Terminal");
      if (running) await simulation.activateApp("Paneform");
      const before = await simulation.snapshot();
      const result = await simulation.focusWindow("Browser");
      expect(result.ok).toBe(true);
      expect(result.snapshot.state.focusedWindow).toBe(result.snapshot.apps.Browser);
      expect(result.snapshot.state.windows.map(({ frame }) => frame)).toEqual(
        before.state.windows.map(({ frame }) => frame),
      );
    } finally {
      await simulation.dispose();
    }
  });

  it("defines dock apps with typed metadata and observed bounds", () => {
    expect(HERO_APPS.map(({ title }) => title)).toEqual([
      "Paneform",
      "Browser",
      "Terminal",
      "Text Editor",
      "Music",
      "Contacts",
      "Messages",
      "Settings",
    ]);
    expect(HERO_APPS.find(({ title }) => title === "Settings")).toMatchObject({
      icon: "settings",
      bundleId: "com.apple.systempreferences",
      maxWidth: 723,
    });
  });

  it("bootstraps with Paneform stopped and no windows", async () => {
    const simulation = await createHeroSimulation();
    try {
      const snapshot = await simulation.snapshot();
      expect(snapshot.state.topology.map(({ id }) => id)).toEqual([MACBOOK_DISPLAY_ID]);
      expect(snapshot.state.workspaces.map(({ name }) => name)).toEqual(HERO_WORKSPACES);
      expect(macBookDisplay.workArea).toEqual({ x: 0, y: 44, width: 1512, height: 938 });
      expect(snapshot.wmRunning).toBe(false);
      expect(snapshot.state.windows).toEqual([]);
    } finally {
      await simulation.dispose();
    }
  });

  it("opens bounded windows, starts Paneform, and ends with Terminal on T", async () => {
    const simulation = await createHeroSimulation();
    try {
      const final = await fastForwardHeroSimulation(simulation);
      expect(final.wmRunning).toBe(true);
      expect(final.state.focusedWorkspace).toBe("T");
      expect(final.state.topology.map(({ id }) => id)).not.toContain(STUDIO_DISPLAY_ID);
      expect(final.state.workspaces.find(({ name }) => name === "T")?.visibleOnDisplay).toBe(
        MACBOOK_DISPLAY_ID,
      );
      const browser = final.state.windows.find(({ id }) => id === final.apps.Browser);
      expect(browser?.workspace).toBe("1");
      expect(final.state.windows.find(({ id }) => id === final.apps.Terminal)?.workspace).toBe("T");
    } finally {
      await simulation.dispose();
    }
  });

  it("keeps pre-launch windows fully inside the work area", async () => {
    const simulation = await createHeroSimulation();
    try {
      for (const app of ["Browser", "Terminal", "Text Editor"] as const)
        expect((await simulation.activateApp(app)).ok).toBe(true);
      const snapshot = await simulation.snapshot();
      expect(snapshot.state.windows.every(({ managed }) => !managed)).toBe(true);
      for (const { frame } of snapshot.state.windows) {
        expect(frame.x).toBeGreaterThanOrEqual(macBookDisplay.workArea.x);
        expect(frame.y).toBeGreaterThanOrEqual(macBookDisplay.workArea.y);
        expect(frame.x + frame.width).toBeLessThanOrEqual(
          macBookDisplay.workArea.x + macBookDisplay.workArea.width,
        );
        expect(frame.y + frame.height).toBeLessThanOrEqual(
          macBookDisplay.workArea.y + macBookDisplay.workArea.height,
        );
      }
    } finally {
      await simulation.dispose();
    }
  });

  it("keeps a pre-launch window at its dragged position", async () => {
    const simulation = await createHeroSimulation();
    try {
      expect((await simulation.activateApp("Browser")).ok).toBe(true);

      const result = await simulation.moveWindow("Browser", { x: 180, y: 120 });

      expect(result.ok).toBe(true);
      expect(
        result.snapshot.state.windows.find(({ id }) => id === result.snapshot.apps.Browser)?.frame,
      ).toMatchObject({
        x: 180,
        y: 120,
      });
    } finally {
      await simulation.dispose();
    }
  });

  it.each([
    { x: -900, y: 120 },
    { x: 1800, y: 120 },
    { x: 180, y: -700 },
    { x: 180, y: 1000 },
  ])("preserves a stopped physical drag offscreen at $x,$y", async (point) => {
    const simulation = await createHeroSimulation();
    try {
      expect((await simulation.activateApp("Browser")).ok).toBe(true);

      const result = await simulation.moveWindow("Browser", point);

      expect(result.ok).toBe(true);
      expect(
        result.snapshot.state.windows.find(({ id }) => id === result.snapshot.apps.Browser)?.frame,
      ).toMatchObject(point);
    } finally {
      await simulation.dispose();
    }
  });

  it("keeps a pre-launch window at its resized frame", async () => {
    const simulation = await createHeroSimulation();
    try {
      expect((await simulation.activateApp("Browser")).ok).toBe(true);
      const frame = { x: 160, y: 100, width: 900, height: 620 };

      const result = await simulation.resizeWindow("Browser", frame);

      expect(result.ok).toBe(true);
      expect(
        result.snapshot.state.windows.find(({ id }) => id === result.snapshot.apps.Browser)?.frame,
      ).toEqual(frame);
    } finally {
      await simulation.dispose();
    }
  });

  it("preserves a stopped physical resize fully offscreen", async () => {
    const simulation = await createHeroSimulation();
    try {
      expect((await simulation.activateApp("Browser")).ok).toBe(true);
      const frame = { x: -900, y: -700, width: 400, height: 300 };

      const result = await simulation.resizeWindow("Browser", frame);

      expect(result.ok).toBe(true);
      expect(
        result.snapshot.state.windows.find(({ id }) => id === result.snapshot.apps.Browser)?.frame,
      ).toEqual(frame);
    } finally {
      await simulation.dispose();
    }
  });

  it("closes a window and clears its app state", async () => {
    const simulation = await createHeroSimulation();
    try {
      expect((await simulation.activateApp("Browser")).ok).toBe(true);

      const result = await simulation.closeWindow("Browser");

      expect(result.ok).toBe(true);
      expect(result.snapshot.apps.Browser).toBeNull();
      expect(result.snapshot.state.windows).toEqual([]);
    } finally {
      await simulation.dispose();
    }
  });

  it("retiles surviving managed windows before close completes", async () => {
    const simulation = await createHeroSimulation();
    try {
      expect((await simulation.activateApp("Browser")).ok).toBe(true);
      expect((await simulation.activateApp("Text Editor")).ok).toBe(true);
      expect((await simulation.activateApp("Paneform")).ok).toBe(true);

      const result = await simulation.closeWindow("Text Editor");

      expect(result.ok).toBe(true);
      expect(result.snapshot.state.windows).toHaveLength(1);
      expect(
        result.snapshot.state.windows.find(({ id }) => id === result.snapshot.apps.Browser)?.frame,
      ).toEqual(macBookDisplay.workArea);
    } finally {
      await simulation.dispose();
    }
  });

  it("terminates an in-flight close when the simulation is disposed", async () => {
    const simulation = await createHeroSimulation();
    expect((await simulation.activateApp("Browser")).ok).toBe(true);
    expect((await simulation.activateApp("Paneform")).ok).toBe(true);

    const closing = simulation.closeWindow("Browser");
    await simulation.dispose();

    const result = await closing;
    expect(result.ok).toBe(false);
  });

  it("tiles existing windows when Paneform is launched manually", async () => {
    const simulation = await createHeroSimulation();
    try {
      for (const app of ["Browser", "Terminal", "Text Editor"] as const)
        expect((await simulation.activateApp(app)).ok).toBe(true);
      const unmanagedFrames = (await simulation.snapshot()).state.windows.map(({ frame }) => frame);

      const launched = await simulation.activateApp("Paneform");

      expect(launched.ok).toBe(true);
      expect(launched.snapshot.wmRunning).toBe(true);
      expect(launched.snapshot.state.windows).toHaveLength(3);
      expect(launched.snapshot.state.windows.every(({ managed }) => managed)).toBe(true);
      expect(launched.snapshot.state.windows.map(({ frame }) => frame)).not.toEqual(
        unmanagedFrames,
      );
    } finally {
      await simulation.dispose();
    }
  });

  it("keeps a window managed when its title bar is dragged", async () => {
    const simulation = await createHeroSimulation();
    try {
      expect((await simulation.activateApp("Browser")).ok).toBe(true);
      expect((await simulation.activateApp("Paneform")).ok).toBe(true);

      const result = await simulation.moveWindow("Browser", { x: 180, y: 120 });

      expect(result.ok).toBe(true);
      expect(
        result.snapshot.state.windows.find(({ id }) => id === result.snapshot.apps.Browser),
      ).toMatchObject({
        managed: true,
        floating: false,
      });
    } finally {
      await simulation.dispose();
    }
  });

  it.each([
    { x: -900, y: 120 },
    { x: 1800, y: 120 },
    { x: 180, y: -700 },
    { x: 180, y: 1000 },
  ])("retiles a managed window after an offscreen drag to $x,$y", async (point) => {
    const simulation = await createHeroSimulation();
    try {
      expect((await simulation.activateApp("Browser")).ok).toBe(true);
      expect((await simulation.activateApp("Paneform")).ok).toBe(true);

      const result = await simulation.moveWindow("Browser", point);

      expect(result.ok).toBe(true);
      expect(
        result.snapshot.state.windows.find(({ id }) => id === result.snapshot.apps.Browser),
      ).toMatchObject({
        frame: macBookDisplay.workArea,
        managed: true,
        floating: false,
      });
    } finally {
      await simulation.dispose();
    }
  });

  it("keeps a window managed when it is resized", async () => {
    const simulation = await createHeroSimulation();
    try {
      expect((await simulation.activateApp("Browser")).ok).toBe(true);
      expect((await simulation.activateApp("Paneform")).ok).toBe(true);
      const snapshot = await simulation.snapshot();
      const browser = snapshot.state.windows.find(({ id }) => id === snapshot.apps.Browser);
      expect(browser).toBeDefined();

      const result = await simulation.resizeWindow("Browser", {
        ...browser!.frame,
        width: browser!.frame.width - 40,
      });

      expect(result.ok).toBe(true);
      expect(
        result.snapshot.state.windows.find(({ id }) => id === result.snapshot.apps.Browser),
      ).toMatchObject({ managed: true, floating: false });
    } finally {
      await simulation.dispose();
    }
  });

  it("retiles a managed window after a physical resize", async () => {
    const simulation = await createHeroSimulation();
    try {
      expect((await simulation.activateApp("Browser")).ok).toBe(true);
      expect((await simulation.activateApp("Paneform")).ok).toBe(true);
      const frame = { x: -900, y: -700, width: 400, height: 300 };

      const result = await simulation.resizeWindow("Browser", frame);

      expect(result.ok).toBe(true);
      expect(
        result.snapshot.state.windows.find(({ id }) => id === result.snapshot.apps.Browser),
      ).toMatchObject({
        frame: macBookDisplay.workArea,
        managed: true,
        floating: false,
      });
    } finally {
      await simulation.dispose();
    }
  });

  it("fails to resize an unopened window", async () => {
    const simulation = await createHeroSimulation();
    try {
      const result = await simulation.resizeWindow("Browser", {
        x: 160,
        y: 100,
        width: 900,
        height: 620,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe("Browser is not open");
    } finally {
      await simulation.dispose();
    }
  });

  it("focuses an existing dock app without pulling it to the visible workspace", async () => {
    const simulation = await createHeroSimulation();
    try {
      const final = await fastForwardHeroSimulation(simulation);
      const result = await simulation.activateApp("Browser");
      expect(result.ok).toBe(true);
      expect(
        result.snapshot.state.windows.find(({ id }) => id === final.apps.Browser),
      ).toMatchObject({
        workspace: "1",
      });
      expect(result.snapshot.state.focusedWindow).toBe(final.apps.Browser);
    } finally {
      await simulation.dispose();
    }
  });
});


it("retiles the MacBook when the measured dock changes the work area", async () => {
  const simulation = await createHeroSimulation();
  try {
    await fastForwardHeroSimulation(simulation);
    for (const height of [810, 880]) {
      const area = { x: 0, y: 44, width: 1512, height };
      const result = await simulation.updateMacBookWorkArea(area);
      expect(result.ok).toBe(true);
      const snapshot = await simulation.snapshot();
      expect(snapshot.state.topology.find(d => d.id === macBookDisplay.id)?.workArea).toEqual(area);
      const workspace = snapshot.state.workspaces.find(w => w.visibleOnDisplay === macBookDisplay.id);
      const windows = snapshot.state.windows.filter(w => w.managed && !w.parked && w.workspace === workspace?.name);
      expect(windows.length).toBeGreaterThan(0);
      for (const window of windows) expect(window.frame.y + window.frame.height).toBeLessThanOrEqual(area.y + area.height);
      expect(Math.max(...windows.map(w => w.frame.y + w.frame.height))).toBeGreaterThan(area.y + area.height - 32);
    }
  } finally { await simulation.dispose(); }
});
