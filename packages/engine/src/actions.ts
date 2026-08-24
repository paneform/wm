import { Schema } from "effect";
import { Frame, Point } from "./schema.ts";
import type { SplitAxis } from "./world.ts";
// Engine → executor actions. docs/rewrite/engine-guide.md §Actions.
// Rules emit these; the transaction executor applies them via adapter
// primitives. Actions are pure data — no I/O happens inside rules.

export const SetFrameAction = Schema.Struct({
  kind: Schema.Literal("setFrame"),
  windowId: Schema.String,
  frame: Frame,
});
export interface SetFrameAction extends Schema.Schema.Type<typeof SetFrameAction> {}

export const SetPositionAction = Schema.Struct({
  kind: Schema.Literal("setPosition"),
  windowId: Schema.String,
  point: Point,
});
export interface SetPositionAction extends Schema.Schema.Type<typeof SetPositionAction> {}

export const FocusWindowAction = Schema.Struct({
  kind: Schema.Literal("focusWindow"),
  windowId: Schema.String,
});
export interface FocusWindowAction extends Schema.Schema.Type<typeof FocusWindowAction> {}

export const InsertWindowAction = Schema.Struct({
  kind: Schema.Literal("insertWindow"),
  windowId: Schema.String,
  workspace: Schema.String,
  beside: Schema.optional(Schema.String),
  axis: Schema.optional(Schema.Literal("vertical", "horizontal")),
  floating: Schema.optional(Schema.Boolean),
});
export interface InsertWindowAction extends Schema.Schema.Type<typeof InsertWindowAction> {}

export const RemoveWindowAction = Schema.Struct({
  kind: Schema.Literal("removeWindow"),
  windowId: Schema.String,
});
export interface RemoveWindowAction extends Schema.Schema.Type<typeof RemoveWindowAction> {}

export const FloatWindowAction = Schema.Struct({
  kind: Schema.Literal("floatWindow"),
  windowId: Schema.String,
});
export interface FloatWindowAction extends Schema.Schema.Type<typeof FloatWindowAction> {}

export const TileWindowAction = Schema.Struct({
  kind: Schema.Literal("tileWindow"),
  windowId: Schema.String,
});
export interface TileWindowAction extends Schema.Schema.Type<typeof TileWindowAction> {}

export const ParkWorkspaceAction = Schema.Struct({
  kind: Schema.Literal("parkWorkspace"),
  workspace: Schema.String,
});
export interface ParkWorkspaceAction extends Schema.Schema.Type<typeof ParkWorkspaceAction> {}

export const RevealWorkspaceAction = Schema.Struct({
  kind: Schema.Literal("revealWorkspace"),
  workspace: Schema.String,
  displayId: Schema.String,
});
export interface RevealWorkspaceAction extends Schema.Schema.Type<typeof RevealWorkspaceAction> {}

export const AssignWorkspaceDisplayAction = Schema.Struct({
  kind: Schema.Literal("assignWorkspaceDisplay"),
  workspace: Schema.String,
  displayId: Schema.String,
});
export interface AssignWorkspaceDisplayAction
  extends Schema.Schema.Type<typeof AssignWorkspaceDisplayAction>
{}

export const LearnConstraintsAction = Schema.Struct({
  kind: Schema.Literal("learnConstraints"),
  windowId: Schema.String,
  minWidth: Schema.optional(Schema.Number),
  maxWidth: Schema.optional(Schema.Number),
  minHeight: Schema.optional(Schema.Number),
  maxHeight: Schema.optional(Schema.Number),
});
export interface LearnConstraintsAction extends Schema.Schema.Type<typeof LearnConstraintsAction> {}

export const EmitDiagnosticAction = Schema.Struct({
  kind: Schema.Literal("emitDiagnostic"),
  code: Schema.String,
  detail: Schema.optional(Schema.String),
});
export interface EmitDiagnosticAction extends Schema.Schema.Type<typeof EmitDiagnosticAction> {}

export const Action = Schema.Union(
  SetFrameAction,
  SetPositionAction,
  FocusWindowAction,
  InsertWindowAction,
  RemoveWindowAction,
  FloatWindowAction,
  TileWindowAction,
  ParkWorkspaceAction,
  RevealWorkspaceAction,
  AssignWorkspaceDisplayAction,
  LearnConstraintsAction,
  EmitDiagnosticAction,
);
export type Action = typeof Action.Type;

/** Stable dedupe key for a plan (identical actions collapse). */
export function actionKey(action: Action): string {
  switch (action.kind) {
    case "insertWindow":
      return `${action.kind}|${action.windowId}|${action.workspace}`;
    case "removeWindow":
    case "floatWindow":
    case "tileWindow":
    case "focusWindow":
      return `${action.kind}|${action.windowId}`;
    case "setFrame":
      return `${action.kind}|${action.windowId}|${JSON.stringify(action.frame)}`;
    case "setPosition":
      return `${action.kind}|${action.windowId}|${JSON.stringify(action.point)}`;
    default:
      return `${action.kind}|${JSON.stringify(action)}`;
  }
}

/** Dedupe a plan preserving order. */
export function dedupeActions(actions: readonly Action[]): Action[] {
  const seen = new Set<string>();
  const out: Action[] = [];
  for (const action of actions) {
    const key = actionKey(action);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(action);
    }
  }
  return out;
}

