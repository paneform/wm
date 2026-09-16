import type { DisplayObservation, Frame } from "@paneform/layout";
import type { OsRuleset } from "./os-rules.js";

export interface MacOsRulesOptions {
  /** Fully concealed horizontal requests snap back by this many logical points. */
  readonly horizontalFallback?: number | undefined;
  /** Minimum vertical intersection at the bottom edge, in logical points. */
  readonly bottomVisible?: number | undefined;
}

function overlapArea(a: Frame, b: Frame): number {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}

function centerDistance(frame: Frame, bounds: Frame): number {
  const x = frame.x + frame.width / 2;
  const y = frame.y + frame.height / 2;
  const dx = Math.max(bounds.x - x, 0, x - bounds.x - bounds.width);
  const dy = Math.max(bounds.y - y, 0, y - bounds.y - bounds.height);
  return dx * dx + dy * dy;
}

function hostDisplay(frame: Frame, displays: readonly DisplayObservation[]) {
  return displays.reduce<DisplayObservation | undefined>((best, display) => {
    if (best === undefined) return display;
    const area = overlapArea(frame, display.frame);
    const bestArea = overlapArea(frame, best.frame);
    if (area !== bestArea) return area > bestArea ? display : best;
    return centerDistance(frame, display.frame) < centerDistance(frame, best.frame)
      ? display
      : best;
  }, undefined);
}

function constrainFrame(
  frame: Frame,
  host: DisplayObservation,
  horizontal: number,
  bottom: number,
): Frame {
  const bounds = host.frame;
  const visibleWidth = Math.min(horizontal, frame.width, bounds.width);
  const visibleHeight = Math.min(bottom, frame.height, bounds.height);
  const top = Math.max(bounds.y, host.workArea.y);
  let x = frame.x;
  // One-point parking is accepted; only zero horizontal intersection triggers fallback.
  if (x + frame.width <= bounds.x) x = bounds.x - frame.width + visibleWidth;
  else if (x >= bounds.x + bounds.width) x = bounds.x + bounds.width - visibleWidth;
  const y = Math.min(
    Math.max(frame.y, top),
    Math.max(top, bounds.y + bounds.height - visibleHeight),
  );
  return { ...frame, x, y };
}

/** Messages probe profile; see SCENARIOS.md for measurements and model limits. */
export function createMacOsRules(options: MacOsRulesOptions = {}): OsRuleset {
  const horizontal = options.horizontalFallback ?? 40;
  const bottom = options.bottomVisible ?? 52;
  if (
    ![horizontal, bottom].every((value) => Number.isFinite(value) && value > 0 && value <= 10_000)
  ) {
    throw new RangeError(
      "macOS visibility distances must be finite and between 0 (exclusive) and 10000",
    );
  }
  return {
    name: "macos",
    applyGeometry: ({ requested, displays }) => {
      // A legal placement on any display stays legal, even if correcting it changed the largest overlap.
      const valid = displays.some((display) => {
        const frame = constrainFrame(requested, display, horizontal, bottom);
        return frame.x === requested.x && frame.y === requested.y;
      });
      if (valid) return { ...requested };
      const host = hostDisplay(requested, displays);
      return host === undefined
        ? { ...requested }
        : constrainFrame(requested, host, horizontal, bottom);
    },
  };
}

export const macOsRules = createMacOsRules();
