export const HERO_SEED = 0x50414e45;
export const MACBOOK_DISPLAY_ID = "display:hero-macbook";
export const STUDIO_DISPLAY_ID = "display:hero-studio";
export { HERO_WORKSPACES, type HeroWorkspace } from "./workspace-model.js";

import type { AppIcon } from "../desktop/desktop-model.js";

export type HeroAppIcon = AppIcon;

export interface HeroApp {
  readonly title: string;
  readonly icon: HeroAppIcon;
  readonly bundleId: string;
  readonly minWidth?: number | null;
  readonly maxWidth?: number | null;
  readonly minHeight?: number | null;
  readonly maxHeight?: number | null;
}

export const HERO_APPS = [
  {
    title: "Paneform",
    icon: "paneform",
    bundleId: "com.paneform.wm",
  },
  { title: "Browser", icon: "browser", bundleId: "com.paneform.hero.browser" },
  {
    title: "Terminal",
    icon: "terminal",
    bundleId: "com.paneform.hero.terminal",
  },
  {
    title: "Text Editor",
    icon: "text-editor",
    bundleId: "com.paneform.hero.text-editor",
  },
  { title: "Music", icon: "music", bundleId: "com.paneform.hero.music" },
  {
    title: "Contacts",
    icon: "contacts",
    bundleId: "com.paneform.hero.contacts",
  },
  {
    title: "Messages",
    icon: "messages",
    bundleId: "com.paneform.hero.messages",
  },
  {
    title: "Settings",
    icon: "settings",
    bundleId: "com.apple.systempreferences",
    maxWidth: 723,
  },
] as const satisfies readonly HeroApp[];

export type HeroAppTitle = (typeof HERO_APPS)[number]["title"];

export function getHeroApp(title: HeroAppTitle): HeroApp {
  const app = HERO_APPS.find((candidate) => candidate.title === title);
  if (app === undefined) throw new Error(`Unknown hero app ${title}`);
  return app;
}
