import type { SimulationState } from "@paneform/layout-browser";
import { DEMO_TIMING } from "./demo-timing.js";

interface IndicatorOrigin {
  id: string;
  workspace: string;
  displayId: string;
  index: number;
  rect: DOMRect;
}

const indicator = (tile: HTMLElement, id: string): HTMLElement | undefined =>
  [...tile.querySelectorAll<HTMLElement>(".workspace-app")].find(
    (app) => app.dataset.windowId === id,
  );

export function captureWorkspaceIndicator(tile: HTMLElement, id: string): IndicatorOrigin | null {
  const app = indicator(tile, id);
  const chip = app?.closest<HTMLElement>(".workspace-chip");
  const screen = app?.closest<HTMLElement>(".preview-screen");
  if (!app || !chip?.dataset.workspace || !screen?.dataset.displayId) return null;
  return {
    id,
    workspace: chip.dataset.workspace,
    displayId: screen.dataset.displayId,
    index: [...app.parentElement!.children].indexOf(app),
    rect: app.getBoundingClientRect(),
  };
}

export function captureWorkspaceIndicators(
  tile: HTMLElement,
  state: SimulationState,
): IndicatorOrigin[] {
  return state.windows.flatMap((window) => {
    const origin = captureWorkspaceIndicator(tile, window.id);
    return origin ? [origin] : [];
  });
}

function changedLocation(destination: HTMLElement, origin: IndicatorOrigin): boolean {
  const destinationChip = destination?.closest<HTMLElement>(".workspace-chip");
  const destinationScreen = destination?.closest<HTMLElement>(".preview-screen");
  return (
    destinationChip?.dataset.workspace !== origin.workspace ||
    destinationScreen?.dataset.displayId !== origin.displayId
  );
}

function sourceApps(tile: HTMLElement, origin: IndicatorOrigin): HTMLElement | undefined {
  const sourceScreen = [...tile.querySelectorAll<HTMLElement>(".preview-screen")].find(
    (screen) => screen.dataset.displayId === origin.displayId,
  );
  const source = [...(sourceScreen?.querySelectorAll<HTMLElement>(".workspace-chip") ?? [])].find(
    (chip) => chip.dataset.workspace === origin.workspace,
  );
  return source?.querySelector<HTMLElement>(".workspace-apps") ?? undefined;
}

function reserveSlot(apps: HTMLElement, index: number): HTMLElement {
  const ghost = document.createElement("span");
  ghost.className = "workspace-app-placeholder";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.visibility = "hidden";
  apps.insertBefore(ghost, apps.children[index] ?? null);
  return ghost;
}

function createTraveler(tile: HTMLElement, origin: IndicatorOrigin): HTMLElement {
  const bounds = tile.getBoundingClientRect();
  const traveler = document.createElement("span");
  traveler.className = "travel-app";
  traveler.dataset.windowId = origin.id;
  traveler.setAttribute("aria-hidden", "true");
  traveler.style.left = `${origin.rect.left - bounds.left - tile.clientLeft}px`;
  traveler.style.top = `${origin.rect.top - bounds.top - tile.clientTop}px`;
  tile.appendChild(traveler);
  return traveler;
}

function startTravel(traveler: HTMLElement, origin: IndicatorOrigin, target: DOMRect): Animation {
  return traveler.animate(
    [
      { transform: "translate(0, 0)" },
      {
        transform: `translate(${target.left - origin.rect.left}px, ${target.top - origin.rect.top}px)`,
      },
    ],
    {
      duration: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 0
        : DEMO_TIMING.transitionMs,
      easing: "ease-in-out",
    },
  );
}

function cleanupTravel(
  animation: Animation,
  traveler: HTMLElement,
  ghost: HTMLElement,
  destination: HTMLElement,
): () => void {
  const cleanup = () => {
    animation.cancel();
    traveler.remove();
    ghost.remove();
    destination.style.removeProperty("visibility");
  };
  animation.addEventListener("finish", cleanup, { once: true });
  return cleanup;
}

export function animateWorkspaceIndicator(
  tile: HTMLElement,
  origin: IndicatorOrigin | null,
  state: SimulationState,
): (() => void) | null {
  if (!origin || !state.windows.some((window) => window.id === origin.id)) return null;
  const destination = indicator(tile, origin.id);
  if (!destination || !changedLocation(destination, origin)) return null;
  const apps = sourceApps(tile, origin);
  if (!apps) return null;
  const ghost = reserveSlot(apps, origin.index);
  destination.style.visibility = "hidden";
  const target = destination.getBoundingClientRect();
  const traveler = createTraveler(tile, origin);
  return cleanupTravel(startTravel(traveler, origin, target), traveler, ghost, destination);
}

export function animateWorkspaceIndicators(
  tile: HTMLElement,
  origins: readonly IndicatorOrigin[],
  state: SimulationState,
): () => void {
  const cleanups = origins.flatMap((origin) => {
    const cleanup = animateWorkspaceIndicator(tile, origin, state);
    return cleanup ? [cleanup] : [];
  });
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
