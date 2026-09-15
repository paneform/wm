import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const host = "127.0.0.1";
const outputDir = resolve(".vercel/output");
const staticDir = resolve(outputDir, "static");
const imageUrl = "https://paneform.com/social/paneform-wm.png?v=2";
const pageMetadata = [
  {
    path: "/wm/",
    title: "Paneform WM | Every window in its place",
    description:
      "A reliability-first tiling window manager for macOS. Group windows into workspaces, then move the whole workspace between displays.",
    canonical: "https://paneform.com/wm/",
  },
  {
    path: "/wm/waitlist/",
    title: "Join the Paneform WM waitlist",
    description:
      "Join the waitlist for Paneform WM, a reliability-first tiling window manager for macOS.",
    canonical: "https://paneform.com/wm/waitlist/",
  },
];

const disabledPaths = [
  "/wm/play/",
  "/wm/play/hero/",
  "/wm/play/scenario.schema.json",
  "/wm/play/__data.json?x-sveltekit-invalidated=000",
  "/wm/play/hero/__data.json?x-sveltekit-invalidated=000",
  "/wm/%70lay/",
];

const enabledPaths = [
  "/wm/play/",
  "/wm/play/hero/",
  "/wm/play/scenario.schema.json",
  "/wm/play/__data.json?x-sveltekit-invalidated=000",
  "/wm/play/hero/__data.json?x-sveltekit-invalidated=000",
];

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertHeadValue(html: string, selector: string, value: string, label: string): void {
  const tag = html.match(new RegExp(`<${selector}[^>]*>`, "i"))?.[0];
  assert.ok(tag, `${label}: missing ${selector}`);
  assert.match(tag, new RegExp(`(?:content|href)=["']${escapePattern(value)}["']`, "i"), label);
}

function assertMetadata(html: string, metadata: (typeof pageMetadata)[number]): void {
  assert.match(html, new RegExp(`<title>${escapePattern(metadata.title)}</title>`, "i"));
  assertHeadValue(html, "meta\\s+name=[\"']description[\"']", metadata.description, "description");
  assertHeadValue(html, "link\\s+rel=[\"']canonical[\"']", metadata.canonical, "canonical URL");
  assertHeadValue(html, "meta\\s+property=[\"']og:image[\"']", imageUrl, "Open Graph image");
  assertHeadValue(html, "meta\\s+property=[\"']og:image:width[\"']", "1200", "Open Graph width");
  assertHeadValue(html, "meta\\s+property=[\"']og:image:height[\"']", "630", "Open Graph height");
  assertHeadValue(html, "meta\\s+name=[\"']twitter:image[\"']", imageUrl, "Twitter image");
  assert.match(
    html,
    /<link\b(?=[^>]*\brel=["']icon["'])(?=[^>]*\bhref=["']\/favicon\.svg["'])[^>]*>/i,
    "favicon link must use /favicon.svg",
  );
}

function assertRedirectDocument(html: string): void {
  assert.match(html, /location\.href=["']\/wm\/["']/i, "root redirect script");
  assert.match(
    html,
    /<meta\b(?=[^>]*\bhttp-equiv=["']refresh["'])(?=[^>]*\bcontent=["']0;url=\/wm\/["'])[^>]*>/i,
    "root redirect fallback",
  );
}

async function assertFile(path: string): Promise<void> {
  assert.ok((await stat(path)).isFile(), `Expected file: ${path}`);
}

async function assertArtifacts(): Promise<void> {
  await Promise.all([
    assertFile(resolve(staticDir, "index.html")),
    assertFile(resolve(staticDir, "wm/index.html")),
    assertFile(resolve(staticDir, "wm/waitlist/index.html")),
    assertFile(resolve(staticDir, "social/paneform-wm.png")),
  ]);
  await assert.rejects(stat(resolve(staticDir, "wm/play")), { code: "ENOENT" });
  await assert.rejects(stat(resolve(staticDir, "wm/og")), { code: "ENOENT" });

  const png = await readFile(resolve(staticDir, "social/paneform-wm.png"));
  assert.ok(
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "Invalid PNG",
  );
  assert.equal(png.readUInt32BE(16), 1200, "Social image width");
  assert.equal(png.readUInt32BE(20), 630, "Social image height");

  assertRedirectDocument(await readFile(resolve(staticDir, "index.html"), "utf8"));

  const config = await readFile(resolve(outputDir, "config.json"), "utf8");
  assert.match(
    config,
    /"src"\s*:\s*"\/\?"[\s\S]*?"Location"\s*:\s*"\/wm\/"[\s\S]*?"status"\s*:\s*308/,
  );
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, host, resolveListen);
  });
  const address = server.address();
  assert.ok(address && "port" in address, "Could not allocate a preview port");
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return address.port;
}

async function waitForPreview(origin: string, exited: Promise<never>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await Promise.race([fetch(`${origin}/wm/`).catch(() => null), exited]);
    if (response) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Preview did not start at ${origin}`);
}

async function assertStatus(origin: string, path: string, status: number): Promise<Response> {
  const response = await fetch(`${origin}${path}`, { redirect: "manual" });
  assert.equal(response.status, status, `${path} returned ${response.status}, expected ${status}`);
  return response;
}

async function assertPublicRoutes(origin: string): Promise<void> {
  // The image source is development-only, even in an opted-in playground preview.
  for (const path of [
    "/wm/og",
    "/wm/og/",
    "/wm/og/__data.json?x-sveltekit-invalidated=000",
    "/wm/%6fg/",
  ]) {
    await assertStatus(origin, path, 404);
  }
  const root = await assertStatus(origin, "/", 200);
  assertRedirectDocument(await root.text());
  for (const metadata of pageMetadata) {
    const response = await assertStatus(origin, metadata.path, 200);
    assertMetadata(await response.text(), metadata);
  }
}

function signalPreview(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function assertDisabled(origin: string): Promise<void> {
  await assertPublicRoutes(origin);
  for (const path of disabledPaths) await assertStatus(origin, path, 404);
}

async function assertEnabled(origin: string): Promise<void> {
  await assertPublicRoutes(origin);
  for (const path of enabledPaths) {
    const response = await assertStatus(origin, path, 200);
    assert.equal(
      response.headers.get("cache-control"),
      "private, no-store",
      `${path} cache policy`,
    );
    assert.equal(
      response.headers.get("x-robots-tag"),
      "noindex, nofollow",
      `${path} robots policy`,
    );
  }
}

async function withPreview(
  name: string,
  variables: Readonly<Record<string, string>>,
  check: (origin: string) => Promise<void>,
): Promise<void> {
  const port = await freePort();
  const environment = { ...process.env };
  delete environment.PLAYGROUND_ENABLED;
  delete environment.VERCEL_ENV;
  Object.assign(environment, variables);
  const child = spawn(
    "pnpm",
    ["exec", "vite", "preview", "--host", host, "--port", String(port), "--strictPort"],
    { detached: true, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<Error>((resolveExit) => {
    child.once("error", resolveExit);
    child.once("exit", (code, signal) =>
      resolveExit(new Error(`${name} preview exited (${signal ?? code})\n${output}`)),
    );
  });
  const unexpectedExit = exited.then((error) => Promise.reject(error));
  try {
    const origin = `http://${host}:${port}`;
    await waitForPreview(origin, unexpectedExit);
    await check(origin);
  } finally {
    signalPreview(child, "SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) signalPreview(child, "SIGKILL");
  }
}

await assertArtifacts();
await withPreview("default", {}, assertDisabled);
await withPreview(
  "production",
  { PLAYGROUND_ENABLED: "true", VERCEL_ENV: "production" },
  assertDisabled,
);
await withPreview(
  "enabled preview",
  { PLAYGROUND_ENABLED: "true", VERCEL_ENV: "preview" },
  assertEnabled,
);
console.log("Release smoke checks passed");
