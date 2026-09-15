import type { DemoCueAction } from "./demo-timeline.js";

export const heroFeatures = {
  secondMonitor: false,
};

/** Skip both presentation and simulation commands for the external monitor. */
export function isHeroActionEnabled(action: DemoCueAction, features = heroFeatures): boolean {
  if (features.secondMonitor) return true;
  switch (action.type) {
    case "connect-display":
    case "move-workspace-display":
      return false;
    case "present":
      return !["monitor-enter", "cable", "power-on"].includes(action.name);
    default:
      return true;
  }
}
