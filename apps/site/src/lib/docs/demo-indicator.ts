import type { SimulationState } from "@paneform/layout-browser";

interface IndicatorOrigin {
  id: string;
  workspace: string;
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
  if (!app || !chip?.dataset.workspace) return null;
  return {
    id,
    workspace: chip.dataset.workspace,
    index: [...app.parentElement!.children].indexOf(app),
    rect: app.getBoundingClientRect(),
  };
}

export function animateWorkspaceIndicator(
  tile: HTMLElement,
  origin: IndicatorOrigin | null,
  state: SimulationState,
): (() => void) | null {
  if (
    !origin ||
    state.windows.find((window) => window.id === origin.id)?.workspace === origin.workspace
  )
    return null;
  const destination = indicator(tile, origin.id);
  const source = [...tile.querySelectorAll<HTMLElement>(".workspace-chip")].find(
    (chip) => chip.dataset.workspace === origin.workspace,
  );
  const screen = tile.querySelector<HTMLElement>(".preview-screen");
  const apps = source?.querySelector<HTMLElement>(".workspace-apps");
  if (!destination || !screen || !apps) return null;

  const ghost = document.createElement("span");
  ghost.className = "workspace-app";
  ghost.style.visibility = "hidden";
  apps.insertBefore(ghost, apps.children[origin.index] ?? null);
  destination.style.visibility = "hidden";
  const target = destination.getBoundingClientRect();
  const bounds = screen.getBoundingClientRect();
  const traveler = document.createElement("span");
  traveler.className = "travel-app";
  traveler.style.left = `${origin.rect.left - bounds.left}px`;
  traveler.style.top = `${origin.rect.top - bounds.top}px`;
  screen.appendChild(traveler);

  const animation = traveler.animate(
    [
      { transform: "translate(0, 0)" },
      {
        transform: `translate(${target.left - origin.rect.left}px, ${target.top - origin.rect.top}px)`,
      },
    ],
    {
      duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500,
      easing: "ease-in-out",
    },
  );
  const cleanup = () => {
    animation.cancel();
    traveler.remove();
    ghost.remove();
    destination.style.removeProperty("visibility");
  };
  animation.addEventListener("finish", cleanup, { once: true });
  return cleanup;
}
