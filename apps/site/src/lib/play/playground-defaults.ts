import type { LayoutScenario } from "@paneform/layout-browser";
import {
  desktopDisplayPreset,
  laptopDisplayPreset,
  type DisplayPreset,
} from "../desktop/display-presets.js";

/** Model points reserved at the bottom of every playground display so tiles stop above the dock. */
const dockReservation = 144;

const withDockReservation = (preset: DisplayPreset): DisplayPreset => ({
  ...preset,
  workArea: { ...preset.workArea, height: preset.workArea.height - dockReservation },
});

export const playgroundLaptopPreset = withDockReservation(laptopDisplayPreset);

export const playgroundDesktopPreset = withDockReservation(desktopDisplayPreset);

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
    topology: [{ ...playgroundLaptopPreset, id: "display:main", workspace: "1", primary: true }],
    windows: [],
    focusedWindow: null,
    focusedWorkspace: "1",
    wmRunning: false,
  },
} satisfies LayoutScenario;
