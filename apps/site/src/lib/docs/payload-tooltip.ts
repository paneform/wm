import type { Action } from "svelte/action";

/** Hover documentation for [data-tip] payload lines. The tooltip element is
 * portaled to document.body and positioned with viewport coordinates so
 * overflow-hidden ancestors (tables, code blocks) can never clip it. */
export const payloadTooltips: Action<HTMLElement> = (container) => {
  let tip: HTMLDivElement | null = null;
  let current: Element | null = null;

  const hide = (): void => {
    current = null;
    tip?.remove();
    tip = null;
  };

  const show = (line: Element): void => {
    if (tip === null) {
      tip = document.createElement("div");
      tip.className = "payload-tooltip";
      document.body.append(tip);
    }
    tip.textContent = line.getAttribute("data-tip") ?? "";
    const rect = line.getBoundingClientRect();
    const below = rect.bottom + 6;
    const flip = below + tip.offsetHeight > window.innerHeight && rect.top > tip.offsetHeight + 6;
    tip.style.left = `${Math.round(rect.left)}px`;
    tip.style.top = `${Math.round(flip ? rect.top - tip.offsetHeight - 6 : below)}px`;
  };

  const over = (event: Event): void => {
    const line = event.target instanceof Element ? event.target.closest("[data-tip]") : null;
    if (line === current) return;
    current = line;
    if (line !== null) show(line);
    else hide();
  };

  container.addEventListener("pointerover", over);
  container.addEventListener("pointerleave", hide);
  return {
    destroy: () => {
      container.removeEventListener("pointerover", over);
      container.removeEventListener("pointerleave", hide);
      hide();
    },
  };
};
