<script lang="ts">
	import { onNavigate } from "$app/navigation";
	import { onMount, tick } from "svelte";

	import {
		heroKeyboardChords,
		keyboardKeys,
		tokens,
		type HeroCommand,
	} from "$lib/design/tokens.js";
	import Workstation, { type ScenePhase } from "./Workstation.svelte";
	import PaneformWordmark from "./PaneformWordmark.svelte";
	import WaitlistForm from "./WaitlistForm.svelte";
	import type { ActionArbiter } from "./action-arbiter.js";
	import type { DemoRunner, DemoRunResult } from "./demo-runner.js";
	import type { DemoCue } from "./demo-timeline.js";
	import type {
		HeroActionResult,
		HeroCommittedSnapshot,
		HeroSimulation,
		HeroWindowFrame,
	} from "./create-hero-simulation.js";
	import type { HeroAppTitle, HeroWorkspace } from "./hero-model.js";
	import {
		browserKeyboardScheduler,
		createKeyboardController,
	} from "./keyboard-controller.js";
	import type {
		SimulationClient,
		SimulationSession,
	} from "./simulation-client.js";


	type Lifecycle =
		| "static"
		| "loading"
		| "autoplay"
		| "paused"
		| "interactive"
		| "failed";
	interface PendingBootstrap {
		client: SimulationClient | null;
	}

	let measuredWorkArea: HeroWindowFrame | null = null;
	async function updateWorkArea(area: HeroWindowFrame) {
		measuredWorkArea = area;
		const current = session;
		if (!current) return;
		const result = await current.simulation.updateMacBookWorkArea(area);
		if (current !== session) return;
		if (result.ok) snapshot = result.snapshot;
		else failInteractive();
	}
	let stage = $state<HTMLElement>();
	let lifecycle = $state<Lifecycle>("static");
	let phase = $state<ScenePhase>("closed");
	let snapshot = $state<HeroCommittedSnapshot | null>(null);
	let status = $state("Preparing the interactive demo.");
	let liveStatus = $state("");
	let cursorApp = $state<HeroAppTitle | null>(null);
	let paneformLaunchActive = $state(false);
	let paneformSplashMinimumElapsed = $state(true);
	let paneformLayoutApplied = $state(true);
	let pendingDockApp = $state<HeroAppTitle | null>(null);
	let stageVisible = $state(false);
	let client: SimulationClient | null = null;
	let session: SimulationSession | null = null;
	let runner: DemoRunner | null = null;
	let activeRun: Promise<DemoRunResult> | null = null;
	let started = false;
	let observer: IntersectionObserver | null = null;
	let lifecycleGeneration = 0;
	let pausedByVisibility = false;
	let fastForwarding = false;
	let paneformSplashGeneration = 0;
	const commandGates = new Map<
		string,
		{
			triggered: Promise<void>;
			committed: Promise<void>;
			resolveTriggered(): void;
			resolveCommitted(): void;
		}
	>();

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
		runner?.abort();
		cursorApp = null;
		await client?.dispose();
	});

	function settleHardware() {
		const external = snapshot?.state.topology.length === 2;
		phase = external ? "complete" : "desktop";
	}

	function showPaneformSplash() {
		const generation = ++paneformSplashGeneration;
		paneformLaunchActive = true;
		paneformSplashMinimumElapsed = false;
		paneformLayoutApplied = false;
		setTimeout(() => {
			if (generation === paneformSplashGeneration)
				paneformSplashMinimumElapsed = true;
		}, 1500);
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

	function failInteractive() {
		runner?.abort();
		cursorApp = null;
		lifecycle = "failed";
		phase = "complete";
		snapshot = null;
		session = null;
		status = "Interactive demo unavailable";
		void client?.dispose();
	}

	function pauseDemo(automatic: boolean) {
		if (lifecycle !== "autoplay") return;
		runner?.pause();
		pausedByVisibility = automatic;
		lifecycle = "paused";
		status = "Demo paused.";
	}

	async function refresh(): Promise<boolean> {
		const current = session;
		if (!current) return false;
		const next = await current.simulation.snapshot();
		if (current !== session || current !== client?.current()) return false;
		if (!next.valid) {
			failInteractive();
			return false;
		}
		snapshot = next;
		return true;
	}

	function commandGate(cue: DemoCue) {
		let resolveTriggered = () => {};
		let resolveCommitted = () => {};
		const gate = {
			triggered: new Promise<void>(
				(resolve) => (resolveTriggered = resolve),
			),
			committed: new Promise<void>(
				(resolve) => (resolveCommitted = resolve),
			),
			resolveTriggered: () => resolveTriggered(),
			resolveCommitted: () => resolveCommitted(),
		};
		commandGates.set(cue.id, gate);
		return gate;
	}

	function cuePresentation(cue: DemoCue, signal: AbortSignal): Promise<void> {
		switch (cue.action.type) {
			case "present":
				if (cue.action.name === "open-lid") phase = "opening";
				if (cue.action.name === "signal-lock") phase = "signal";
				if (cue.action.name === "desktop") phase = "desktop";
				if (cue.action.name === "monitor-enter") phase = "monitor";
				if (cue.action.name === "power-on") phase = "powered";
				if (cue.action.name === "complete") phase = "complete";
				return Promise.resolve();
			case "connect-display":
				phase = "connected";
				return Promise.resolve();
			case "activate-app":
				cursorApp = cue.action.app;
				return Promise.resolve();
			case "move-window": {
				cursorApp = null;
				const gate = commandGate(cue);
				return keyboard.chord({
					keys: [
						"lshift",
						"rshift",
						cue.action.workspace.toLowerCase(),
					],
					preHold: tokens.motion.chordPrelude,
					hold: tokens.motion.chordHold,
					pressStagger: tokens.motion.chordStagger,
					releaseStagger: tokens.motion.keyReleaseStagger,
					source: "script",
					signal,
					onTrigger: () => {
						gate.resolveTriggered();
						return gate.committed;
					},
				});
			}
			case "launch-wm":
				cursorApp = "Paneform";
				return Promise.resolve();
			case "move-direction":
			case "focus-direction": {
				cursorApp = null;
				const gate = commandGate(cue);
				const key = { left: "h", down: "j", up: "k", right: "l" }[
					cue.action.direction
				];
				return keyboard.chord({
					keys:
						cue.action.type === "move-direction"
							? ["lshift", "rshift", key]
							: ["rshift", key],
					preHold:
						cue.action.type === "move-direction"
							? tokens.motion.chordPrelude
							: tokens.motion.twoKeyPrelude,
					hold:
						cue.action.type === "move-direction"
							? tokens.motion.chordHold
							: tokens.motion.twoKeyHold,
					pressStagger: tokens.motion.chordStagger,
					releaseStagger: tokens.motion.keyReleaseStagger,
					source: "script",
					signal,
					onTrigger: () => {
						gate.resolveTriggered();
						return gate.committed;
					},
				});
			}
			case "move-workspace-display": {
				const gate = commandGate(cue);
				return keyboard.chord({
					keys: ["lshift", "rshift", "tab"],
					preHold: tokens.motion.chordPrelude,
					hold: tokens.motion.chordHold,
					pressStagger: tokens.motion.chordStagger,
					releaseStagger: tokens.motion.keyReleaseStagger,
					source: "script",
					signal,
					onTrigger: () => {
						gate.resolveTriggered();
						return gate.committed;
					},
				});
			}
			case "focus-workspace": {
				const gate = commandGate(cue);
				return keyboard.chord({
					keys: ["rshift", cue.action.workspace.toLowerCase()],
					preHold: tokens.motion.twoKeyPrelude,
					hold: tokens.motion.twoKeyHold,
					releaseStagger: tokens.motion.keyReleaseStagger,
					source: "script",
					signal,
					onTrigger: () => {
						gate.resolveTriggered();
						return gate.committed;
					},
				});
			}
			default:
				return Promise.resolve();
		}
	}

	async function createRunner(current: SimulationSession) {
		const { createDemoRunner } = await import("./demo-runner.js");
		return createDemoRunner({
			includeSettings: !matchMedia("(max-width: 45rem)").matches,
			simulation: current.simulation,
			arbiter: current.arbiter,
			presentation: {
				run: (cue, { signal }) => cuePresentation(cue, signal),
				commandReady: (cue) =>
					commandGates.get(cue.id)?.triggered ?? null,
				commandExecuting: async (cue) => {
					if (cue.action.type !== "launch-wm") return;
					showPaneformSplash();
					await tick();
				},
				commandCommitted: async (cue) => {
					await tick();
					if (cue.action.type === "launch-wm") await markPaneformLayoutApplied();
					commandGates.get(cue.id)?.resolveCommitted();
					commandGates.delete(cue.id);
				},
				cancel: () => {
					cursorApp = null;
					hidePaneformSplash();
					for (const gate of commandGates.values()) {
						gate.resolveTriggered();
						gate.resolveCommitted();
					}
					commandGates.clear();
					keyboard.releaseAll({ source: "script" });
				},
				settleFinal: () => {
					phase = "complete";
				},
			},
			onSnapshot: (next) => {
				if (!next.valid) {
					failInteractive();
					return;
				}
				if (current === session && !fastForwarding) snapshot = next;
			},
		});
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
		runner = await createRunner(session);
		const operation = runner.run({ reducedMotion });
		activeRun = operation;
		const result = await operation;
		if (activeRun === operation) activeRun = null;
		if (!(await refresh())) return;
		fastForwarding = false;
		finishDemo(result);
	}

	function finishDemo(result: DemoRunResult) {
		if (lifecycle === "failed") return;
		if (result.status === "completed") {
			phase = "complete";
			lifecycle = "interactive";
			status = "Demo complete. Try it.";
		} else if (result.status === "paused") {
			lifecycle = "interactive";
			settleHardware();
			status = "Demo paused. Try it.";
		}
		if (lifecycle === "interactive") drainPendingDockApp();
	}

	async function continueDemo() {
		if (!runner) {
			await replay();
			return;
		}
		await activeRun;
		lifecycle = "autoplay";
		status = "See how wm arranges your windows.";
		const operation = runner.run();
		activeRun = operation;
		const result = await operation;
		if (activeRun === operation) activeRun = null;
		if (!(await refresh())) return;
		finishDemo(result);
	}

	async function finishWithoutMotion() {
		if (!runner || lifecycle !== "autoplay") return;
		runner.pause();
		lifecycle = "loading";
		fastForwarding = true;
		await activeRun;
		const operation = runner.run({ reducedMotion: true });
		activeRun = operation;
		const result = await operation;
		if (activeRun === operation) activeRun = null;
		if (!(await refresh())) return;
		fastForwarding = false;
		finishDemo(result);
	}

	async function initialize() {
		const generation = ++lifecycleGeneration;
		lifecycle = "loading";
		const pending: PendingBootstrap = { client: null };
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
				const { createSimulationClient } = await import(
					"./simulation-client.js"
				);
				if (generation !== lifecycleGeneration)
					throw new Error("Simulation bootstrap invalidated");
				const nextClient = createSimulationClient();
				pending.client = nextClient;
				client = nextClient;
				return {
					client: nextClient,
					session: await nextClient.start(),
				};
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
				await next.client.dispose();
				return;
			}
			client = next.client;
			session = next.session;
			if (measuredWorkArea) await updateWorkArea(measuredWorkArea);
			const initialSnapshot = await session.simulation.snapshot();
			if (!initialSnapshot.valid)
				throw new Error(
					"Simulation bootstrap produced an invalid state",
				);
			if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
				snapshot = initialSnapshot;
			lifecycle = "interactive";
			status = "Demo ready.";
			if (!drainPendingDockApp()) void runDemo();
		} catch {
			if (generation !== lifecycleGeneration) {
				void pending.client?.dispose();
				return;
			}
			lifecycleGeneration += 1;
			client ??= pending.client;
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
		runner?.abort();
		cursorApp = null;
		keyboard.releaseAll({ source: "script" });
		lifecycle = "interactive";
		settleHardware();
		status = "You're in control.";
	}

	async function submitUser(
		action: (simulation: HeroSimulation) => Promise<HeroActionResult>,
		description?: string,
		beforeSubmit?: () => void | Promise<void>,
	) {
		if (!session) return;
		takeOver();
		await beforeSubmit?.();
		if (description) status = description;
		const current = session;
		const outcome = await current.arbiter.submitUser(() =>
			action(current.simulation),
		);
		if (outcome.status === "completed") {
			if (!outcome.value.snapshot.valid) {
				failInteractive();
				return;
			}
			snapshot = outcome.value.snapshot;
			settleHardware();
			status = outcome.value.ok
				? "You're in control."
				: "Command could not be completed. Try it again.";
			liveStatus = status;
		}
	}

	async function activateApp(app: HeroAppTitle) {
		if (!session || lifecycle === "loading") {
			pendingDockApp = app;
			status = "Preparing the interactive demo.";
			return;
		}
		const unopened = !snapshot?.apps[app];
		const launchingPaneform = app === "Paneform" && !snapshot?.wmRunning;
		try {
			await submitUser(
				(simulation) => simulation.activateApp(app),
				unopened ? `macOS opens ${app}` : `paneform focuses ${app}`,
				launchingPaneform
					? async () => {
							showPaneformSplash();
							await tick();
						}
					: undefined,
			);
		} finally {
			if (launchingPaneform && snapshot?.wmRunning) await markPaneformLayoutApplied();
			stage?.focus({ preventScroll: true });
		}
	}

	async function focusWindow(app: HeroAppTitle) {
		await submitUser((simulation) => simulation.focusWindow(app));
	}

	async function closeWindow(app: HeroAppTitle) {
		await submitUser((simulation) => simulation.closeWindow(app));
	}

	async function focusWorkspace(workspace: HeroWorkspace) {
		await submitUser((simulation) => simulation.focusWorkspace(workspace));
	}

	async function moveWindow(app: HeroAppTitle, point: { x: number; y: number }) {
		await submitUser((simulation) => simulation.moveWindow(app, point));
	}

	async function resizeWindow(app: HeroAppTitle, frame: HeroWindowFrame) {
		await submitUser((simulation) => simulation.resizeWindow(app, frame));
	}

	async function runKeyboardCommand(command: HeroCommand) {
		switch (command.type) {
			case "moveFocusedWindowToWorkspace":
				await submitUser((simulation) =>
					simulation.moveFocusedWindowToWorkspace(command.workspace),
				);
				break;
			case "moveDirection":
				await submitUser((simulation) =>
					simulation.moveDirection(command.direction),
				);
				break;
			case "focusDirection":
				await submitUser((simulation) =>
					simulation.focusDirection(command.direction),
				);
				break;
			case "moveFocusedWorkspaceToNextDisplay":
				await submitUser((simulation) =>
					simulation.moveFocusedWorkspaceToNextDisplay(),
				);
				break;
			case "focusWorkspace":
				await submitUser((simulation) =>
					simulation.focusWorkspace(command.workspace),
				);
				break;
		}
	}

	async function replay() {
		if (!client) return;
		try {
			lifecycle = "loading";
			runner?.abort();
			keyboard.releaseAll();
			session = await client.replay();
			if (measuredWorkArea) await updateWorkArea(measuredWorkArea);
			snapshot = await session.simulation.snapshot();
			phase = "closed";
			started = false;
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
			observer?.disconnect();
			motionPreference.removeEventListener("change", onMotionPreference);
			document.removeEventListener(
				"visibilitychange",
				onVisibilityChange,
			);
			runner?.abort();
			hidePaneformSplash();
			detachKeyboard();
			void client?.dispose();
		};
	});
</script>

<svelte:window onpagehide={() => keyboard.releaseAll()} onmessage={(event) => {
  if (event.origin !== window.location.origin || event.data?.type !== "wm-waitlist-interaction") return;
  const frame = stage?.querySelector<HTMLIFrameElement>(".waitlist-frame");
  if (event.source !== frame?.contentWindow) return;
  if (lifecycle === "autoplay" || lifecycle === "paused") pauseDemo(false);
}} />

<main class="wm-landing">
	<section class="hero" aria-labelledby="wm-heading">
		<header class="hero-header">
			<div class="wordmark"><PaneformWordmark clipId="paneform-hero-clip" /></div>
			<h1 id="wm-heading" class="visually-hidden">paneform wm interactive demo</h1>
		</header>

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
					{snapshot}
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
					onclosewindow={(app) => void closeWindow(app)}
					onfocuswindow={(app) => void focusWindow(app)}
					onfocusworkspace={(workspace) => void focusWorkspace(workspace)}
					onmovewindow={(app, point) => moveWindow(app, point)}
					onresizewindow={(app, frame) => resizeWindow(app, frame)}
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
  <footer id="waitlist-signup" class="stage-controls" onfocusin={() => { if (lifecycle === "autoplay" || lifecycle === "paused") pauseDemo(false); }}>
    <p>Built for macOS on Apple silicon.</p>
    {#if lifecycle === "failed"}<p role="status">{status}</p>{/if}
    <div class="footer-form"><WaitlistForm compact /></div>
  </footer>
</main>

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
	main {
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
		height: 100svh;
		width: 100%;
		max-width: 100vw;
		min-height: 0;
	}

	.hero {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: auto minmax(0, 1fr);
		width: 100%;
		max-width: 100vw;
		min-height: 0;
		overflow: hidden;
		container: hero / inline-size;
	}

  .hero-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: var(--space-5) var(--page-gutter); }
  .wordmark { width: min(11rem, 42vw); }
  .wordmark :global(svg) { width: 100%; }
  .footer-form { width: min(100%, 30rem); min-width: 0; }
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

	.stage-controls {
		z-index: var(--layer-controls);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		padding: var(--space-3) var(--page-gutter) var(--space-4);
		border-block-start: var(--stroke-hairline) solid
			var(--color-line-default);
		color: var(--color-page-quiet);
		font-size: var(--type-size-label);
	}

	.stage-controls p {
		margin: 0;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}


	@media (max-width: 45rem) {
		.footer-form { width: min(100%, 30rem); }
		.stage-controls {
			align-items: center;
			text-align: center;
			flex-direction: column;
		}
	}
</style>
