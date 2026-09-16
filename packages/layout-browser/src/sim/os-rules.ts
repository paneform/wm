import type { DisplayObservation, Frame } from "@paneform/layout";

export interface OsGeometryRequest {
  readonly previous: Frame;
  readonly requested: Frame;
  readonly displays: readonly DisplayObservation[];
  readonly operation: "position" | "size" | "external";
}

/** A deterministic physical response, independent of window-manager policy. */
export interface OsRuleset {
  readonly name: string;
  applyGeometry(request: OsGeometryRequest): Frame;
}

export const unconstrainedOsRules: OsRuleset = {
  name: "unconstrained",
  applyGeometry: ({ requested }) => ({ ...requested }),
};
