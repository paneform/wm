import type { HeroAppTitle, HeroWorkspace } from "./hero-model.js";

export type DemoCueAction =
  | { readonly type: "hold"; readonly state: string }
  | {
      readonly type: "present";
      readonly name:
        | "open-lid"
        | "signal-lock"
        | "desktop"
        | "monitor-enter"
        | "cable"
        | "power-on"
        | "complete";
    }
  | { readonly type: "activate-app"; readonly app: HeroAppTitle }
  | { readonly type: "launch-wm" }
  | {
      readonly type: "move-direction" | "focus-direction";
      readonly direction: "left" | "down" | "up" | "right";
    }
  | {
      readonly type: "move-window";
      readonly workspace: Exclude<HeroWorkspace, "1">;
    }
  | { readonly type: "connect-display" }
  | { readonly type: "move-workspace-display" }
  | { readonly type: "focus-workspace"; readonly workspace: HeroWorkspace };

export interface DemoCue {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly triggerOffset: number;
  readonly action: DemoCueAction;
}

const cue = (
  id: string,
  start: number,
  end: number,
  action: DemoCueAction,
  triggerOffset = 0,
): DemoCue => ({ id, start, end, action, triggerOffset });

export const demoTimeline: readonly DemoCue[] = [
  cue("closed-hold", 0, 100, { type: "hold", state: "closed" }),
  cue("open-lid", 100, 1300, { type: "present", name: "open-lid" }),
  cue("desktop", 1300, 1500, { type: "present", name: "desktop" }),
  cue("empty-desktop", 1500, 1800, { type: "hold", state: "wm-stopped" }),
  cue("terminal", 1800, 3000, { type: "activate-app", app: "Terminal" }, 590),
  cue("browser", 3000, 4200, { type: "activate-app", app: "Browser" }, 590),
  cue("text-editor", 4200, 5400, { type: "activate-app", app: "Text Editor" }, 590),
  cue("unmanaged-hold", 5400, 6400, { type: "hold", state: "overlapping-windows" }),
  cue("launch-paneform", 6400, 7600, { type: "launch-wm" }, 590),
  cue("layout-hold", 7600, 8800, { type: "hold", state: "tiled-windows" }),
  cue("editor-right", 8800, 10700, { type: "move-direction", direction: "right" }, 350),
  cue("arrangement-hold", 10700, 11900, { type: "hold", state: "terminal-beside-browser-and-editor" }),
  cue("editor-left", 11900, 13800, { type: "move-direction", direction: "left" }, 350),
  cue("select-terminal", 13800, 15600, { type: "focus-direction", direction: "up" }, 250),
  cue("terminal-to-t", 15600, 17500, { type: "move-window", workspace: "T" }, 350),
  cue("waitlist", 17500, 18700, { type: "activate-app", app: "Waitlist" }, 590),
  cue("waitlist-to-w", 18700, 20600, { type: "move-window", workspace: "W" }, 350),
  cue("settings", 20600, 21800, { type: "activate-app", app: "Settings" }, 590),
  cue("complete", 21800, 22000, { type: "present", name: "complete" }),
] as const;

export const DEMO_DURATION = 22_000;

export function validateDemoTimeline(cues: readonly DemoCue[] = demoTimeline): void {
  let cursor = 0;
  for (const current of cues) {
    if (current.start !== cursor || current.end <= current.start)
      throw new Error(`Invalid demo cue ${current.id}`);
    if (current.triggerOffset < 0 || current.start + current.triggerOffset > current.end) {
      throw new Error(`Invalid trigger for demo cue ${current.id}`);
    }
    cursor = current.end;
  }
  if (cursor !== DEMO_DURATION) throw new Error(`Demo timeline must end at ${DEMO_DURATION} milliseconds`);
}
