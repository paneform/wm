// oxlint-disable -- CDP messages and browser evaluations are intentionally dynamic boundaries.

import type { LayoutScenario } from "@paneform/layout-browser";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeScenarioFragment, encodeScenarioFragment } from "../src/lib/play/scenario-url.ts";

const pageUrl = new URL(process.env.WM_PLAY_URL ?? "http://127.0.0.1:4173/wm/play/");
const outputDir = resolve(process.env.WM_PLAY_SCREENSHOT_DIR ?? resolve(tmpdir(), "wm-play"));
const chromePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const heroScenario = JSON.parse(
  await readFile(resolve(scriptDir, "../src/lib/play/hero.scenario.json"), "utf8"),
) as LayoutScenario;

type Target = { type: string; webSocketDebuggerUrl?: string };
type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};
type Viewport = { width: number; height: number };
type Point = { x: number; y: number };
type Frame = { x: number; y: number; width: number; height: number };

class CdpClient {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private readonly socket: WebSocket;
  private readonly ready: Promise<void>;

  constructor(webSocketUrl: string) {
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.onopen = () => resolveReady();
      this.socket.onerror = () => rejectReady(new Error("Could not connect to Chrome DevTools"));
    });
    this.socket.onmessage = (event) => this.handleMessage(String(event.data));
  }

  async command<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    return new Promise<T>((resolveCommand, rejectCommand) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
  }

  close(): void {
    this.socket.close();
  }

  private handleMessage(source: string): void {
    const message = JSON.parse(source) as CdpMessage;
    if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? [])
        listener(message.params ?? {});
      return;
    }
    if (message.id === undefined) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (message.error)
      request.reject(new Error(message.error.message ?? "Chrome DevTools command failed"));
    else request.resolve(message.result);
  }
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(resolveClose));
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a Chrome debugging port");
  return address.port;
}

async function findTarget(endpoint: string): Promise<Target & { webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`${endpoint}/json/list`).catch(() => null);
    const targets = response ? ((await response.json()) as Target[]) : [];
    const target = targets.find(
      (candidate): candidate is Target & { webSocketDebuggerUrl: string } =>
        candidate.type === "page" && Boolean(candidate.webSocketDebuggerUrl),
    );
    if (target) return target;
    await sleep(100);
  }
  throw new Error(`Chrome did not expose a page target at ${endpoint}`);
}

async function evaluate<T>(
  client: CdpClient,
  expression: string,
  awaitPromise = false,
): Promise<T> {
  const response = await client.command<{
    result?: { value?: T; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (response.exceptionDetails) {
    throw new Error(
      `Browser evaluation failed: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? expression}`,
    );
  }
  if (!response.result || !("value" in response.result))
    throw new Error(
      `Chrome evaluation returned no value: ${response.result?.description ?? expression}`,
    );
  return response.result.value as T;
}

async function waitFor<T>(
  client: CdpClient,
  label: string,
  expression: string,
  timeout = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T | undefined;
  while (Date.now() < deadline) {
    value = await evaluate<T>(client, `(${expression}) ?? false`);
    if (value) return value;
    await sleep(50);
  }
  throw new Error(
    `${label} did not become true within ${timeout}ms; last value: ${JSON.stringify(value)}`,
  );
}

async function screenshot(client: CdpClient, name: string): Promise<void> {
  const response = await client.command<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(resolve(outputDir, name), Buffer.from(response.data, "base64"));
}

async function navigate(client: CdpClient, url: URL, viewport?: Viewport): Promise<void> {
  if (viewport) {
    await client.command("Emulation.setDeviceMetricsOverride", {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: viewport.width < 600,
    });
  }
  await client.command("Page.navigate", { url: url.href });
  await waitFor(
    client,
    `page ${url.pathname} readiness`,
    "document.readyState === 'complete' && Boolean(document.querySelector('main, .hero'))",
    10_000,
  );
  if (url.pathname.startsWith("/wm/play")) {
    const expected = url.hash.startsWith("#scenario=")
      ? JSON.stringify(await decodeScenarioFragment(url.hash))
      : null;
    await waitFor(
      client,
      "scenario worker readiness",
      `(() => {
        const status = document.querySelector('.status')?.textContent ?? '';
         const expected = ${JSON.stringify(expected)};
         const source = document.querySelector('#scenario-json')?.value;
         const matches = !expected || (source && JSON.stringify(JSON.parse(source)) === expected);
         return matches && document.querySelector('.player')?.getAttribute('aria-busy') !== 'true' && ![...document.querySelectorAll('button')].some((button) => button.disabled && /Create scenario|Reset playground/.test(button.textContent ?? '')) && /Playground ready\.|Shared scenario loaded|Scenario loaded/.test(status);
      })()`,
      10_000,
    );
  }
}

async function center(client: CdpClient, selector: string): Promise<Point> {
  const point = await evaluate<Point | null>(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return null;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return rect.width > 0 && rect.height > 0 && document.elementFromPoint(x, y)?.closest(${JSON.stringify(selector)}) === element ? { x, y } : null;
    })()`,
  );
  assert(point, `Element is missing, hidden, or not hit-testable: ${selector}`);
  return point;
}

async function click(client: CdpClient, selector: string): Promise<void> {
  const point = await center(client, selector);
  await client.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await client.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
  });
}

async function clickButton(client: CdpClient, label: string, scope = "document"): Promise<void> {
  const selector = await evaluate<string | null>(
    client,
    `(() => {
      const root = ${scope};
      const buttons = [...root.querySelectorAll('button')];
      const index = buttons.findIndex((button) => button.textContent?.trim() === ${JSON.stringify(label)} && !button.disabled);
      if (index < 0) return null;
      buttons[index].dataset.cdpTarget = 'true';
      return '[data-cdp-target="true"]';
    })()`,
  );
  assert(selector, `Enabled button is missing: ${label}`);
  await click(client, selector);
  await evaluate(
    client,
    "document.querySelector('[data-cdp-target]')?.removeAttribute('data-cdp-target'); true",
  );
}

async function drag(client: CdpClient, selector: string, dx: number, dy: number): Promise<void> {
  const start = await center(client, selector);
  const end = { x: start.x + dx, y: start.y + dy };
  await client.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...start,
    button: "left",
    clickCount: 1,
  });
  await client.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...end,
    button: "left",
    buttons: 1,
  });
  await client.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...end,
    button: "left",
    clickCount: 1,
  });
}

async function setValue(client: CdpClient, selector: string, value: string): Promise<void> {
  const changed = await evaluate<boolean>(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return false;
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      return true;
    })()`,
  );
  assert(changed, `Could not set form value: ${selector}`);
}

async function key(client: CdpClient, keyValue: string, code = keyValue): Promise<void> {
  const windowsVirtualKeyCode = {
    Enter: 13,
    " ": 32,
    Backspace: 8,
    Escape: 27,
    ArrowDown: 40,
    ArrowUp: 38,
    Tab: 9,
  }[keyValue];
  await client.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: keyValue,
    code,
    windowsVirtualKeyCode,
  });
  await client.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyValue,
    code,
    windowsVirtualKeyCode,
  });
}

async function typeBuilderToken(
  client: CdpClient,
  value: string,
  terminator: " " | "Enter" = " ",
): Promise<void> {
  await client.command("Input.insertText", { text: value });
  await key(client, terminator, terminator === " " ? "Space" : "Enter");
}

async function clearBuilder(client: CdpClient): Promise<void> {
  await client.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 4,
    windowsVirtualKeyCode: 65,
    commands: ["selectAll"],
  });
  await client.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 4,
  });
  await key(client, "Backspace");
}

async function builderOptions(client: CdpClient): Promise<string[]> {
  return evaluate<string[]>(
    client,
    "[...document.querySelectorAll('.step-editor [role=listbox] > [role=option]')].map((option) => option.querySelector('span')?.textContent?.trim() ?? '')",
  );
}

async function assertNoAlert(client: CdpClient, label: string): Promise<void> {
  assert(
    !(await evaluate<boolean>(client, "Boolean(document.querySelector('[role=alert]'))")),
    `${label}: an unexpected alert was rendered`,
  );
}

async function scenarioDocument(client: CdpClient): Promise<LayoutScenario> {
  return JSON.parse(
    await evaluate<string>(client, "document.querySelector('#scenario-json')?.value"),
  );
}

async function windowFrame(client: CdpClient, id: string): Promise<Frame> {
  const frame = await evaluate<Frame | null>(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(`[data-window-id="${id}"]`)});
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      const number = (name) => Number.parseFloat(style.getPropertyValue(name));
      return { x: number('--window-x'), y: number('--window-y'), width: number('--window-width'), height: number('--window-height') };
    })()`,
  );
  assert(frame, `Window frame is unavailable: ${id}`);
  return frame;
}

function changedFrame(before: Frame, after: Frame): boolean {
  return (Object.keys(before) as (keyof Frame)[]).some(
    (key) => Math.abs(before[key] - after[key]) > 0.1,
  );
}

async function assertPageHealth(client: CdpClient, label: string): Promise<void> {
  const health = await evaluate<{ overflow: boolean; stage: boolean; devices: number }>(
    client,
    `({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      stage: Boolean(document.querySelector('.stage')),
      devices: document.querySelectorAll('.device').length
    })`,
  );
  assert(health.stage, `${label}: scenario stage is missing`);
  assert(health.devices > 0, `${label}: no display device rendered`);
  assert(!health.overflow, `${label}: document has horizontal overflow`);
}

async function assertDocksWithinWorkAreas(client: CdpClient, label: string): Promise<void> {
  const result = await evaluate<{ checked: number; failures: string[] }>(
    client,
    `(() => {
      const scenario = JSON.parse(document.querySelector('#scenario-json').value);
      const failures = [];
      let checked = 0;
      for (const device of document.querySelectorAll('.stage .device[data-display-id]')) {
        const display = scenario.state.topology.find((item) => item.id === device.dataset.displayId);
        const surface = device.querySelector('.display-surface');
        const dock = device.querySelector('.screen-dock');
        if (!display || !(surface instanceof HTMLElement) || !(dock instanceof HTMLElement)) continue;
        const workArea = display.workArea ?? display.frame;
        const reserved = display.frame.y + display.frame.height - (workArea.y + workArea.height);
        if (reserved <= 0) continue;
        checked += 1;
        const screen = surface.getBoundingClientRect();
        const dockRect = dock.getBoundingClientRect();
        const projectedBottom = screen.top + ((workArea.y + workArea.height - display.frame.y) / display.frame.height) * screen.height;
         if (dockRect.top < projectedBottom - 2) failures.push(device.dataset.displayId + ': dock overlaps work area (' + dockRect.top + ' < ' + projectedBottom + ')');
         if (dockRect.bottom > screen.bottom + 2 || dockRect.left < screen.left - 2 || dockRect.right > screen.right + 2) failures.push(device.dataset.displayId + ': dock extends beyond the screen');
      }
      return { checked, failures };
    })()`,
  );
  assert(result.checked > 0, `${label}: no measurable reserved dock work area`);
  assert(
    result.failures.length === 0,
    `${label}: dock exceeded work area: ${result.failures.join(", ")}`,
  );
}

async function checkInitialAndDirectManipulation(client: CdpClient): Promise<void> {
  await navigate(client, pageUrl, { width: 1920, height: 1080 });
  await assertPageHealth(client, "desktop playground");
  const initial = await evaluate<{
    windows: number;
    laptop: boolean;
    keyboard: boolean;
    dock: boolean;
    top: boolean;
    state: string;
  }>(
    client,
    `({
      windows: document.querySelectorAll('.managed-window').length,
      laptop: Boolean(document.querySelector('.laptop-device')),
      keyboard: Boolean(document.querySelector('.keyboard')),
      dock: Boolean(document.querySelector('.screen-dock')),
      top: Boolean(document.querySelector('.workspace-bar')),
      state: document.querySelector('.advanced .state')?.textContent?.trim() ?? ''
    })`,
  );
  assert(initial.windows === 0, "Raw playground must start without windows");
  assert(
    initial.laptop && initial.keyboard && initial.dock && initial.top,
    "Raw playground is missing its laptop, keyboard, dock, or top bar",
  );
  assert(initial.state === "Stopped", "Raw playground WM must start stopped");
  await assertDocksWithinWorkAreas(client, "laptop");
  await screenshot(client, "desktop-initial.png");

  await click(client, '[data-app="com.paneform.hero.browser"]');
  await waitFor(
    client,
    "Browser window",
    "document.querySelectorAll('.managed-window').length === 1",
  );
  const id = await evaluate<string>(
    client,
    "document.querySelector('.managed-window')?.getAttribute('data-window-id')",
  );
  const opened = await windowFrame(client, id);
  await drag(client, `[data-window-id="${id}"] .window-titlebar`, 70, 35);
  await waitFor(
    client,
    "title-bar drag commit",
    `!document.querySelector(${JSON.stringify(`[data-window-id="${id}"]`)}).classList.contains('dragging')`,
  );
  const moved = await windowFrame(client, id);
  assert(
    changedFrame(opened, moved),
    "Native title-bar drag did not change the CSS percentage frame",
  );
  await drag(client, `[data-window-id="${id}"] [data-resize-edge="e"]`, 45, 0);
  const resized = await waitFor<Frame | false>(
    client,
    "east resize commit",
    `(() => { const e = document.querySelector(${JSON.stringify(`[data-window-id="${id}"]`)}); if (!e || e.classList.contains('dragging')) return false; const s=getComputedStyle(e); const f={x:parseFloat(s.getPropertyValue('--window-x')),y:parseFloat(s.getPropertyValue('--window-y')),width:parseFloat(s.getPropertyValue('--window-width')),height:parseFloat(s.getPropertyValue('--window-height'))}; return Math.abs(f.width-${moved.width}) > .1 ? f : false; })()`,
  );
  assert(changedFrame(moved, resized), "Native east resize did not change the window frame");
  await click(client, `[data-window-id="${id}"] .close-window`);
  await waitFor(
    client,
    "last window close",
    "document.querySelectorAll('.managed-window').length === 0",
  );
}

async function checkServicesPresentationAndDisplays(client: CdpClient): Promise<void> {
  await click(client, '[data-app="com.paneform.hero.browser"]');
  await click(client, '[data-app="com.paneform.hero.terminal"]');
  await waitFor(
    client,
    "two app windows",
    "document.querySelectorAll('.managed-window').length === 2",
  );
  const before = await evaluate<string[]>(
    client,
    "[...document.querySelectorAll('.managed-window')].map((e) => e.getAttribute('style'))",
  );
  await click(client, '[data-app="com.paneform.wm"]');
  await waitFor(
    client,
    "WM running",
    "document.querySelector('.advanced .state')?.textContent?.trim() === 'Running'",
  );
  const after = await evaluate<string[]>(
    client,
    "[...document.querySelectorAll('.managed-window')].map((e) => e.getAttribute('style'))",
  );
  assert(
    JSON.stringify(before) !== JSON.stringify(after),
    "Starting the WM did not retile physical frames",
  );

  await evaluate(client, "document.querySelector('.advanced').open = true; true");
  await clickButton(client, "Pause", "document.querySelector('.advanced')");
  await waitFor(
    client,
    "WM paused",
    "document.querySelector('.advanced .state')?.textContent?.trim() === 'Paused'",
  );
  const terminalId = await evaluate<string>(
    client,
    "[...document.querySelectorAll('.managed-window')].find((e) => e.textContent.includes('Terminal'))?.dataset.windowId",
  );
  const paused = await windowFrame(client, terminalId);
  await drag(client, `[data-window-id="${terminalId}"] .window-titlebar`, 35, 20);
  const physicallyMoved = await windowFrame(client, terminalId);
  assert(
    changedFrame(paused, physicallyMoved),
    "Paused WM did not permit physical window movement",
  );
  await clickButton(client, "Resume", "document.querySelector('.advanced')");
  await waitFor(
    client,
    "WM resumed",
    "document.querySelector('.advanced .state')?.textContent?.trim() === 'Running'",
  );
  await clickButton(client, "Stop", "document.querySelector('.advanced')");
  await waitFor(
    client,
    "WM stopped",
    "document.querySelector('.advanced .state')?.textContent?.trim() === 'Stopped'",
  );

  const toggles: [string, string][] = [
    ["Laptop keyboard", ".keyboard"],
    ["Dock", ".screen-dock"],
    ["Top bar", ".workspace-bar"],
  ];
  for (const [label, selector] of toggles) {
    const input = `.advanced label:has(input) input[type="checkbox"]`;
    const indexed = await evaluate<number>(
      client,
      `[...document.querySelectorAll(${JSON.stringify(input)})].findIndex((e) => e.parentElement.textContent.trim() === ${JSON.stringify(label)})`,
    );
    assert(indexed >= 0, `${label} presentation toggle is missing`);
    await evaluate(
      client,
      `(() => { const e=[...document.querySelectorAll(${JSON.stringify(input)})][${indexed}]; e.dataset.toggleTarget='true'; return true; })()`,
    );
    await click(client, '[data-toggle-target="true"]');
    await waitFor(
      client,
      `${label} hidden`,
      `!document.querySelector(${JSON.stringify(selector)})`,
    );
    await click(client, '[data-toggle-target="true"]');
    await waitFor(
      client,
      `${label} restored`,
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    );
    await evaluate(
      client,
      "document.querySelector('[data-toggle-target]')?.removeAttribute('data-toggle-target'); true",
    );
  }

  for (const label of ["Move windows", "Resize windows", "Animate"]) {
    const result = await evaluate<boolean>(
      client,
      `(() => { const input=[...document.querySelectorAll('.advanced input[type="checkbox"]')].find((e) => e.parentElement.textContent.trim() === ${JSON.stringify(label)}); if (!input) return false; input.click(); return !input.checked; })()`,
    );
    assert(result, `${label} toggle did not turn off`);
  }
  assert(
    !(await evaluate<boolean>(client, "Boolean(document.querySelector('.resize-handle'))")),
    "Resize handles remain when resizing is disabled",
  );
  assert(
    !(await evaluate<boolean>(
      client,
      "document.querySelector('.managed-window')?.classList.contains('movable')",
    )),
    "Movable affordance remains when movement is disabled",
  );
  assert(
    !(await evaluate<boolean>(
      client,
      "document.querySelector('.display-surface')?.classList.contains('motion')",
    )),
    "Window animation class remains when animation is disabled",
  );
  await setValue(client, '.advanced select[aria-label^="Device for"]', "display");
  await waitFor(
    client,
    "desktop display device",
    "Boolean(document.querySelector('.desktop-display')) && !document.querySelector('.device')?.classList.contains('laptop')",
  );
  await assertDocksWithinWorkAreas(client, "desktop");
  await clickButton(client, "Add display", "document.querySelector('.advanced')");
  await waitFor(client, "second display", "document.querySelectorAll('.device').length === 2");
  await assertDocksWithinWorkAreas(client, "multiple desktop displays");
  await clickButton(client, "Remove", "document.querySelectorAll('.advanced .display-row')[1]");
  await waitFor(client, "display removal", "document.querySelectorAll('.device').length === 1");
}

async function checkAuthoringAndSharing(client: CdpClient): Promise<void> {
  await clickButton(client, "Create scenario");
  await waitFor(
    client,
    "authoring mode",
    "Boolean(document.querySelector('.step-editor')) && document.querySelector('.caption > span')?.textContent?.trim() === 'Start'",
  );
  const firstWindow = await evaluate<string>(
    client,
    "document.querySelector('.managed-window')?.dataset.windowId",
  );
  await click(client, `[data-window-id="${firstWindow}"] .window-titlebar`);
  await waitFor(
    client,
    "window inspector",
    "Boolean(document.querySelector('[data-floating-inspector][data-placement] #window-inspector-title')) && !document.querySelector('[data-floating-inspector] button[type=submit]')?.disabled",
  );
  const panelGeometry = await evaluate<{
    placement: string;
    contained: boolean;
    outsideShowcase: boolean;
    anchored: boolean;
  }>(
    client,
    `(() => {
      const panel = document.querySelector('[data-floating-inspector]');
      const showcase = document.querySelector('.showcase');
      const anchor = document.querySelector('.stage .device[data-display-id] .display-surface');
      if (!(panel instanceof HTMLElement) || !(showcase instanceof HTMLElement) || !(anchor instanceof HTMLElement)) return { placement: '', contained: false, outsideShowcase: false, anchored: false };
      const rect = panel.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const placement = panel.dataset.placement ?? '';
      return {
        placement,
        contained: rect.left >= 11 && rect.top >= 11 && rect.right <= innerWidth - 11 && rect.bottom <= innerHeight - 11,
        outsideShowcase: !showcase.contains(panel) && getComputedStyle(panel).position === 'fixed',
        anchored: placement === 'right' ? rect.left > anchorRect.right : placement === 'left' ? rect.right < anchorRect.left : rect.bottom <= innerHeight - 11
      };
    })()`,
  );
  assert(
    panelGeometry.contained && panelGeometry.outsideShowcase && panelGeometry.anchored,
    `Floating inspector geometry is invalid: ${JSON.stringify(panelGeometry)}`,
  );
  await screenshot(client, "desktop-floating-inspector.png");
  const constraintInputs = await evaluate<string[]>(
    client,
    "[...document.querySelectorAll('[data-floating-inspector] input[type=number]')].map((e) => e.value)",
  );
  assert(
    constraintInputs.every((value) => value === ""),
    "Unset inspector bounds must render as blank inputs",
  );
  await setValue(client, "[data-floating-inspector] .grid label:nth-child(1) input", "320");
  await setValue(client, "[data-floating-inspector] .grid label:nth-child(2) input", "900");
  assert(
    JSON.stringify(
      await evaluate<string[]>(
        client,
        "[...document.querySelectorAll('[data-floating-inspector] .grid label')].map((label) => label.childNodes[0]?.textContent?.trim() ?? '')",
      ),
    ) === JSON.stringify(["Minimum width", "Maximum width", "Minimum height", "Maximum height"]),
    "Window constraint labels changed or were reordered",
  );
  await clickButton(client, "Save", "document.querySelector('[data-floating-inspector]')");
  await waitFor(
    client,
    "saved constraints",
    "JSON.parse(document.querySelector('#scenario-json').value).state.windows[0]?.constraints?.minWidth === 320",
  );
  const constrained = await scenarioDocument(client);
  assert(
    constrained.state.windows[0]?.constraints?.maxWidth === 900,
    "Window maximum width was not saved",
  );

  await clickButton(client, "Add command", "document.querySelector('.step-editor')");
  const commandSelector = '.step-editor input[role="combobox"][aria-label="Next command token"]';
  await waitFor(
    client,
    "empty command builder",
    `document.activeElement?.matches(${JSON.stringify(commandSelector)})`,
  );
  assert(
    (await evaluate(
      client,
      `document.querySelectorAll(${JSON.stringify(commandSelector)}).length`,
    )) === 1,
    "Add command rendered more than one command builder",
  );
  const roots = await builderOptions(client);
  assert(
    roots.includes("window") && roots.includes("workspace") && roots.includes("service"),
    "Initial builder choices are not root command words",
  );
  await client.command("Input.insertText", { text: "win" });
  assert(
    (await evaluate<string>(
      client,
      `document.querySelector(${JSON.stringify(commandSelector)}).value`,
    )) === "win",
    "Current command query is not retained",
  );
  await clearBuilder(client);
  await assertNoAlert(client, "cleared partial command");
  await typeBuilderToken(client, "window");
  const windowPaths = await builderOptions(client);
  assert(
    windowPaths.includes("move") &&
      windowPaths.includes("focus") &&
      windowPaths.includes("probe-limits"),
    "Window builder omits move, focus, or probe-limits paths",
  );
  assert(
    !windowPaths.includes("service") && !windowPaths.includes("workspace"),
    "Window subpath still exposes root choices",
  );
  await screenshot(client, "guided-command-builder.png");
  await clickButton(client, "Clear", "document.querySelector('.new-command')");
  await waitFor(
    client,
    "Clear restores root focus",
    `document.activeElement?.matches(${JSON.stringify(commandSelector)}) && document.querySelectorAll('.step-editor .chip').length === 0`,
  );
  await client.command("Input.insertText", { text: "service" });
  await key(client, "ArrowDown");
  await key(client, " ", "Space");
  assert(
    (await builderOptions(client)).includes("start"),
    "ArrowDown and Space did not advance the highlighted root choice",
  );
  await clickButton(client, "Clear", "document.querySelector('.new-command')");
  await client.command("Input.insertText", { text: "bogus" });
  await key(client, "Enter");
  assert(
    (await evaluate(client, "document.querySelectorAll('.step-editor li').length")) === 0,
    "An invalid value entered the step draft",
  );
  await assertNoAlert(client, "invalid builder value");
  await clickButton(client, "Clear", "document.querySelector('.new-command')");
  for (const token of ["window", "move"]) await typeBuilderToken(client, token);
  await typeBuilderToken(client, "left", "Enter");
  await waitFor(
    client,
    "locally inserted command",
    "document.querySelector('.step-editor code')?.textContent === 'window move left'",
  );
  assert(
    await evaluate<boolean>(
      client,
      "document.querySelector('.step-editor button.primary')?.textContent.trim() === 'Apply steps'",
    ),
    "Step edits should remain local before Apply steps",
  );
  await clickButton(client, "Apply steps", "document.querySelector('.step-editor')");
  await waitFor(
    client,
    "applied step",
    "JSON.parse(document.querySelector('#scenario-json').value).steps?.[0]?.command === 'window move left'",
  );

  const additionalCommands = [
    ["move-window", firstWindow, "10", "20"],
    ["workspace", "focus", "new-workspace"],
    ["workspace", "move-display", "new-workspace", "display:main"],
  ];
  for (const tokens of additionalCommands) {
    await clickButton(client, "Add command", "document.querySelector('.step-editor')");
    await waitFor(
      client,
      "next command builder focus",
      `document.activeElement?.matches(${JSON.stringify(commandSelector)})`,
    );
    for (const [index, token] of tokens.entries())
      await typeBuilderToken(client, token, index === tokens.length - 1 ? "Enter" : " ");
    await clickButton(client, "Apply steps", "document.querySelector('.step-editor')");
    await waitFor(
      client,
      `applied ${tokens.join(" ")}`,
      `JSON.parse(document.querySelector('#scenario-json').value).steps.at(-1)?.command === ${JSON.stringify(tokens.join(" "))}`,
    );
  }

  await setValue(client, ".step-editor li:first-child .presentation input[type=text]", "Keep me");
  await setValue(client, ".step-editor li:first-child .presentation input[type=number]", "275");
  await clickButton(client, "Edit command", "document.querySelector('.step-editor')");
  assert(
    (await evaluate<string>(client, "document.querySelector('.step-editor code')?.textContent")) ===
      "window move left",
    "Existing command row does not preserve its code while editing",
  );
  await client.command("Input.insertText", { text: "partial" });
  assert(
    await evaluate(
      client,
      "document.querySelector('.step-editor .commit button')?.disabled === true",
    ),
    "Apply steps must not discard an open command draft",
  );
  assert(
    await evaluate<boolean>(
      client,
      "[...document.querySelectorAll('.controls button')].find((button) => button.textContent.trim() === 'Play')?.disabled === true",
    ),
    "A dirty partial builder did not disable Play",
  );
  await clickButton(client, "Cancel", "document.querySelector('.step-editor')");
  assert(
    await evaluate<boolean>(
      client,
      "document.querySelector('.step-editor li:first-child input[type=text]')?.value === 'Keep me' && document.querySelector('.step-editor li:first-child input[type=number]')?.value === '275'",
    ),
    "Editing a command discarded its caption or duration draft",
  );
  await clickButton(client, "Edit command", "document.querySelector('.step-editor')");
  await key(client, "Backspace");
  await clearBuilder(client);
  assert(
    (await builderOptions(client)).includes("right"),
    "Editing a saved direction retained only its old branch",
  );
  await typeBuilderToken(client, "right", "Enter");
  const beforeFailedSave = JSON.stringify(await scenarioDocument(client));
  await evaluate(
    client,
    "window.__originalWorkerForSave = window.Worker; window.Worker = class { constructor() { throw new Error('Test worker creation failure'); } }; true",
  );
  await clickButton(client, "Apply steps", "document.querySelector('.step-editor')");
  await waitFor(
    client,
    "failed save retained drafts",
    "document.querySelector('[role=alert]')?.textContent.includes('Test worker creation failure') && document.querySelector('.player').getAttribute('aria-busy') === 'false'",
  );
  assert(
    JSON.stringify(await scenarioDocument(client)) === beforeFailedSave,
    "A failed save changed the exported document",
  );
  assert(
    await evaluate(
      client,
      "document.querySelector('.step-editor .commit span').textContent.includes('Unsaved') && !document.querySelector('.step-editor .commit button').disabled",
    ),
    "A failed save was marked clean",
  );
  await evaluate(
    client,
    "window.Worker = window.__originalWorkerForSave; delete window.__originalWorkerForSave; true",
  );
  await clickButton(client, "Apply steps", "document.querySelector('.step-editor')");
  await waitFor(
    client,
    "caption and duration commit",
    "JSON.parse(document.querySelector('#scenario-json').value).steps[0]?.caption === 'Keep me' && JSON.parse(document.querySelector('#scenario-json').value).steps[0]?.duration === 275 && JSON.parse(document.querySelector('#scenario-json').value).steps[0]?.command === 'window move right'",
  );

  await setValue(
    client,
    ".step-editor li:first-child .presentation input[type=text]",
    "Pending draft",
  );
  await evaluate(
    client,
    `(() => {
    document.querySelector('.step-editor .commit button').click();
    [...document.querySelectorAll('.controls button')].find((button) => button.textContent.trim() === 'Edit starting layout').click();
    return true;
  })()`,
  );
  await waitFor(
    client,
    "superseded save settled",
    "document.querySelector('.player').getAttribute('aria-busy') === 'false'",
  );
  assert(
    (await scenarioDocument(client)).steps?.[0]?.caption === "Keep me",
    "A superseded save changed the committed steps",
  );
  assert(
    await evaluate(
      client,
      "document.querySelector('.step-editor .commit span').textContent.includes('Unsaved')",
    ),
    "A superseded save discarded pending step changes",
  );
  await setValue(client, ".step-editor li:first-child .presentation input[type=text]", "Keep me");
  await clickButton(client, "Apply steps", "document.querySelector('.step-editor')");
  await waitFor(
    client,
    "step edits saved cleanly",
    "document.querySelector('.step-editor .commit span').textContent.includes('up to date') && document.querySelector('.player').getAttribute('aria-busy') === 'false'",
  );

  await evaluate(client, "document.querySelector('.editor').open = true; true");
  await clickButton(client, "Copy share link", "document.querySelector('.editor')");
  const link = await waitFor<string>(
    client,
    "share-link fallback",
    "document.querySelector('#share-link')?.value ?? ''",
  );
  const shared = await decodeScenarioFragment(new URL(link).hash);
  assert(shared, "Generated share link did not decode in Node");
  const current = await scenarioDocument(client);
  assert(
    JSON.stringify(shared.state) === JSON.stringify(current.state),
    "Share link changed scenario state",
  );
  assert(
    JSON.stringify(shared.presentation) === JSON.stringify(current.presentation),
    "Share link changed presentation",
  );
  assert(
    JSON.stringify(shared.steps) === JSON.stringify(current.steps),
    "Share link changed authored steps",
  );
  await navigate(client, new URL(link));
  assert(
    (await evaluate<string>(
      client,
      "document.querySelector('.caption > span')?.textContent.trim()",
    )) === "Start",
    "Shared scenario autoplayed instead of remaining at Start",
  );
  await evaluate(client, "history.back(); true");
  await waitFor(
    client,
    "hash history reset",
    "location.hash === '' && Boolean(document.querySelector('button.primary'))",
  );
}

async function checkHero(client: CdpClient): Promise<void> {
  const heroUrl = new URL("hero/", pageUrl);
  await navigate(client, heroUrl);
  const initial = await scenarioDocument(client);
  assert(
    initial.steps?.length === 12,
    `Hero route must expose 12 steps, found ${initial.steps?.length ?? 0}`,
  );
  assert(
    initial.state.windows.length === 0 && initial.state.wmRunning === false,
    "Hero must start empty with the WM stopped",
  );

  const instantHero = {
    ...heroScenario,
    presentation: { ...heroScenario.presentation, animate: false },
  };
  const fragment = await encodeScenarioFragment(instantHero);
  const encodedUrl = new URL(heroUrl);
  encodedUrl.hash = fragment;
  await navigate(client, encodedUrl);
  await clickButton(client, "Play");
  await waitFor(
    client,
    "12-step hero completion",
    "document.querySelector('.caption > span')?.textContent?.trim() === '12 / 12'",
    12_000,
  );
  const final = await evaluate<{
    visible: string[];
    focused: string | null;
    alternative: string;
    openApps: string[];
  }>(
    client,
    `({
      visible: [...document.querySelectorAll('.managed-window')].map((e) => e.textContent.trim()),
      focused: document.querySelector('.managed-window.focused')?.getAttribute('data-window-id') ?? null,
      alternative: document.querySelector('.text-alternative')?.textContent ?? '',
      openApps: [...document.querySelectorAll('.screen-dock button:has(i.open)')].map((e) => e.getAttribute('data-app'))
    })`,
  );
  assert(final.focused === "terminal", "Hero final focus must be Terminal");
  assert(final.alternative.includes("workspace T"), "Hero final workspace must be T");
  assert(
    final.visible.length === 1 && final.visible[0]?.includes("Terminal"),
    "Only Terminal should be visible on final workspace T",
  );
  assert(
    [
      "com.paneform.hero.browser",
      "com.paneform.hero.terminal",
      "com.paneform.hero.text-editor",
    ].every((id) => final.openApps.includes(id)),
    "Hero lost browser, terminal, or editor physical state",
  );
  for (const route of [pageUrl, heroUrl]) {
    const status = await evaluate<number>(
      client,
      `fetch(${JSON.stringify(new URL("/wm/play/scenario.schema.json", route).href)}).then((response) => response.status)`,
      true,
    );
    assert(status === 200, `Schema endpoint returned ${status} from ${route.pathname}`);
  }
}

async function checkWorkerTimeout(client: CdpClient): Promise<void> {
  await navigate(client, pageUrl);
  await evaluate(client, "document.querySelector('.editor').open = true; true");
  const fixture = {
    state: {
      topology: [
        {
          id: "display:test",
          frame: { x: 0, y: 0, width: 1000, height: 700 },
          workspace: "1",
          primary: true,
        },
      ],
      windows: [{ id: "seed", title: "seed", frame: { x: 10, y: 10, width: 300, height: 200 } }],
      focusedWindow: "seed",
      focusedWorkspace: "1",
      wmRunning: true,
    },
    config: { workspaces: [{ name: "1", assign: [{ title: "^(a+)+$" }] }] },
    presentation: { animate: false },
    steps: [
      {
        event: {
          kind: "window_added",
          window: {
            id: "attack",
            title: `${"a".repeat(40)}!`,
            frame: { x: 20, y: 20, width: 300, height: 200 },
          },
        },
      },
    ],
  };
  await setValue(client, "#scenario-json", JSON.stringify(fixture));
  await clickButton(client, "Load scenario", "document.querySelector('.editor')");
  await waitFor(
    client,
    "timeout fixture load",
    "document.querySelector('.caption > span')?.textContent?.trim() === 'Start' && document.querySelector('.player')?.getAttribute('aria-busy') !== 'true'",
  );
  await clickButton(client, "Play");
  await waitFor(
    client,
    "catastrophic matcher timeout",
    "document.querySelector('[role=alert]')?.textContent.includes('timed out')",
    7_000,
  );
  await clickButton(client, "Edit starting layout");
  await waitFor(
    client,
    "responsive reset after timeout",
    "document.querySelector('.caption > span')?.textContent?.trim() === 'Start' && document.querySelector('.player')?.getAttribute('aria-busy') !== 'true'",
    5_000,
  );
}

async function checkMobile(client: CdpClient): Promise<void> {
  await navigate(client, pageUrl, { width: 390, height: 844 });
  await assertPageHealth(client, "mobile playground");
  const visible = await evaluate<boolean>(
    client,
    `[...document.querySelectorAll('.controls button, .advanced summary')].every((element) => {
      const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
    })`,
  );
  assert(visible, "Mobile controls are not rendered visibly");
  await screenshot(client, "mobile-initial.png");

  const mobileScenario: LayoutScenario = {
    state: {
      topology: [
        { id: "display:main", frame: { x: 0, y: 0, width: 1200, height: 800 }, workspace: "1" },
      ],
      windows: [
        { id: "mobile-window", title: "Mobile", frame: { x: 100, y: 80, width: 700, height: 500 } },
      ],
      focusedWindow: "mobile-window",
      focusedWorkspace: "1",
      wmRunning: false,
    },
    presentation: { device: "display", animate: false },
    steps: [],
  };
  const shortUrl = new URL(pageUrl);
  shortUrl.hash = await encodeScenarioFragment(mobileScenario);
  await navigate(client, shortUrl, { width: 390, height: 600 });
  await click(client, '[data-window-id="mobile-window"] .window-titlebar');
  const panel = await waitFor<{ placement: string; bounded: boolean; scrollable: boolean }>(
    client,
    "short mobile inspector",
    `(() => { const p=document.querySelector('[data-floating-inspector][data-placement]'); if (!(p instanceof HTMLElement)) return false; const r=p.getBoundingClientRect(); const v=visualViewport; const left=v?.offsetLeft ?? 0, top=v?.offsetTop ?? 0, right=left+(v?.width ?? innerWidth), bottom=top+(v?.height ?? innerHeight); return { placement:p.dataset.placement ?? '', bounded:r.left>=left+11&&r.top>=top+11&&r.right<=right-11&&r.bottom<=bottom-11, scrollable:p.scrollHeight<=p.clientHeight || getComputedStyle(p).overflowY==='auto' }; })()`,
  );
  assert(
    panel.placement === "sheet" && panel.bounded && panel.scrollable,
    `Short mobile inspector is unusable: ${JSON.stringify(panel)}`,
  );
  await screenshot(client, "mobile-floating-inspector.png");
  assert(
    await evaluate(
      client,
      `(() => {
    const panel = document.querySelector('[data-floating-inspector]');
    const dock = document.querySelector('.screen-dock');
    if (!panel || !dock) return false;
    const p = panel.getBoundingClientRect(), d = dock.getBoundingClientRect();
    const left = Math.max(p.left, d.left), right = Math.min(p.right, d.right);
    const top = Math.max(p.top, d.top), bottom = Math.min(p.bottom, d.bottom);
    return left >= right || top >= bottom || panel.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
  })()`,
    ),
    "Screen chrome covers the mobile inspector",
  );
  await assertPageHealth(client, "short mobile inspector");
}

async function checkAuthoringRegressions(client: CdpClient): Promise<void> {
  const frame = { x: 0, y: 0, width: 1200, height: 800 };
  const setup: LayoutScenario = {
    state: {
      topology: [{ id: "display:main", frame, workspace: "1" }],
      windows: [
        { id: "A", title: "A", frame: { ...frame, width: 600 } },
        { id: "B", title: "B", frame: { ...frame, x: 600, width: 600 } },
      ],
      focusedWorkspace: "1",
      focusedWindow: "A",
      wmRunning: true,
    },
    presentation: { device: "laptop", animate: true },
    steps: [{ command: "window move right" }],
  };
  const url = new URL(pageUrl);
  url.hash = await encodeScenarioFragment(setup);
  await navigate(client, url);
  await evaluate(
    client,
    `(() => {
    const button = (text) => [...document.querySelectorAll('.controls button')].find((e) => e.textContent.trim() === text);
    button('Step').click(); button('Edit starting layout').click(); return true;
  })()`,
  );
  await waitFor(
    client,
    "reset during chord",
    "document.querySelector('.player').getAttribute('aria-busy') === 'false'",
  );
  await sleep(350);
  assert(
    (await windowFrame(client, "A")).x === 0,
    "A cancelled chord changed the replacement session",
  );

  const replacement = {
    ...setup,
    steps: [],
    presentation: { device: "display", animate: false },
  } satisfies LayoutScenario;
  const fragment = await encodeScenarioFragment(replacement);
  await evaluate(
    client,
    `(() => {
    [...document.querySelectorAll('.controls button')].find((e) => e.textContent.trim() === 'Step').click();
    location.hash = ${JSON.stringify(fragment)}; return true;
  })()`,
  );
  await waitFor(
    client,
    "hash replacement during chord",
    "JSON.parse(document.querySelector('#scenario-json').value).steps.length === 0 && document.querySelector('.player').getAttribute('aria-busy') === 'false'",
  );
  await sleep(350);
  assert(
    (await windowFrame(client, "A")).x === 0,
    "An old chord escaped into a shared replacement scenario",
  );
  assert(
    await evaluate(client, "document.querySelectorAll('.keyboard').length === 0"),
    "Standalone displays must never render a keyboard",
  );

  const workspaceSetup = {
    ...setup,
    steps: [],
    presentation: { device: "display", animate: false },
    state: {
      ...setup.state,
      windows: [
        { id: "A", title: "A", workspace: "1", frame: { x: 30, y: 70, width: 500, height: 360 } },
        { id: "B", title: "B", workspace: "T", frame: { x: 80, y: 100, width: 550, height: 380 } },
      ],
    },
  } satisfies LayoutScenario;
  url.hash = await encodeScenarioFragment(workspaceSetup);
  await navigate(client, url);
  await click(client, '.workspace-bar button[aria-label^="Focus workspace T"]');
  await waitFor(
    client,
    "authoring workspace switch",
    "JSON.parse(document.querySelector('#scenario-json').value).state.topology[0].workspace === 'T' && document.querySelector('.player').getAttribute('aria-busy') === 'false'",
  );
  const switched = await scenarioDocument(client);
  assert(
    JSON.stringify(switched.state.windows.map((window) => window.frame)) ===
      JSON.stringify(workspaceSetup.state.windows.map((window) => window.frame)),
    "Navigating the starting workspace changed window frames",
  );
  await click(client, '[data-app="com.paneform.hero.browser"]');
  await waitFor(
    client,
    "new authored window on T",
    "JSON.parse(document.querySelector('#scenario-json').value).state.windows.some((w) => w.bundleId === 'com.paneform.hero.browser' && w.workspace === 'T')",
  );

  const { steps: _steps, ...withoutSteps } = setup;
  const live = {
    ...withoutSteps,
    presentation: { device: "display", animate: false },
  } satisfies LayoutScenario;
  url.hash = await encodeScenarioFragment(live);
  await navigate(client, url);
  await evaluate(client, "document.querySelector('.stage').focus(); true");
  await client.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Shift",
    code: "ShiftRight",
    location: 2,
    modifiers: 8,
  });
  await evaluate(
    client,
    "document.querySelector('.editor').open = true; document.querySelector('#scenario-json').focus(); true",
  );
  await client.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Shift",
    code: "ShiftRight",
    location: 2,
  });
  await evaluate(client, "document.querySelector('.stage').focus(); true");
  await client.command("Input.dispatchKeyEvent", { type: "keyDown", key: "l", code: "KeyL" });
  await client.command("Input.dispatchKeyEvent", { type: "keyUp", key: "l", code: "KeyL" });
  await sleep(150);
  assert(
    await evaluate(
      client,
      "document.querySelector('.managed-window.focused')?.dataset.windowId === 'A'",
    ),
    "A modifier remained stuck after leaving the stage",
  );

  const futureDisplay = {
    ...setup,
    presentation: { devices: { "display:later": "display" } },
    steps: [
      { command: "retile" },
      {
        event: {
          kind: "topology_changed",
          topology: [
            { id: "display:main", frame },
            { id: "display:later", frame: { ...frame, x: 1200 } },
          ],
        },
      },
    ],
  } satisfies LayoutScenario;
  url.hash = await encodeScenarioFragment(futureDisplay);
  await navigate(client, url);
  await clickButton(client, "Add command", "document.querySelector('.step-editor')");
  const command = '.step-editor input[role="combobox"][aria-label="Next command token"]';
  await click(client, command);
  await typeBuilderToken(client, "focus-window");
  assert(
    (await builderOptions(client)).length > 0,
    "A future display presentation override suppressed command completion",
  );
}

async function checkFocusAuthoring(client: CdpClient): Promise<void> {
  const displayFrame = { x: 0, y: 0, width: 1200, height: 800 };
  const setup: LayoutScenario = {
    state: {
      topology: [{ id: "display:main", frame: displayFrame, workspace: "1" }],
      windows: [
        { id: "A", title: "A", frame: { x: 20, y: 60, width: 500, height: 340 } },
        { id: "B", title: "B", frame: { x: 620, y: 80, width: 500, height: 340 } },
      ],
      focusedWorkspace: "1",
      focusedWindow: "A",
      wmRunning: true,
    },
    presentation: { device: "display", animate: false },
    steps: [{ command: "window move right" }, { command: "retile" }],
  };
  const url = new URL(pageUrl);
  url.hash = await encodeScenarioFragment(setup);
  await navigate(client, url, { width: 1440, height: 900 });
  const baselineFrames = JSON.stringify(setup.state.windows.map(({ frame }) => frame));

  await evaluate(
    client,
    `(() => {
    for (const id of ['B', 'A']) document.querySelector('[data-window-id="' + id + '"]').dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    return true;
  })()`,
  );
  await waitFor(
    client,
    "last rapid starting-focus intent",
    "document.querySelector('.player').getAttribute('aria-busy') === 'false' && JSON.parse(document.querySelector('#scenario-json').value).state.focusedWindow === 'A'",
  );
  await sleep(200);
  assert(
    (await scenarioDocument(client)).state.focusedWindow === "A",
    "A rapid B then A selection lost the last focus intent",
  );

  await click(client, '[data-window-id="B"] .window-titlebar');
  await waitFor(
    client,
    "starting focus B rebase",
    "JSON.parse(document.querySelector('#scenario-json').value).state.focusedWindow === 'B' && document.querySelector('.player').getAttribute('aria-busy') === 'false'",
  );
  assert(
    JSON.stringify((await scenarioDocument(client)).state.windows.map(({ frame }) => frame)) ===
      baselineFrames,
    "Focusing B in the starting layout changed window frames",
  );
  const initialPanel = await evaluate<{ placement: string; inBounds: boolean }>(
    client,
    `(() => { const panel=document.querySelector('[data-floating-inspector]'); if (!(panel instanceof HTMLElement)) return {placement:'',inBounds:false}; const r=panel.getBoundingClientRect(); return {placement:panel.dataset.placement ?? '',inBounds:r.left>=11&&r.top>=11&&r.right<=innerWidth-11&&r.bottom<=innerHeight-11}; })()`,
  );
  assert(
    ["right", "left"].includes(initialPanel.placement) && initialPanel.inBounds,
    `Desktop inspector was not beside the display: ${JSON.stringify(initialPanel)}`,
  );
  const scrollBeforeClose = await evaluate<number>(client, "scrollY");
  await click(client, '[data-floating-inspector] input[type="number"]');
  await key(client, "Escape");
  await waitFor(
    client,
    "inspector Escape close",
    "!document.querySelector('[data-floating-inspector]')",
  );
  assert(
    await evaluate<boolean>(
      client,
      "document.activeElement?.closest('[data-window-id]')?.dataset.windowId === 'B'",
    ),
    "Closing the inspector did not restore title-bar focus",
  );
  assert(
    (await evaluate<number>(client, "scrollY")) === scrollBeforeClose,
    "Closing the inspector scrolled the page",
  );

  await click(client, '[data-window-id="A"] .window-titlebar');
  await waitFor(
    client,
    "starting focus A rebase",
    "JSON.parse(document.querySelector('#scenario-json').value).state.focusedWindow === 'A' && document.querySelector('.player').getAttribute('aria-busy') === 'false'",
  );
  assert(
    JSON.stringify((await scenarioDocument(client)).state.windows.map(({ frame }) => frame)) ===
      baselineFrames,
    "Focusing A in the starting layout changed window frames",
  );
  assert(
    await evaluate<boolean>(
      client,
      "document.querySelector('.controls')?.contains(document.querySelector('#inspect-window')) === true",
    ),
    "The window picker moved away from the display toolbar",
  );

  const baselineState = (await scenarioDocument(client)).state;
  await clickButton(client, "Step");
  await waitFor(
    client,
    "first authored step",
    "document.querySelector('.caption > span')?.textContent?.trim() === '1 / 2' && document.querySelector('.player').getAttribute('aria-busy') === 'false'",
  );
  await click(client, '[data-window-id="B"] .window-titlebar');
  await waitFor(
    client,
    "recorded mid-scenario focus",
    "JSON.parse(document.querySelector('#scenario-json').value).steps.length === 3 && document.querySelector('.player').getAttribute('aria-busy') === 'false'",
  );
  const recorded = await scenarioDocument(client);
  assert(
    JSON.stringify(recorded.state) === JSON.stringify(baselineState),
    "Recorded focus mutated the authored baseline",
  );
  assert(
    "event" in recorded.steps![1]! &&
      recorded.steps![1]!.event.kind === "focus_changed" &&
      recorded.steps![1]!.event.windowId === "B",
    "Window click did not insert focus_changed at the playback cursor",
  );
  assert(
    "command" in recorded.steps![2]! && recorded.steps![2]!.command === "retile",
    "Focus insertion changed a future step",
  );
  assert(
    await evaluate<boolean>(
      client,
      "document.querySelector('[data-floating-inspector] fieldset')?.disabled === true",
    ),
    "Mid-scenario inspector constraints are editable",
  );
  await clickButton(client, "Close", "document.querySelector('[data-floating-inspector]')");
}

async function checkBoundedSharedEditor(client: CdpClient): Promise<void> {
  const large: LayoutScenario = {
    presentation: { device: "display", animate: false },
    config: {
      workspaces: Array.from({ length: 100 }, (_, index) => ({ name: String(index + 1) })),
    },
    state: {
      topology: [
        { id: "display:main", frame: { x: 0, y: 0, width: 1200, height: 800 }, workspace: "1" },
      ],
      windows: Array.from({ length: 100 }, (_, index) => ({
        id: `w${index}`,
        frame: { x: 20, y: 60, width: 600, height: 400 },
      })),
      focusedWindow: "w0",
      focusedWorkspace: "1",
      wmRunning: false,
    },
    steps: Array.from({ length: 500 }, () => ({ command: "retile" })),
  };
  const url = new URL(pageUrl);
  url.hash = await encodeScenarioFragment(large);
  await navigate(client, url);
  assert(
    await evaluate(client, "document.querySelectorAll('.step-editor li').length <= 20"),
    "Shared editor rendered every step at once",
  );
  await clickButton(client, "Add command", "document.querySelector('.step-editor')");
  assert(
    await evaluate(client, "document.querySelectorAll('[role=option]').length <= 50"),
    "Autocomplete exceeded its global option budget",
  );
  await clickButton(client, "Next", "document.querySelector('.pagination')");
  assert(
    await evaluate(client, "document.querySelectorAll('.step-editor li').length <= 20"),
    "Step pagination exceeded its row budget",
  );
}

async function checkMarketingPage(client: CdpClient): Promise<void> {
  await client.command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await navigate(client, new URL("../", pageUrl), { width: 1920, height: 1080 });
  const shell = await waitFor<{
    workstation: boolean;
    laptop: boolean;
    keyboard: boolean;
    desktop: boolean;
  }>(
    client,
    "reduced-motion WM hero shell",
    `(() => ({
      workstation: Boolean(document.querySelector('.scene')),
      laptop: Boolean(document.querySelector('.laptop-device')),
      keyboard: Boolean(document.querySelector('.keyboard')),
      desktop: Boolean(document.querySelector('.desktop-display'))
    }))()`,
  );
  assert(
    shell.workstation && shell.laptop && shell.keyboard && shell.desktop,
    "WM hero is missing workstation, laptop, 3D keyboard, or desktop shell",
  );
  await screenshot(client, "wm-reduced-motion.png");
}

async function check(): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const port = await freePort();
  const profile = await mkdtemp(resolve(outputDir, "chrome-"));
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let chromeLog = "";
  chrome.stderr?.on("data", (chunk) => {
    chromeLog = (chromeLog + String(chunk)).slice(-4000);
  });
  let client: CdpClient | undefined;
  const exceptions: string[] = [];
  let failure: unknown;
  try {
    const target = await findTarget(`http://127.0.0.1:${port}`);
    client = new CdpClient(target.webSocketDebuggerUrl);
    client.on("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails as
        | { exception?: { description?: string }; text?: string }
        | undefined;
      exceptions.push(details?.exception?.description ?? details?.text ?? JSON.stringify(params));
    });
    await client.command("Page.enable");
    await client.command("Runtime.enable");
    await checkInitialAndDirectManipulation(client);
    await checkServicesPresentationAndDisplays(client);
    await checkAuthoringAndSharing(client);
    await checkAuthoringRegressions(client);
    await checkFocusAuthoring(client);
    await checkBoundedSharedEditor(client);
    await checkHero(client);
    await checkWorkerTimeout(client);
    await checkMobile(client);
    await checkMarketingPage(client);
    assert(
      exceptions.length === 0,
      `Unexpected browser runtime exceptions:\n${exceptions.join("\n\n")}`,
    );
    process.stdout.write(`WM play checks passed; screenshots written to ${outputDir}\n`);
  } catch (cause) {
    failure = cause;
    if (!client) throw new Error(`Chrome startup failed: ${chromeLog || String(cause)}`, { cause });
    await screenshot(client, "failure.png").catch(() => undefined);
    const detail = await evaluate<string>(
      client,
      `JSON.stringify({
        url: location.href,
        status: document.querySelector('.status')?.textContent,
        alert: document.querySelector('[role=alert]')?.textContent,
        caption: document.querySelector('.caption')?.textContent,
        ariaBusy: document.querySelector('.player')?.getAttribute('aria-busy'),
        active: document.activeElement?.outerHTML?.slice(0, 500),
        builderQuery: document.querySelector('input[aria-label="Next command token"]')?.value,
        builderOptions: [...document.querySelectorAll('[role=listbox] > [role=option]')].map((option) => option.textContent?.trim()),
        inspector: document.querySelector('[data-floating-inspector]') ? { placement: document.querySelector('[data-floating-inspector]').dataset.placement, rect: document.querySelector('[data-floating-inspector]').getBoundingClientRect().toJSON() } : null,
        scroll: { x: scrollX, y: scrollY, width: document.documentElement.scrollWidth, viewport: [innerWidth, innerHeight] }
      })`,
    ).catch(() => "browser details unavailable");
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)}\nPage detail: ${detail}\nRuntime errors: ${exceptions.join("\n")}\nFailure screenshot: ${resolve(outputDir, "failure.png")}`,
      { cause },
    );
  } finally {
    client?.close();
    chrome.kill("SIGTERM");
    await sleep(300);
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
      () => undefined,
    );
    if (!failure && exceptions.length > 0) process.stderr.write(`${exceptions.join("\n")}\n`);
  }
}

await check();
