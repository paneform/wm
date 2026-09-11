import type { Frame } from "@paneform/layout";

export interface DisplayPreset {
  frame: Frame;
  workArea: Frame;
  scale: number;
}

// These are the logical-point geometries used by the original /wm devices.
export const laptopDisplayPreset: DisplayPreset = {
  frame: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 44, width: 1512, height: 780 },
  scale: 2,
};

export const desktopDisplayPreset: DisplayPreset = {
  frame: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 44, width: 2560, height: 1396 },
  scale: 2,
};
