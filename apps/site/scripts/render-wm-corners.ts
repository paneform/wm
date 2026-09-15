// oxlint-disable -- Chrome DevTools messages are an external protocol with command-specific payloads.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const url = process.env.WM_SCREENSHOT_URL ?? "http://127.0.0.1:4192/wm/";
const outputDir = resolve(process.env.WM_SCREENSHOT_DIR ?? "/tmp/wm-corners");
const chromePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type Target = { type: string; webSocketDebuggerUrl?: string };
type CdpMessage = { id?: number; result?: unknown; error?: { message?: string } };
type Bounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};
type Viewport = { width: number; height: number };
type Geometry = { base: Bounds; slot: Bounds; viewport: Viewport };

class CdpClient {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
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

  close(): void {
    this.socket.close();
  }

  private handleMessage(source: string): void {
    const message = JSON.parse(source) as CdpMessage;
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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a Chrome debugging port");
  return address.port;
}

async function findTarget(endpoint: string): Promise<Target & { webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
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

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const response = await client.command<{ result?: { value?: T } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (!response.result || !("value" in response.result))
    throw new Error("Chrome evaluation returned no value");
  return response.result.value as T;
}

async function bounds(client: CdpClient): Promise<Geometry> {
  return evaluate(
    client,
    `(() => {
       const read = (element) => {
         const rect = element.getBoundingClientRect();
         return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
       };
       return {
         base: read(document.querySelector('.base')),
         slot: read(document.querySelector('.base-slot')),
         viewport: { width: innerWidth, height: innerHeight },
       };
    })()`,
  );
}

async function screenshot(
  client: CdpClient,
  path: string,
  clip?: Record<string, number>,
): Promise<void> {
  const response = await client.command<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  });
  await writeFile(path, Buffer.from(response.data, "base64"));
}

function cornerClip(side: "left" | "right", geometry: Geometry): Record<string, number> {
  const width = Math.min(240, Math.max(150, geometry.base.width * 0.18));
  const left =
    side === "left"
      ? Math.min(geometry.slot.left, geometry.base.left) - 24
      : Math.max(geometry.slot.right, geometry.base.right) - width + 24;
  const x = Math.max(0, Math.min(left, geometry.viewport.width - width));
  const y = Math.max(0, geometry.base.bottom - 120);
  const bottom = Math.min(geometry.viewport.height, geometry.slot.bottom + 20);
  return { x, y, width: Math.min(width, geometry.viewport.width - x), height: bottom - y };
}

async function renderViewport(client: CdpClient, label: string, viewport: Viewport): Promise<void> {
  await client.command("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.command("Page.navigate", { url });
  await sleep(2500);
  const geometry = await bounds(client);
  await screenshot(client, resolve(outputDir, `${label}-full.png`));
  await screenshot(client, resolve(outputDir, `${label}-left.png`), cornerClip("left", geometry));
  await screenshot(client, resolve(outputDir, `${label}-right.png`), cornerClip("right", geometry));
}

async function render(): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const port = await freePort();
  const profile = await mkdtemp(`${tmpdir()}/wm-cdp-`);
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const endpoint = `http://127.0.0.1:${port}`;
  const target = await findTarget(endpoint);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.command("Page.enable");
    await renderViewport(client, "desktop", { width: 1920, height: 1080 });
    await renderViewport(client, "mobile", { width: 390, height: 844 });
    process.stdout.write(`Wrote WM corner renders to ${outputDir}\n`);
  } finally {
    client.close();
    chrome.kill("SIGTERM");
    await sleep(500);
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
      () => undefined,
    );
  }
}

await render();
