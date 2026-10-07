<script lang="ts">
	import { onNavigate } from "$app/navigation";
	import { onMount, tick } from "svelte";

	import {
		parseScenarioCommand,
		playbackSteps,
		type ScenarioSession,
		type ScenarioStep,
		type SimulationState,
		type SimulationWindow,
	} from "@paneform/layout-browser";

	import {
		heroKeyboardChords,
		keyboardKeys,
		tokens,
		type HeroCommand,
	} from "$lib/design/tokens.js";
	import { parseHeroScenario } from "$lib/play/hero-scenario.js";
	import Workstation, { type ScenePhase } from "./Workstation.svelte";
	import SiteHeader from "./SiteHeader.svelte";
	import SiteFooter from "./SiteFooter.svelte";
	import type { Frame } from "../desktop/desktop-model.js";
	import { keyboardCommand, browserKeyboardScheduler, createKeyboardController } from "./keyboard-controller.js";
	import { MACBOOK_DISPLAY_ID, HERO_APPS, type HeroAppTitle, type HeroWorkspace } from "./hero-model.js";


	type Lifecycle =
		| "static"
		| "loading"
		| "autoplay"
		| "paused"
		| "interactive"
		| "failed";
	type PlaybackOutcome = "completed" | "aborted" | "paused";
	interface PendingBootstrap {
		session: ScenarioSession | null;
	}

	const scenario = parseHeroScenario();
	const steps: readonly ScenarioStep[] = playbackSteps(scenario);
	const cursorLeadMs = 400;

	let measuredWorkArea: Frame | null = null;
	let stage = $state<HTMLElement>();
	let lifecycle = $state<Lifecycle>("static");
	let phase = $state<ScenePhase>("closed");
	let simulationState = $state<SimulationState | null>(null);
	let status = $state("Preparing the interactive demo.");
	let liveStatus = $state("");
	let cursorApp = $state<HeroAppTitle | null>(null);
	let paneformLaunchActive = $state(false);
	let paneformSplashMinimumElapsed = $state(true);
	let paneformLayoutApplied = $state(true);
	let pendingDockApp = $state<HeroAppTitle | null>(null);
	let stageVisible = $state(false);
	let session: ScenarioSession | null = null;
	let playbackToken = 0;
	let playbackAbort: AbortController | null = null;
	let stepCursor = 0;
	let openSequence = 0;
	let started = false;
	let observer: IntersectionObserver | null = null;
	let lifecycleGeneration = 0;
	let pausedByVisibility = false;
	let fastForwarding = false;
	let paneformSplashGeneration = 0;

	async function updateWorkArea(area: Frame) {
		measuredWorkArea = area;
		const current = session;
		if (!current) return;
		current.sim.updateWorkArea(MACBOOK_DISPLAY_ID, area);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		if (current !== session) return;
		simulationState = await current.snapshot();
	}

	const ready = $derived(
		lifecycle === "autoplay" ||
			lifecycle === "paused" ||
			lifecycle === "interactive",
	);
	const dockInteractive = $derived(lifecycle !== "failed");
	const paneformLaunching = $derived(
		paneformLaunchActive &&
			(!paneformSplashMinimumElapsed || !paneformLayoutApplied),
	);
	const controlLabel = $derived(
		lifecycle === "autoplay"
			? "Pause demo"
			: lifecycle === "paused"
				? "Resume demo"
				: "Restart demo",
	);

	const controlIcon = $derived(lifecycle === "autoplay" ? "pause" : lifecycle === "paused" ? "play" : "restart");

	const keyboard = createKeyboardController({
		layout: keyboardKeys,
		chords: heroKeyboardChords,
		scheduler: browserKeyboardScheduler(),
		dispatch: async (command, source) => {
			if (source === "user") await runKeyboardCommand(command);
		},
		onGlobalRelease: () => pauseDemo(true),
		onUserPress: () => {
			if (lifecycle === "autoplay") takeOver();
		},
		onError: () => {
			status = "Command could not be completed. Try it again.";
		},
	});

	onNavigate(async () => {
		lifecycleGeneration += 1;
		playbackToken += 1;
		playbackAbort?.abort();
		cursorApp = null;
		const current = session;
		session = null;
		await current?.dispose();
	});

	function settleHardware() {
		phase = "desktop";
	}

	function showPaneformSplash() {
		const generation = ++paneformSplashGeneration;
		paneformLaunchActive = true;
		paneformSplashMinimumElapsed = false;
		paneformLayoutApplied = false;
		setTimeout(() => {
			if (generation === paneformSplashGeneration)
				paneformSplashMinimumElapsed = true;
		}, 1000);
	}

	async function markPaneformLayoutApplied() {
		await tick();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		paneformLayoutApplied = true;
	}

	function hidePaneformSplash() {
		paneformSplashGeneration += 1;
		paneformLaunchActive = false;
		paneformSplashMinimumElapsed = true;
		paneformLayoutApplied = true;
	}

	function stopPlayback() {
		playbackToken += 1;
		playbackAbort?.abort();
		keyboard.releaseAll({ source: "script" });
		hidePaneformSplash();
	}

	function failInteractive() {
		const current = session;
		stopPlayback();
		cursorApp = null;
		lifecycle = "failed";
		phase = "complete";
		simulationState = null;
		session = null;
		status = "Interactive demo unavailable";
		void current?.dispose();
	}

	function pauseDemo(automatic: boolean) {
		if (lifecycle !== "autoplay") return;
		stopPlayback();
		pausedByVisibility = automatic;
		lifecycle = "paused";
		status = "Demo paused.";
	}

	async function refresh(): Promise<boolean> {
		const current = session;
		if (!current) return false;
		const next = await current.snapshot();
		if (current !== session) return false;
		simulationState = next;
		return true;
	}

	function delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function chordForStep(step: ScenarioStep) {
		if (!("command" in step)) return null;
		const requested = parseScenarioCommand(step.command);
		const requestedKey = JSON.stringify(requested);
		return (
			heroKeyboardChords.find(
				(candidate) =>
					JSON.stringify(
						parseScenarioCommand(keyboardCommand(candidate.command)),
					) === requestedKey,
			) ?? null
		);
	}

	function launchTitleFor(step: ScenarioStep): HeroAppTitle | null {
		if (!("event" in step) || step.event.kind !== "window_added") return null;
		const title = step.event.window.title;
		return HERO_APPS.find((app) => app.title === title)?.title ?? null;
	}

	async function applyStep(step: ScenarioStep): Promise<void> {
		const current = session;
		if (!current) throw new Error("Scenario session is unavailable");
		const next = await current.apply(step);
		if (current !== session) return;
		if (!fastForwarding) simulationState = next;
		stepCursor += 1;
	}

	async function playSteps(
		reducedMotion: boolean,
	): Promise<PlaybackOutcome> {
		const token = ++playbackToken;
		const abort = new AbortController();
		playbackAbort = abort;
		try {
			if (!reducedMotion) {
				await delay(100);
				if (token !== playbackToken) return "aborted";
				phase = "opening";
				await delay(1200);
				if (token !== playbackToken) return "aborted";
				phase = "desktop";
				await delay(500);
				if (token !== playbackToken) return "aborted";
			}
			while (stepCursor < steps.length) {
				const step = steps[stepCursor];
				if (!step) break;
				const launchTitle = reducedMotion
					? null
					: launchTitleFor(step);
				const chord = reducedMotion ? null : chordForStep(step);
				const launchingPaneform =
					!reducedMotion && "command" in step && step.command === "service start";
				const launching = launchTitle !== null || launchingPaneform;
				if (launchTitle !== null) cursorApp = launchTitle;
				else if (launchingPaneform) cursorApp = "Paneform";
				if (launchingPaneform) {
					showPaneformSplash();
					await tick();
				}
				if (launching) {
					// Let the cursor (and splash) settle before the launch commits.
					await delay(cursorLeadMs);
					if (token !== playbackToken) return "aborted";
				}
				try {
					if (chord) {
						let applied: Promise<void> | null = null;
						const animation = keyboard.chord({
							keys: chord.keys,
							preHold: tokens.motion.chordPrelude,
							hold: tokens.motion.chordHold,
							pressStagger: tokens.motion.chordStagger,
							releaseStagger: tokens.motion.keyReleaseStagger,
							source: "script",
							signal: abort.signal,
							onTrigger: () => {
								applied = applyStep(step);
								return applied;
							},
						});
						await Promise.all([
							animation.catch(() => {}),
							delay(step.duration ?? 1200),
						]);
						if (applied !== null) await applied;
					} else {
						await applyStep(step);
						if (!reducedMotion) await delay(step.duration ?? 1200);
					}
				} catch {
					if (token !== playbackToken) return "aborted";
					status = "Playback stopped at the failing step.";
					liveStatus = status;
					return "paused";
				}
				if (launchingPaneform) await markPaneformLayoutApplied();
				if (token !== playbackToken) return "aborted";
				if (launching) cursorApp = null;
			}
			return "completed";
		} finally {
			if (playbackAbort === abort) playbackAbort = null;
		}
	}

	async function runDemo() {
		if (!session || !stageVisible || started) return;
		started = true;
		const reducedMotion = matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		fastForwarding = reducedMotion;
		lifecycle = reducedMotion ? "loading" : "autoplay";
		status = reducedMotion
			? "Preparing the reduced-motion interactive state."
			: "See how wm arranges your windows.";
		const outcome = await playSteps(reducedMotion);
		if (!(await refresh())) return;
		fastForwarding = false;
		finishDemo(outcome);
	}

	function finishDemo(outcome: PlaybackOutcome) {
		if (lifecycle === "failed") return;
		if (outcome === "completed") {
			phase = "complete";
			lifecycle = "interactive";
			status = "Demo complete. Try it.";
		} else if (outcome === "paused") {
			lifecycle = "interactive";
			settleHardware();
			status = "Demo paused. Try it.";
		}
		if (lifecycle === "interactive") drainPendingDockApp();
	}

	async function continueDemo() {
		if (!session) {
			await replay();
			return;
		}
		lifecycle = "autoplay";
		status = "See how wm arranges your windows.";
		const outcome = await playSteps(false);
		if (!(await refresh())) return;
		finishDemo(outcome);
	}

	async function finishWithoutMotion() {
		if (!session || lifecycle !== "autoplay") return;
		stopPlayback();
		lifecycle = "loading";
		fastForwarding = true;
		const outcome = await playSteps(true);
		if (!(await refresh())) return;
		fastForwarding = false;
		finishDemo(outcome);
	}

	async function initialize() {
		const generation = ++lifecycleGeneration;
		lifecycle = "loading";
		const pending: PendingBootstrap = { session: null };
		let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			const bootstrap = (async () => {
				await new Promise<void>((resolve) => {
					if (document.readyState === "complete") resolve();
					else
						window.addEventListener("load", () => resolve(), {
							once: true,
						});
				});
				if (generation !== lifecycleGeneration)
					throw new Error("Simulation bootstrap invalidated");
				const idle =
					window.requestIdleCallback ??
					((callback: IdleRequestCallback) =>
						window.setTimeout(callback, 1));
				await new Promise<void>((resolve) =>
					idle(() => resolve(), {
						timeout: tokens.runtime.lazyIdleTimeout,
					}),
				);
				if (generation !== lifecycleGeneration)
					throw new Error("Simulation bootstrap invalidated");
				const { createScenarioSession: create } = await import(
					"@paneform/layout-browser"
				);
				if (generation !== lifecycleGeneration)
					throw new Error("Simulation bootstrap invalidated");
				pending.session = await create(scenario);
				return pending.session;
			})();
			const next = await Promise.race([
				bootstrap,
				new Promise<never>(
					(_, reject) =>
						(bootstrapTimer = setTimeout(
							() =>
								reject(
									new Error("Simulation bootstrap timed out"),
								),
							tokens.runtime.bootstrapTimeout,
						)),
				),
			]);
			if (generation !== lifecycleGeneration) {
				await next.dispose();
				return;
			}
			session = next;
			if (measuredWorkArea) await updateWorkArea(measuredWorkArea);
			if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
				simulationState = await session.snapshot();
			lifecycle = "interactive";
			status = "Demo ready.";
			if (!drainPendingDockApp()) void runDemo();
		} catch {
			if (generation !== lifecycleGeneration) {
				void pending.session?.dispose();
				return;
			}
			lifecycleGeneration += 1;
			failInteractive();
		} finally {
			if (bootstrapTimer) clearTimeout(bootstrapTimer);
		}
	}

	function drainPendingDockApp(): boolean {
		if (!pendingDockApp || !session || lifecycle === "loading")
			return false;
		const app = pendingDockApp;
		pendingDockApp = null;
		void activateApp(app);
		return true;
	}

	function takeOver() {
		if (lifecycle === "autoplay") stopPlayback();
		cursorApp = null;
		lifecycle = "interactive";
		settleHardware();
		status = "You're in control.";
	}

	async function applyUser(
		step: ScenarioStep,
		description?: string,
		options?: { splash?: boolean },
	): Promise<boolean> {
		const current = session;
		if (!current) return false;
		takeOver();
		if (options?.splash) {
			showPaneformSplash();
			await tick();
		}
		if (description) status = description;
		let next: SimulationState;
		try {
			next = await current.apply(step);
		} catch {
			if (options?.splash && current === session)
				await markPaneformLayoutApplied();
			status = "Command could not be completed. Try it again.";
			liveStatus = status;
			return false;
		}
		if (current !== session) return false;
		simulationState = next;
		settleHardware();
		status = "You're in control.";
		liveStatus = status;
		if (options?.splash) await markPaneformLayoutApplied();
		return true;
	}

	function windowIdForApp(title: string): string {
		return title
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
	}

	async function activateApp(app: HeroAppTitle) {
		if (!session || lifecycle === "loading") {
			pendingDockApp = app;
			status = "Preparing the interactive demo.";
			return;
		}
		const meta = HERO_APPS.find(({ title }) => title === app);
		if (!meta) return;
		if (app === "Paneform") {
			if (simulationState?.wmRunning !== false) {
				status = "paneform wm is already running.";
				liveStatus = status;
				return;
			}
			await applyUser(
				{ command: "service start" },
				undefined,
				{ splash: true },
			);
			stage?.focus({ preventScroll: true });
			return;
		}
		const existing = simulationState?.windows.find(
			({ bundleId }) => bundleId === meta.bundleId,
		);
		if (existing) {
			await applyUser(
				{ event: { kind: "focus_changed", windowId: existing.id } },
				`paneform focuses ${app}.`,
			);
		} else {
			const display = simulationState?.topology.find(
				({ id }) => id === MACBOOK_DISPLAY_ID,
			);
			const workArea = display?.workArea ?? display?.frame;
			if (!workArea) return;
			const offset = (openSequence++ % 6) * 36;
			const maxWidth = "maxWidth" in meta ? meta.maxWidth : undefined;
			const width = Math.max(
				1,
				Math.min(maxWidth ?? 900, workArea.width - 80),
			);
			const height = Math.max(1, Math.min(620, workArea.height - 80));
			const base = {
				id: windowIdForApp(app),
				title: app,
				bundleId: meta.bundleId,
				frame: {
					x: workArea.x + Math.min(40 + offset, Math.max(0, workArea.width - width)),
					y: workArea.y + Math.min(40 + offset, Math.max(0, workArea.height - height)),
					width,
					height,
				},
			};
			const window: SimulationWindow =
				maxWidth === undefined ? base : { ...base, constraints: { maxWidth } };
			await applyUser(
				{ event: { kind: "window_added", window, focus: true } },
				`macOS opens ${app}.`,
			);
		}
		stage?.focus({ preventScroll: true });
	}

	async function focusWindow(windowId: string) {
		await applyUser({ event: { kind: "focus_changed", windowId } });
	}

	async function closeWindow(windowId: string) {
		await applyUser({ event: { kind: "window_removed", windowId } });
	}

	async function focusWorkspace(workspace: HeroWorkspace) {
		await applyUser({ command: `workspace focus ${workspace}` });
	}

	async function moveWindow(windowId: string, point: { x: number; y: number }) {
		const window = simulationState?.windows.find(({ id }) => id === windowId);
		if (!window) return;
		await applyUser({
			event: {
				kind: "window_changed",
				window: { id: windowId, frame: { ...window.frame, ...point } },
			},
		});
	}

	async function resizeWindow(windowId: string, frame: Frame) {
		await applyUser({
			event: { kind: "window_changed", window: { id: windowId, frame } },
		});
	}

	async function runKeyboardCommand(command: HeroCommand) {
		await applyUser({ command: keyboardCommand(command) });
	}

	async function replay() {
		const current = session;
		if (!current) return;
		const generation = lifecycleGeneration;
		try {
			lifecycle = "loading";
			stopPlayback();
			keyboard.releaseAll();
			session = null;
			await current.dispose();
			const { createScenarioSession: create } = await import(
				"@paneform/layout-browser"
			);
			const next = await create(scenario);
			if (generation !== lifecycleGeneration) {
				await next.dispose();
				return;
			}
			session = next;
			if (measuredWorkArea) await updateWorkArea(measuredWorkArea);
			simulationState = await session.snapshot();
			phase = "closed";
			started = false;
			stepCursor = 0;
			openSequence = 0;
			status = "Preparing the interactive demo.";
			if (pendingDockApp) {
				lifecycle = "interactive";
				drainPendingDockApp();
			} else void runDemo();
		} catch {
			failInteractive();
		}
	}

	function toggleDemo() {
		if (lifecycle === "autoplay") {
			pauseDemo(false);
			return;
		}
		if (lifecycle === "paused") {
			void continueDemo();
			return;
		}
		void replay();
	}

	onMount(() => {
		if (!stage) return;
		const detachKeyboard = keyboard.attach(stage);
		observer = new IntersectionObserver(
			([entry]) => {
				if (!entry) return;
				stageVisible = entry.intersectionRatio >= 0.6;
				if (
					stageVisible &&
					lifecycle === "paused" &&
					pausedByVisibility
				) {
					pausedByVisibility = false;
					void continueDemo();
				} else if (stageVisible) void runDemo();
				if (entry.intersectionRatio < 0.2 && lifecycle === "autoplay") {
					pauseDemo(true);
				}
			},
			{ threshold: [0.2, 0.6] },
		);
		observer.observe(stage);
		const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
		const onMotionPreference = () => {
			if (motionPreference.matches) void finishWithoutMotion();
		};
		motionPreference.addEventListener("change", onMotionPreference);
		const onVisibilityChange = () => {
			if (document.hidden && lifecycle === "autoplay") {
				pauseDemo(true);
				keyboard.releaseAll();
			} else if (
				!document.hidden &&
				stageVisible &&
				lifecycle === "paused" &&
				pausedByVisibility
			) {
				pausedByVisibility = false;
				void continueDemo();
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		void initialize();
		return () => {
			lifecycleGeneration += 1;
			playbackToken += 1;
			playbackAbort?.abort();
			observer?.disconnect();
			motionPreference.removeEventListener("change", onMotionPreference);
			document.removeEventListener(
				"visibilitychange",
				onVisibilityChange,
			);
			hidePaneformSplash();
			detachKeyboard();
			void session?.dispose();
			session = null;
		};
	});
</script>

<svelte:window onpagehide={() => keyboard.releaseAll()} onmessage={(event) => {
  if (event.origin !== window.location.origin || event.data?.type !== "wm-waitlist-interaction") return;
  const frame = stage?.querySelector<HTMLIFrameElement>(".waitlist-frame");
  if (event.source !== frame?.contentWindow) return;
  if (lifecycle === "autoplay" || lifecycle === "paused") pauseDemo(false);
}} />

<div class="wm-landing">
	<SiteHeader />
	<main>
	<section class="hero" aria-labelledby="wm-heading">
			<h1 id="wm-heading" class="visually-hidden">paneform wm interactive demo</h1>

		<div class="stage-shell">
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div
				bind:this={stage}
				class:runtime-ready={ready}
				class="stage"
				role={ready ? "region" : undefined}
				aria-label={ready
					? "Interactive Paneform window management demonstration"
					: undefined}
				aria-describedby={ready ? "stage-instructions" : undefined}
				tabindex={ready ? 0 : undefined}
			>
				<Workstation
					onworkareachange={(area) => void updateWorkArea(area)}
					state={simulationState}
					{phase}
					controller={keyboard}
					interactive={ready}
					{dockInteractive}
					paused={lifecycle === "paused"}
					fallback={lifecycle === "static" ||
						lifecycle === "loading" ||
						lifecycle === "failed"}
					{cursorApp}
					{paneformLaunching}
					onactivate={(app) => void activateApp(app)}
					onclosewindow={(windowId) => void closeWindow(windowId)}
					onfocuswindow={(windowId) => void focusWindow(windowId)}
					onfocusworkspace={(workspace) => void focusWorkspace(workspace)}
					onmovewindow={(windowId, point) => moveWindow(windowId, point)}
					onresizewindow={(windowId, frame) => resizeWindow(windowId, frame)}
				/>
				<div class="demo-control" class:available={ready}>
					<button disabled={!ready} onclick={toggleDemo} aria-label={controlLabel} aria-describedby="demo-control-help">
						<svg viewBox="0 0 24 24" aria-hidden="true">
							{#if controlIcon === "pause"}
								<path d="M9 5v14M15 5v14" />
							{:else if controlIcon === "play"}
								<path d="m9 5 11 7-11 7Z" />
							{:else}
								<path d="M4 10a8 8 0 1 1 1.5 7M4 4v6h6" />
							{/if}
						</svg>
					</button>
					<span class="control-tooltip" id="demo-control-help" role="tooltip">
						<strong>{controlLabel}</strong>
						<span>{status}</span>
					</span>
				</div>
			</div>

		</div>

		<p id="stage-instructions" class="visually-hidden">
			Click an app or focus the demo and use the keyboard.
		</p>
		<p class="visually-hidden">
			Interactive workstation simulation showing window tiling and switching workspaces.
		</p>
		<p
			class="visually-hidden"
			role="status"
			aria-live="polite"
			aria-atomic="true"
		>
			{liveStatus}
		</p>
	</section>
  </main>
  <SiteFooter onfocusin={() => { if (lifecycle === "autoplay" || lifecycle === "paused") pauseDemo(false); }}>
    {#snippet failureStatus()}{#if lifecycle === "failed"}<p role="status">{status}</p>{/if}{/snippet}
  </SiteFooter>
</div>

<svelte:head>
	<meta
		name="theme-color"
		content="#191724"
		media="(prefers-color-scheme: dark)"
	/>
	<meta
		name="theme-color"
		content="#faf4ed"
		media="(prefers-color-scheme: light)"
	/>
</svelte:head>

<style>
	:global(html:has(.wm-landing)), :global(body:has(.wm-landing)) { min-width: 0; height: 100%; overflow: hidden; }
	.wm-landing {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		height: 100svh;
		width: 100%;
		max-width: 100vw;
		min-height: 0;
	}
	main { display: grid; min-height: 0; }

	.hero {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
		width: 100%;
		max-width: 100vw;
		min-height: 0;
		overflow: hidden;
		container: hero / inline-size;
	}

  .stage { --laptop-intro-wide-width: 68%; --laptop-intro-wide-left: 16%; --laptop-intro-wide-top: 44%; }
  .stage :global(.scene) { width: min(100%, 130cqh); aspect-ratio: 1.3; margin: auto; --laptop-solo-width: 68%; --laptop-solo-top: 44%; }

	.demo-control {
		position: absolute;
		right: var(--page-gutter);
		top: var(--space-4);
		z-index: var(--layer-controls);
		visibility: hidden;
	}
	.demo-control.available { visibility: visible; }
	.demo-control button {
		display: grid;
		place-items: center;
		width: var(--control-target);
		height: var(--control-target);
		border: var(--stroke-hairline) solid transparent;
		border-radius: 50%;
		background: transparent;
		color: var(--color-page-secondary);
		cursor: pointer;
		transition: color 160ms, border-color 160ms, background 160ms;
	}
	.demo-control button:hover { color: var(--rp-rose); border-color: currentColor; background: var(--color-window-background); }
	.demo-control button:focus-visible {
		outline: var(--stroke-strong) solid var(--color-focus-ring);
		outline-offset: var(--space-1);
	}
	.demo-control svg { width: 1.1rem; height: 1.1rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
	.control-tooltip {
		position: absolute;
		top: calc(100% + var(--space-2));
		right: 0;
		width: max-content;
		max-width: min(17rem, 75vw);
		padding: var(--space-3);
		border: var(--stroke-hairline) solid var(--color-line-default);
		border-radius: var(--radius-control);
		background: var(--color-window-background);
		color: var(--color-page-secondary);
		font-size: var(--type-size-label);
		line-height: 1.5;
		visibility: hidden;
	}
	.control-tooltip strong { display: block; color: var(--color-page-foreground); }
	.demo-control.available:hover .control-tooltip,
	.demo-control.available:focus-within .control-tooltip { visibility: visible; }

	.stage-shell {
		display: grid;
		min-height: 0;
		width: 100%;
		max-width: 100vw;
		min-width: 0;
		overflow: hidden;
		container: stage / size;
	}

	.stage {
		display: grid;
		place-items: center;
		position: relative;
		width: 100%;
		max-width: 100vw;
		min-width: 0;
		min-height: 0;
		padding-inline: var(--page-gutter);
		outline: none;
	}

	.stage:focus-visible {
		outline: var(--stroke-strong) solid var(--color-focus-ring);
		outline-offset: calc(-1 * var(--stroke-strong));
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

  @container stage (max-width: 72rem) {
    .stage { padding-inline: var(--space-3); }
    .stage :global(.scene) {
      width: min(100%, 110cqh);
      aspect-ratio: 1.1;
      --laptop-solo-width: 82%;
    }
  }

  @container stage (max-width: 45rem) {
    .stage { padding-inline: 0; }
    .stage :global(.scene) {
      width: 100%;
      aspect-ratio: 0.9;
      --laptop-solo-width: 103vw;
    }
  }

  @container stage (min-width: 36.25rem) and (max-width: 72rem) {
    .stage :global(.scene) {
      /* The stage occupies the viewport space remaining after header and footer. */
      width: min(96%, 84cqh);
      aspect-ratio: 0.84;
      --laptop-solo-width: 100%;
      --laptop-solo-top: 45%;
    }
  }

</style>
