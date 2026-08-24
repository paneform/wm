import type { Command, Engine, StateSnapshot } from "@wm/engine";
import type { CommandError } from "@wm/engine";
import type { DomainEvent } from "@wm/engine";
import type { SimGroundTruth } from "../sim/web-platform.ts";
import { SCENARIOS, type RecordedEntry, type ScenarioRecorder } from "./scenarios.ts";

// Side panels — docs/rewrite/web-renderer.md §UI sketch.
// World inspector (windows + capabilities + scripted ground truth), action log
// (domain events), command console (core commands through engine.execute()),
// scenario controls. Functional clarity over beauty. Note: learned profiles
// and parking facts are ENGINE-INTERNAL and not reachable through the frozen
// public API (createEngine → start/stop/execute/state/events); the inspector
// therefore shows the sim's platform-side truth alongside the committed
// projection — see the integration seam notes in main.ts.

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: readonly (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

const fmtFrame = (f: { x: number; y: number; width: number; height: number }): string =>
  `(${f.x},${f.y}) ${f.width}×${f.height}`;

export interface PanelDeps {
  engine: Engine;
  getSnapshot(): StateSnapshot | null;
  getGroundTruth(): SimGroundTruth | null;
  runCommand(command: Command): Promise<void>;
  runScenario(scenarioId: string): void;
  replayRecording(name: string): void;
  recorder: ScenarioRecorder;
  recordingNames(): string[];
}

export interface PanelHandles {
  root: HTMLElement;
  updateInspector(snapshot: StateSnapshot | null, groundTruth: SimGroundTruth | null): void;
  populateSelects(snapshot: StateSnapshot | null): void;
  logEvent(event: DomainEvent): void;
  logCommand(command: Command, outcome: string): void;
  setRecordingUi(recording: boolean): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPanels(deps: PanelDeps): PanelHandles {
  const root = el("aside", { id: "side" });

  // ---------------- inspector ----------------

  const inspectorBody = el("div", { class: "panel-body", id: "inspector-body" });
  const inspector = el(
    "section",
    { class: "panel", id: "panel-inspector" },
    el("h2", { text: "World inspector" }),
    inspectorBody,
  );

  // ---------------- action log ----------------

  const logList = el("div", { class: "log-list", id: "log-list" });
  const clearLogButton = el("button", {
    text: "clear",
    title: "Clear action log",
  });
  clearLogButton.addEventListener("click", () => {
    logList.replaceChildren();
  });
  const logPanel = el(
    "section",
    { class: "panel", id: "panel-log" },
    el("h2", { text: "Action log" }, clearLogButton),
    logList,
  );

  // ---------------- command console ----------------

  const windowSelect = el("select", { id: "cmd-window", title: "Target window" });
  const workspaceInput = el("input", {
    id: "cmd-workspace",
    placeholder: "workspace name",
    value: "2",
  });
  const displaySelect = el("select", { id: "cmd-display", title: "Target display" });
  const xInput = el("input", { id: "cmd-x", type: "number", value: "200", title: "x" });
  const yInput = el("input", { id: "cmd-y", type: "number", value: "200", title: "y" });
  const wInput = el("input", { id: "cmd-w", type: "number", value: "640", title: "width" });
  const hInput = el("input", { id: "cmd-h", type: "number", value: "420", title: "height" });
  const jsonInput = el("textarea", {
    id: "cmd-json",
    rows: "3",
    placeholder: '{"type":"retile"} — raw command JSON',
  });
  const commandLog = el("div", { class: "command-log", id: "command-log" });

  const num = (input: HTMLInputElement): number => Math.round(Number(input.value) || 0);
  const selectedWindowId = (): string | null => windowSelect.value || null;

  const button = (label: string, fn: () => void, title?: string): HTMLButtonElement => {
    const b = el("button", { ...(title !== undefined ? { title } : {}), text: label });
    b.addEventListener("click", fn);
    return b;
  };

  const grid = el(
    "div",
    { class: "command-grid" },
    button("focus window", () => {
      const id = selectedWindowId();
      if (id !== null) void deps.runCommand({ type: "focusWindow", windowId: id });
    }),
    button("float", () => {
      const id = selectedWindowId();
      if (id !== null) void deps.runCommand({ type: "floatWindow", windowId: id });
    }),
    button("tile", () => {
      const id = selectedWindowId();
      if (id !== null) void deps.runCommand({ type: "tileWindow", windowId: id });
    }),
    button("manage", () => {
      const id = selectedWindowId();
      if (id !== null) void deps.runCommand({ type: "manageWindow", windowId: id });
    }),
    button("unmanage", () => {
      const id = selectedWindowId();
      if (id !== null) void deps.runCommand({ type: "unmanageWindow", windowId: id });
    }),
    button("move → ws", () => {
      const id = selectedWindowId();
      const ws = workspaceInput.value.trim();
      if (id !== null && ws.length > 0) {
        void deps.runCommand({ type: "moveWindowToWorkspace", windowId: id, workspace: ws });
      }
    }),
    button("move xy", () => {
      const id = selectedWindowId();
      if (id !== null) {
        void deps.runCommand({
          type: "moveWindow",
          windowId: id,
          point: { x: num(xInput), y: num(yInput) },
        });
      }
    }),
    button("resize w×h", () => {
      const id = selectedWindowId();
      if (id !== null) {
        void deps.runCommand({
          type: "resizeWindow",
          windowId: id,
          size: { width: num(wInput), height: num(hInput) },
        });
      }
    }),
    button("focus ws", () => {
      const ws = workspaceInput.value.trim();
      if (ws.length > 0) void deps.runCommand({ type: "focusWorkspace", name: ws });
    }),
    button("ws mode ⇄", () => {
      const snapshot = deps.getSnapshot();
      const ws = workspaceInput.value.trim();
      const current = snapshot?.workspaces.find((w) => w.name === ws)?.mode ?? "bsp";
      if (ws.length > 0) {
        void deps.runCommand({
          type: "setWorkspaceMode",
          workspace: ws,
          mode: current === "bsp" ? "floating" : "bsp",
        });
      }
    }),
    button("ws → display", () => {
      const ws = workspaceInput.value.trim();
      const displayId = displaySelect.value;
      if (ws.length > 0 && displayId.length > 0) {
        void deps.runCommand({ type: "moveWorkspaceToDisplay", workspace: ws, displayId });
      }
    }),
    button("retile", () => void deps.runCommand({ type: "retile" })),
    button("reconcile", () => void deps.runCommand({ type: "reconcile" })),
    button("pause", () => void deps.runCommand({ type: "pause" })),
    button("resume", () => void deps.runCommand({ type: "resume" })),
  );

  const runJsonButton = el("button", { text: "run JSON", class: "wide" });
  runJsonButton.addEventListener("click", () => {
    try {
      const parsed: unknown = JSON.parse(jsonInput.value);
      void deps.runCommand(parsed as Command);
    } catch (error) {
      appendLine(commandLog, `parse error: ${String(error)}`, "err");
    }
  });

  const commands = el(
    "section",
    { class: "panel", id: "panel-commands" },
    el("h2", { text: "Commands" }),
    el("div", { class: "row" }, windowSelect, workspaceInput),
    el("div", { class: "row" }, displaySelect),
    el("div", { class: "row" }, xInput, yInput, wInput, hInput),
    grid,
    jsonInput,
    runJsonButton,
    commandLog,
  );

  // ---------------- scenarios + recorder ----------------

  const scenarioButtons = SCENARIOS.map((scenario) => {
    const b = el("button", {
      text: scenario.title,
      title: `${scenario.id}: ${scenario.description}`,
      class: "scenario",
    });
    b.addEventListener("click", () => deps.runScenario(scenario.id));
    return b;
  });

  const recordToggle = el("button", { text: "start recording", class: "wide" });
  recordToggle.addEventListener("click", () => {
    if (!deps.recorder.isRecording) {
      deps.recorder.start();
      setRecordingUi(true);
    } else {
      deps.recorder.stop();
      setRecordingUi(false);
    }
  });

  const saveNameInput = el("input", { placeholder: "recording name", value: "run-1" });
  const saveButton = el("button", { text: "save" });
  saveButton.addEventListener("click", () => {
    const name = saveNameInput.value.trim() || `run-${Date.now()}`;
    deps.recorder.save(name);
    refreshReplayOptions();
  });

  const replaySelect = el("select", { id: "replay-select" });
  const replayButton = el("button", { text: "replay" });
  replayButton.addEventListener("click", () => {
    const name = replaySelect.value;
    if (name.length > 0) deps.replayRecording(name);
  });

  function setRecordingUi(recording: boolean): void {
    recordToggle.textContent = recording ? "stop recording" : "start recording";
    recordToggle.classList.toggle("active", recording);
  }

  function refreshReplayOptions(): void {
    const names = deps.recordingNames();
    replaySelect.replaceChildren(
      ...names.map((name) => el("option", { value: name, text: name })),
    );
  }

  const scenariosPanel = el(
    "section",
    { class: "panel", id: "panel-scenarios" },
    el("h2", { text: "Scenarios" }),
    ...scenarioButtons,
    el("h2", { text: "Recorder" }),
    recordToggle,
    el("div", { class: "row" }, saveNameInput, saveButton),
    el("div", { class: "row" }, replaySelect, replayButton),
  );

  root.append(inspector, logPanel, commands, scenariosPanel);
  refreshReplayOptions();

  // ---------------- handle ----------------

  return {
    root,
    updateInspector(snapshot, groundTruth) {
      inspectorBody.replaceChildren(renderInspector(snapshot, groundTruth));
    },
    populateSelects(snapshot) {
      if (snapshot === null) return;
      syncSelect(windowSelect, snapshot.windows.map((w) => [w.id, labelFor(w)]));
      syncSelect(displaySelect, snapshot.topology.map((d) => [d.id, d.id.replace("display:sim-", "")]));
      if (workspaceInput.value.trim().length === 0) workspaceInput.value = "2";
    },
    logEvent(event) {
      const row = el("div", { class: "log-row" });
      const head = el("span", { class: `log-topic t-${event.topic}`, text: `[${event.seq}] ${event.topic}` });
      row.append(head, el("span", { class: "log-payload", text: summarizeEvent(event) }));
      logList.prepend(row);
      while (logList.childElementCount > 200) {
        logList.lastChild?.remove();
      }
    },
    logCommand(command, outcome) {
      appendLine(
        commandLog,
        `${command.type} → ${outcome}`,
        outcome.startsWith("ok") ? "ok" : "err",
      );
    },
    setRecordingUi,
  };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

type ManagedWindowSnapshot = StateSnapshot["windows"][number];

function labelFor(w: ManagedWindowSnapshot): string {
  const flags: string[] = [];
  if (w.parked) flags.push("parked");
  else if (w.floating) flags.push("float");
  else if (w.managed) flags.push("tile");
  else flags.push("quarantine");
  return `${w.title ?? w.id} · ${flags.join("/")}`;
}

function renderInspector(
  snapshot: StateSnapshot | null,
  groundTruth: SimGroundTruth | null,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (snapshot === null) {
    frag.append(el("p", { text: "waiting for first committed state…" }));
    return frag;
  }

  const health = el(
    "div",
    { class: "health-line" },
    el("span", { class: `badge h-${snapshot.health}`, text: snapshot.health }),
    el("span", { text: snapshot.paused ? "paused" : "running" }),
    el("span", { text: `epoch ${snapshot.epoch}` }),
    el("span", { text: `ws ${snapshot.focusedWorkspace ?? "—"}` }),
    el("span", { text: `pending ${snapshot.pendingTransactions.length}` }),
  );
  frag.append(health);

  const truthById = new Map(groundTruth?.windows.map((w) => [w.id, w]) ?? []);

  const table = el("table", { class: "inspector-table" });
  const thead = el(
    "thead",
    {},
    el(
      "tr",
      {},
      el("th", { text: "window" }),
      el("th", { text: "state" }),
      el("th", { text: "caps m/r" }),
      el("th", { text: "scripted bounds" }),
      el("th", { text: "frame" }),
    ),
  );
  const tbody = el("tbody");
  for (const w of snapshot.windows) {
    const caps = `${capShort(w.capabilities.movable)}/${capShort(w.capabilities.resizable)}`;
    const truth = truthById.get(w.id);
    const bounds = formatScriptedBounds(truth?.personality.constraints);
    tbody.append(
      el(
        "tr",
        {},
        el("td", { text: `${truth?.title ?? w.title ?? w.id}` , title: w.id }),
        el("td", { text: stateLabel(w) }),
        el("td", { text: caps }),
        el("td", { text: bounds }),
        el("td", { text: fmtFrame(w.frame) }),
      ),
    );
  }
  table.append(thead, tbody);
  frag.append(table);

  const wsLines = snapshot.workspaces.map((ws) => {
    const visibleOn = ws.visibleOnDisplay?.replace("display:sim-", "") ?? "parked";
    return `WS ${ws.name} [${ws.mode}] on ${visibleOn} · ${ws.members.length} tiled · ${ws.floating.length} floating`;
  });
  frag.append(el("pre", { class: "ws-lines", text: wsLines.join("\n") }));

  // Parking visibility is PLATFORM-side truth owned by the sim; learned
  // profiles/parking facts live behind the frozen engine API (see file header).
  if (groundTruth !== null) {
    const displays = groundTruth.displays
      .map((d) => `${d.id.replace("display:sim-", "")} ${fmtFrame(d.frame)}${d.primary ? " primary" : ""}`)
      .join("\n");
    frag.append(
      el("pre", {
        class: "ws-lines dim",
        text: `displays:\n${displays}\nseed ${groundTruth.seed} · parking sliver ≈1×52 pt per corner`,
      }),
    );
  }
  return frag;
}

function stateLabel(w: ManagedWindowSnapshot): string {
  if (w.parked) return "parked";
  if (!w.managed) return `unmanaged/${w.classification}`;
  return w.floating ? "floating" : `tiled@${w.workspace ?? "?"}`;
}

function capShort(state: string): string {
  switch (state) {
    case "supported":
      return "✓";
    case "fixed":
      return "✗";
    case "inconclusive":
      return "?";
    default:
      return "·";
  }
}

function formatScriptedBounds(
  constraints:
    | {
        minWidth?: number | undefined;
        maxWidth?: number | undefined;
        minHeight?: number | undefined;
        maxHeight?: number | undefined;
      }
    | undefined,
): string {
  if (constraints === undefined) return "—";
  const parts: string[] = [];
  if (constraints.minWidth !== undefined) parts.push(`minW ${constraints.minWidth}`);
  if (constraints.maxWidth !== undefined) parts.push(`maxW ${constraints.maxWidth}`);
  if (constraints.minHeight !== undefined) parts.push(`minH ${constraints.minHeight}`);
  if (constraints.maxHeight !== undefined) parts.push(`maxH ${constraints.maxHeight}`);
  return parts.length > 0 ? parts.join(", ") : "—";
}

function summarizeEvent(event: DomainEvent): string {
  const payload = event.payload as Record<string, unknown>;
  switch (event.topic) {
    case "diagnostic":
      return `${String(payload.code ?? "")} ${String(payload.detail ?? "").slice(0, 120)}`;
    case "reconciliation":
      return `epoch ${String(payload.epoch)} planned ${String(payload.plannedActions)} applied ${String(payload.appliedSteps)}`;
    case "pause":
      return String(payload.paused);
    case "health":
      return String(payload.state);
    default:
      return JSON.stringify(event.payload).slice(0, 140);
  }
}

function appendLine(container: HTMLElement, text: string, cssClass: string): void {
  container.append(el("div", { class: `line ${cssClass}`, text }));
  while (container.childElementCount > 80) container.firstChild?.remove();
  container.scrollTop = container.scrollHeight;
}

function syncSelect(select: HTMLSelectElement, options: readonly [string, string][]): void {
  const previous = select.value;
  select.replaceChildren(...options.map(([value, label]) => el("option", { value, text: label })));
  if (options.some(([value]) => value === previous)) select.value = previous;
}
