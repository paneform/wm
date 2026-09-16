import type { LayoutScenario } from "@paneform/layout-browser";
import { desktopDisplayPreset, laptopDisplayPreset } from "../desktop/display-presets.js";

export const playgroundDesktopPreset = {
  ...desktopDisplayPreset,
  workArea: {
    ...desktopDisplayPreset.workArea,
    height: desktopDisplayPreset.workArea.height - 144,
  },
};

export const emptyPlaygroundScenario = {
  simulation: { os: { kind: "macos" } },
  presentation: {
    device: "laptop",
    showKeyboard: true,
    showDock: true,
    showTopBar: true,
    allowMove: true,
    allowResize: true,
    animate: true,
  },
  state: {
    topology: [{ ...laptopDisplayPreset, id: "display:main", workspace: "1", primary: true }],
    windows: [],
    focusedWindow: null,
    focusedWorkspace: "1",
    wmRunning: false,
  },
} satisfies LayoutScenario;
