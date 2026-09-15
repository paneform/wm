import { HERO_WORKSPACES, type HeroWorkspace } from "$lib/hero/workspace-model.js";

export type KeyboardKeyId = string;

export interface KeyboardKey {
  id: KeyboardKeyId;
  code: string | null;
  legend: string;
  alternateLegend?: string;
  row: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface KeySource {
  id: KeyboardKeyId;
  code: string | null;
  legend: string;
  width?: number;
  alternateLegend?: string;
}

const gap = 3 / 15.2;
const scaledWidth = (units: number) => units + (units - 1) * gap;
const modifierWidth = 1;
const commandWidth = scaledWidth(1.25);
const capsLockWidth = scaledWidth(1.75);
const shiftWidth = scaledWidth(2.25);
const spaceWidth = scaledWidth(5);
const returnWidth = scaledWidth(1.75);
const tabWidth = scaledWidth(1.5);
const bedWidth = 14.5 + gap * 13.5;
const functionHeight = 1;

const key = (
  id: KeyboardKeyId,
  code: string | null,
  legend: string,
  width?: number,
  alternateLegend?: string,
): KeySource => {
  const source: KeySource = { id, code, legend };
  if (width !== undefined) source.width = width;
  if (alternateLegend !== undefined) source.alternateLegend = alternateLegend;
  return source;
};

const letterKeys = (letters: string): KeySource[] =>
  [...letters].map((letter) => key(letter, `Key${letter.toUpperCase()}`, letter.toUpperCase()));

const rows: KeySource[][] = [
  [
    key("escape", "Escape", "esc", tabWidth),
    ...Array.from({ length: 12 }, (_, index) =>
      key(`f${index + 1}`, `F${index + 1}`, `F${index + 1}`),
    ),
    key("touch-id", null, ""),
  ],
  [
    key("backquote", "Backquote", "`", undefined, "~"),
    ...Array.from({ length: 10 }, (_, index) => {
      const digit = String((index + 1) % 10);
      return key(digit, `Digit${digit}`, digit, undefined, "!@#$%^&*()"[index]);
    }),
    key("minus", "Minus", "-", undefined, "_"),
    key("equal", "Equal", "=", undefined, "+"),
    key("delete", "Backspace", "delete", tabWidth),
  ],
  [
    key("tab", "Tab", "tab", tabWidth),
    ...letterKeys("qwertyuiop"),
    key("bracket-left", "BracketLeft", "[", undefined, "{"),
    key("bracket-right", "BracketRight", "]", undefined, "}"),
    key("backslash", "Backslash", "\\", undefined, "|"),
  ],
  [
    key("caps-lock", "CapsLock", "caps lock", capsLockWidth),
    ...letterKeys("asdfghjkl"),
    key("semicolon", "Semicolon", ";", undefined, ":"),
    key("quote", "Quote", "'", undefined, '"'),
    key("return", "Enter", "return", returnWidth),
  ],
  [
    key("lshift", "ShiftLeft", "shift", shiftWidth),
    ...letterKeys("zxcvbnm"),
    key("comma", "Comma", ",", undefined, "<"),
    key("period", "Period", ".", undefined, ">"),
    key("slash", "Slash", "/", undefined, "?"),
    key("rshift", "ShiftRight", "shift", shiftWidth),
  ],
  [
    key("fn", "Fn", "fn", modifierWidth),
    key("control-left", "ControlLeft", "⌃", modifierWidth),
    key("option-left", "AltLeft", "⌥", modifierWidth),
    key("command-left", "MetaLeft", "⌘", commandWidth),
    key("space", "Space", "", spaceWidth),
    key("command-right", "MetaRight", "⌘", commandWidth),
    key("option-right", "AltRight", "⌥", modifierWidth),
    key("arrow-left", "ArrowLeft", "◀"),
    key("arrow-up", "ArrowUp", "▲"),
    key("arrow-down", "ArrowDown", "▼"),
    key("arrow-right", "ArrowRight", "▶"),
  ],
];

function placeRow(source: KeySource[], row: number): KeyboardKey[] {
  const isFunctionRow = row === 0;
  const height = isFunctionRow ? functionHeight : 1;
  const y = isFunctionRow ? 0 : functionHeight + gap + (row - 1) * (1 + gap);
  const widths = source.map(({ width }) => width ?? 1);
  const hasVerticalArrows = source.some(({ id }) => id === "arrow-down");
  const rowWidth =
    widths.reduce(
      (sum, width, index) => sum + (source[index]?.id === "arrow-down" ? 0 : width),
      0,
    ) +
    gap * (source.length - 1 - (hasVerticalArrows ? 1 : 0));
  let x = Math.max(0, (bedWidth - rowWidth) / 2);

  return source.map((sourceKey, column) => {
    const isArrow = sourceKey.id.startsWith("arrow-");
    const isUp = sourceKey.id === "arrow-up";
    const keyHeight = isArrow ? 0.5 : height;
    const keyY = isArrow && !isUp ? y + keyHeight : y;
    const placed = {
      ...sourceKey,
      row,
      column,
      x,
      y: keyY,
      width: widths[column] ?? 1,
      height: keyHeight,
    };
    if (!isUp) x += (widths[column] ?? 1) + gap;
    return placed;
  });
}

export const keyboardKeys = rows.flatMap(placeRow);

export const palette = {
  main: {
    base: "#191724",
    surface: "#1f1d2e",
    overlay: "#26233a",
    muted: "#6e6a86",
    subtle: "#908caa",
    text: "#e0def4",
    love: "#eb6f92",
    gold: "#f6c177",
    rose: "#ebbcba",
    pine: "#31748f",
    foam: "#9ccfd8",
    iris: "#c4a7e7",
  },
  dawn: {
    base: "#faf4ed",
    surface: "#fffaf3",
    overlay: "#f2e9e1",
    muted: "#9893a5",
    subtle: "#797593",
    text: "#464261",
    love: "#b4637a",
    gold: "#ea9d34",
    rose: "#d7827e",
    pine: "#286983",
    foam: "#56949f",
    iris: "#907aa9",
  },
} as const;

export const tokens = {
  space: [4, 8, 12, 16, 24, 32, 48, 64, 96],
  stroke: [1, 2, 3],
  radius: [2, 4, 8, 12, 18],
  opacity: [0.08, 0.14, 0.22, 0.4, 0.64, 0.88, 1],
  scene: {
    perspective: 1800,
    perspectiveOrigin: "50% 45%",
    safeArea: 64,
    wide: { width: 1760, height: 1100, studio: [80, 240], macbook: [1178, 520] },
    stacked: { width: 1100, height: 1550, studio: [50, 40], macbook: [299, 880] },
  },
  hardware: {
    studio: { width: 1000, height: 584, screenWidth: 959, screenHeight: 539, totalHeight: 767 },
    macbook: {
      width: 502,
      depth: 355,
      thickness: 25,
      lidHeight: 338,
      screenWidth: 485,
      screenHeight: 315,
      cameraWidth: 55,
      cameraHeight: 12,
      basePitch: 45,
      lidOpen: 45,
    },
  },
  runtime: { enhancementWatchdog: 4000, bootstrapTimeout: 8000, lazyIdleTimeout: 1000 },
  keyboard: {
    unit: 1,
    gap,
    bedWidth,
    bedHeight: functionHeight + gap + 5 + gap * 4,
    stroke: 0.01,
    touchIdSize: 0.6,
    functionHeight,
    labelSize: 0.6,
    shiftLabelSize: 0.6,
    alternateLabelSize: 0.34,
  },
  motion: {
    press: 90,
    feedback: 160,
    window: 320,
    cursor: 650,
    cursorShort: 500,
    monitorEnter: 1200,
    sceneReframe: 1200,
    lid: 2200,
    wire: 2500,
    power: 2300,
    chordStagger: 140,
    chordPrelude: 210,
    chordHold: 1500,
    twoKeyPrelude: 250,
    twoKeyHold: 1550,
    keyReleaseStagger: 25,
    commandBudget: 150,
    acknowledge: 500,
    commandReadout: 1500,
    reducedFade: 120,
    easing: {
      standard: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      mechanical: "cubic-bezier(0.16, 1, 0.3, 1)",
      layout: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  },
  timeline: {
    duration: 22_000,
    dock: { cursorArrival: 500, submit: 590, commit: 740, complete: 1060 },
    threeKeyChord: {
      first: 0,
      second: 140,
      trigger: 350,
      triggerUp: 1850,
      secondUp: 1875,
      firstUp: 1900,
    },
    twoKeyChord: { modifier: 0, trigger: 250, triggerUp: 1800, modifierUp: 1825 },
  },
} as const;

export type HeroCommand =
  | { type: "moveFocusedWindowToWorkspace"; workspace: HeroWorkspace }
  | { type: "moveDirection"; direction: "left" | "down" | "up" | "right" }
  | { type: "focusDirection"; direction: "left" | "down" | "up" | "right" }
  | { type: "moveFocusedWorkspaceToNextDisplay" }
  | { type: "focusWorkspace"; workspace: HeroWorkspace };

export interface KeyboardChord {
  id: string;
  keys: readonly KeyboardKeyId[];
  trigger: KeyboardKeyId;
  command: HeroCommand;
  readout: string;
  primary?: boolean;
}

const directionalKeys = [
  ["arrow-left", "h", "left"],
  ["arrow-down", "j", "down"],
  ["arrow-up", "k", "up"],
  ["arrow-right", "l", "right"],
] as const;

export const heroKeyboardChords: readonly KeyboardChord[] = [
  ...directionalKeys.flatMap(([arrow, alias, direction]) => [
    {
      id: `move-${direction}`,
      keys: ["lshift", "rshift", arrow],
      trigger: arrow,
      command: { type: "moveDirection" as const, direction },
      readout: `move window ${direction}`,
      primary: true,
    },
    {
      id: `focus-${direction}`,
      keys: ["rshift", arrow],
      trigger: arrow,
      command: { type: "focusDirection" as const, direction },
      readout: `focus window ${direction}`,
      primary: true,
    },
    {
      id: `move-${direction}-hjkl`,
      keys: ["lshift", "rshift", alias],
      trigger: alias,
      command: { type: "moveDirection" as const, direction },
      readout: `move window ${direction}`,
    },
    {
      id: `focus-${direction}-hjkl`,
      keys: ["rshift", alias],
      trigger: alias,
      command: { type: "focusDirection" as const, direction },
      readout: `focus window ${direction}`,
    },
  ]),
  ...HERO_WORKSPACES.flatMap((workspace) => {
    const key = workspace.toLowerCase();
    return [
      {
        id: `move-window-${key}`,
        keys: ["lshift", "rshift", key],
        trigger: key,
        command: { type: "moveFocusedWindowToWorkspace" as const, workspace },
        readout: `move window workspace ${workspace}`,
      },
      {
        id: `focus-workspace-${key}`,
        keys: ["rshift", key],
        trigger: key,
        command: { type: "focusWorkspace" as const, workspace },
        readout: `focus workspace ${workspace}`,
      },
    ];
  }),
  {
    id: "move-workspace-display",
    keys: ["lshift", "rshift", "tab"],
    trigger: "tab",
    command: { type: "moveFocusedWorkspaceToNextDisplay" },
    readout: "move workspace to next display",
  },
];

function sameCommand(left: HeroCommand, right: HeroCommand): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "moveDirection" || left.type === "focusDirection") {
    return "direction" in right && left.direction === right.direction;
  }
  if (left.type === "moveFocusedWindowToWorkspace" || left.type === "focusWorkspace") {
    return "workspace" in right && left.workspace === right.workspace;
  }
  return true;
}

export function primaryKeyboardChord(
  chords: readonly KeyboardChord[],
  command: HeroCommand,
): KeyboardChord | undefined {
  return (
    chords.find((chord) => chord.primary && sameCommand(chord.command, command)) ??
    chords.find((chord) => sameCommand(chord.command, command))
  );
}
