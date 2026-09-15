import { describe, expect, it } from "vitest";
import type { SimulationState } from "@paneform/layout-browser";
import { projectFrame, windowsForDisplay } from "../src/lib/play/projection.js";

const display = {
  id: "main",
  frame: { x: 100, y: 50, width: 1000, height: 500 },
  workspace: "2",
};

describe("scenario stage projection", () => {
  it("shows only workspace windows and intersecting unassigned physical windows", () => {
    const state: SimulationState = {
      topology: [display],
      windows: [
        { id: "shown", frame: { x: 100, y: 50, width: 100, height: 100 }, workspace: "2" },
        { id: "other", frame: { x: 100, y: 50, width: 100, height: 100 }, workspace: "1" },
        { id: "physical", frame: { x: 1050, y: 100, width: 100, height: 100 }, workspace: null },
        { id: "outside", frame: { x: 1200, y: 100, width: 100, height: 100 }, workspace: null },
      ],
    };

    expect(windowsForDisplay(state, display).map(({ id }) => id)).toEqual(["shown", "physical"]);
  });

  it("requires intersection when both display and window are unassigned", () => {
    const unassignedDisplay = { ...display, workspace: null };
    const state: SimulationState = {
      topology: [unassignedDisplay],
      windows: [
        { id: "inside", frame: { x: 100, y: 50, width: 10, height: 10 }, workspace: null },
        { id: "outside", frame: { x: 1200, y: 50, width: 10, height: 10 }, workspace: null },
      ],
    };
    expect(windowsForDisplay(state, unassignedDisplay).map(({ id }) => id)).toEqual(["inside"]);
  });

  it("does not render hidden or minimized windows", () => {
    const state: SimulationState = {
      topology: [display],
      windows: [
        { id: "visible", frame: { x: 100, y: 50, width: 10, height: 10 }, workspace: "2" },
        {
          id: "hidden",
          frame: { x: 100, y: 50, width: 10, height: 10 },
          workspace: "2",
          hidden: true,
        },
        {
          id: "minimized",
          frame: { x: 100, y: 50, width: 10, height: 10 },
          workspace: "2",
          minimized: true,
        },
      ],
    };
    expect(windowsForDisplay(state, display).map(({ id }) => id)).toEqual(["visible"]);
  });

  it("treats an omitted workspace as workspace 1", () => {
    const workspaceOne = { ...display, workspace: "1" };
    const state: SimulationState = {
      topology: [workspaceOne],
      windows: [{ id: "legacy-default", frame: { x: 0, y: 0, width: 10, height: 10 } }],
    };
    expect(windowsForDisplay(state, workspaceOne)).toHaveLength(1);
  });

  it("shows intersecting physical windows regardless of workspace while the WM is stopped", () => {
    const state: SimulationState = {
      topology: [display],
      windows: [
        { id: "physical", frame: { x: 100, y: 50, width: 10, height: 10 }, workspace: "1" },
        { id: "outside", frame: { x: 1200, y: 50, width: 10, height: 10 }, workspace: "2" },
      ],
      wmRunning: false,
    };
    expect(windowsForDisplay(state, display).map(({ id }) => id)).toEqual(["physical"]);
  });

  it("projects global geometry against the full physical display frame", () => {
    expect(projectFrame({ x: 350, y: 100, width: 500, height: 250 }, display)).toEqual({
      x: 25,
      y: 10,
      width: 50,
      height: 50,
    });
  });
});
