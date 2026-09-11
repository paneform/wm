export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfaceWindow {
  id: string;
  title: string;
  frame: Frame;
}

export type AppIcon =
  | "paneform"
  | "text-editor"
  | "browser"
  | "terminal"
  | "music"
  | "contacts"
  | "messages"
  | "settings";

export interface DockItem {
  id: string;
  title: string;
  icon?: AppIcon;
  open: boolean;
}
