---
# wm-fgbj
title: Design interactive docs experience for wm
status: completed
type: feature
priority: high
created_at: 2026-09-22T18:41:41Z
updated_at: 2026-09-27T21:41:26Z
---

Nail layout, design, and information architecture for the wm docs experience before code changes. Key pillars: (1) live scenario-backed demos embedded in every command page, (2) command metadata as source of truth co-located with engine code, (3) invocation table (CLI/socket/keybind) per command, (4) markdown for concepts/setup, (5) dynamic playground share links. Representative commands: moveDirection, moveFocusedWindowToWorkspace, doctor.

## Plan

- [x] Write design spec: IA, page anatomy, demo system, source-of-truth approach (docs/docs-experience-design.md)
- [x] Investigate config-options-as-code approach (Effect Schema annotations -> generated docs)
- [x] Build high-fidelity static HTML mockup covering the three representative command pages + docs shell
- [x] Review mockup + spec with Allan, incorporate feedback

## Feedback round 1

- Sidebar IA flattened: single Commands group with Windows/Workspaces/Diagnostics subheadings; Configuration promoted to its own group (mockup + spec).
- Fixed blank-page bug: doctor scene has no phases array; initDemo threw on scene.phases[0] and killed the script before show(). Guarded with optional chaining. Verified headless (no runtime errors, active view, demos render).

## Feedback round 2

- Demos never autoplay (mockup + spec).
- Demo top strip replaced with the playground's DesktopTopBar design: workspace chips (name badge + member window icons, gold = focused), single chip when one workspace; chips update live as windows move between workspaces.
- Decision: demo screens embed the playground stage directly (createScenarioSession + WindowSurface + DesktopTopBar), bare rectangle via new DesktopDisplay stand={false} option (implemented in apps/site, svelte-check + oxlint clean), showDock:false via scenario presentation. Spec updated (Reuse over reinvention).

## Feedback round 3

- Demo card chrome now mirrors the playground player bar (ScenarioPlayer .player-bar): step-title line shows situation before run and step caption after; transport control cycles play -> pause -> return-to-start (reset is the same control, no bespoke buttons); step rail with start/step pips fills on play; pip hover previews titles.
- Only docs-specific controls left in the transport row: the command chip and the open-in-playground link.
- Removed one-off run/reset buttons, card head situation label, and caption row from the mockup; spec anatomy section rewritten.

## Feedback round 4

- Section order on command pages: Invocation -> Arguments -> Errors -> Behavior -> Demos -> Related. Doctor analog: Invocation -> Exit codes -> Sample run -> Related. Mockup + spec updated.

## Feedback round 5

- Invocation section cells always show argument placeholders (<direction>, <workspace>) across CLI/keybind/WebSocket/scenario rows and the page synopsis chip; concrete values appear only in demo command chips. Spec invocation table + rule updated.

## Feedback round 6

- Dropped the synopsis chips under page titles (and their CSS); command syntax now appears exactly once, in the invocation table. Spec updated.

## Feedback round 7

- Live parameters: sticky segmented bar under the lede (direction/workspace) + clickable allowed values in the Arguments table, both driving one page state. Invocation cells, demo command chips, captions, and workspace tab names all re-render from it. Directional demos rotate canonical (left-facing) geometry mathematically (mirror/transpose) so up/down/right run against true rotated layouts; param change resets demos. Spec: new 'Live parameters' section, Arguments bullet updated, registry gains params sourced from grammar slot vocabulary. Scenario parameterization via docs-layer template resolution validated by the real parser; playground links encode the resolved scenario; native LayoutScenario parameters noted as future option.

## Feedback round 8

- Parameter selector restyled from discrete buttons to a joined tab strip (shared container, hairline cell dividers, iris-filled active tab). Spec wording updated to 'tab strip'.

## Feedback round 9

- Param bar minimized: dropped the card box/shadow/blur and the uppercase slot label. The bar now reads as a live command — invariant CLI prefix (wm window move / wm window move workspace) as plain mono text followed by the tab strip completing it. Spec updated.

## Feedback round 10

- Removed the per-demo command chip from the player-bar transport row (HTML, CSS, JS wiring, and the now-unused scene command templates); the parameter bar already shows the live command. Spec anatomy updated: transport row's only docs-specific addition is the playground link; keybind keycaps move to the parameter bar beside the command prefix.

## Feedback round 11

- Demo screens now reserve the work area below the workspace chip bar: window geometry maps below it in every player, so rotated (up/down) layouts no longer slide windows under the chips. Spec: rotation bullet notes work-area mapping.

## Feedback round 12

- Work-area inset corrected to exactly the workspace bar height (9%), and applied only to transposed (up/down) layouts whose authored coordinates predate the bar; default left/right views render authored geometry untouched. Spec: player auto-reserves the bar's rendered height when a top bar is enabled, mirroring scenario workArea semantics.

## Feedback round 13

- Workspace bar switched from 9% (percent, duplicated as a JS constant) to a fixed 1.35rem flex row; windows render inside a work-area element that flexes below it. Margin is exactly the bar height by construction — offset math and constants removed from renderScene. Verified left + up headlessly. Spec updated to structural reservation.

## Feedback round 14

- Confirmed engine margins are config-controlled and flow through layout-browser: MarginsSchema (per-edge top/right/bottom/left), settable at defaults/displays/workspaces scopes with per-edge merge (config.ts), exposed in scenario config, fed to the engine via configSource (scenario-runner.ts:216); engine tiles into contentRect(workArea, margins) (bsp.ts:383). Distinguished from topology workArea (physical, e.g. playground dock reservation of 144pt). Spec updated: real demos reserve chrome via config.defaults.margins.top so the engine tiles below the bar; renderer only draws chrome over the reserved zone (mockup's structural work-area remains the stand-in).

## Feedback round 15

- Mockup is now working code: demos run the real scenario runner + layout engine (@paneform/layout-browser bundled to docs/mockups/layout-engine.js via esbuild IIFE, 760KB, regeneration command in the mockup note). buildScenario maps canonical percent layouts (+ direction transforms) to logical frames in a 1440x900 display with config margins top=36; Run = session.step(), Reset/param-change = rebuild session; renderer diff-renders engine state (windows, workspace tabs, focus) with CSS transitions.
- Fixed session lifecycle race: supersede-based guards (sessionPromise identity, not run tokens) + scenario-key dedupe; root cause of the earlier hang was token guards disposing the session play() was awaiting. Verified in Node (exact scenarios step correctly, concurrency fine) and headless Chrome (move-directional up: engine swap rendered; move-workspace writing: engine retile + view-follow rendered).
- Spec: open question 'worker vs main thread' resolved for docs-scale demos; mockup note rewritten.

## Feedback round 16

- Diagnosed scale mismatch vs playground: playground renders one large display so proportional chrome (44/982 ~ camera-height) is legible; docs demo cards render the same logical display ~4x smaller, shrinking proportional chrome below legibility while authored top offsets read as dead gaps.
- Fix: decoupled presentation from simulation. Workspace bar = fixed 1.35rem UI (dropped the inline percent height); windows map into the work-area element below the bar; authored layouts re-authored content-relative (y 8..92); engine margin reduced to a realistic 24pt (invisible in render, present for engine semantics). Verified up + ws-writing headlessly with engine steps.

## Feedback round 17

- Workspace bar height 1.35rem -> 1.1rem; engine margin now derived on the client from the rendered bar height (1.1rem -> px -> logical points via screen measurement), so chrome and geometry agree exactly at any font size/card width. Hidden-view measurement fallback (0px) fixed with a default + re-measure on view activation. Verified ws-retile with writing + move-directional up headlessly.

## Feedback round 18

- Demo initial states re-authored content-exact (x/y 0, w/h filling the content area: halves, quadrants, full) so initials match engine retile output; removed the presentation margins that the engine never produces.

## Feedback round 19

- Errors section is now a three-column table (code / meaning / what to do) on all command pages; doctor's exit-codes table gained the same what-to-do column. Registry errors modeled as {code, meaning, action} triples; drift-guard asserts codes exist in the engine's closed CommandErrorCode union. Spec updated.

## Feedback round 20

- Mobile: below 42rem, tables (invocations/args/errors/exit codes) stack into labeled cards via the data-label pattern; labels auto-derived from each table's header row; snippets allowed to wrap on narrow screens; fixed a p-code nowrap leak that prevented the mockup-note command from wrapping. Verified at 500px/1x: no horizontal overflow (DOM-audited), stacked cards readable.

## Feedback round 21

- Demos restructured as section 01 'See it work' (leads the page, after lede + param bar); standalone Behavior section dissolved — per-situation behavior claims render above the stage for the active tab; shared invariants moved to the section intro.
- New demo stage: one large bordered instrument per page with situation tab strip (2-5 demos scale as tabs); sessions are lazy per demo (build on first visibility, supersede guards, scenario-key dedupe); setParam/show refresh only the active demo.
- Doctor page: sample run wrapped in the same stage chrome with a claim, no tabs.
- Spec: anatomy reordered (See it work -> Invocation -> Arguments -> Errors -> Related), behavior-prose note, 'one stage, situation tabs' section, registry demos gain {slug, tab, claim}.

## Feedback round 22

- Page-search fix for hidden tabs: stage head is now a situation index — one visible row per demo (situation chip + arrow + behavior claim), all claims real page text regardless of which demo is active. Rows select the demo (active row iris-highlighted); doctor renders a single static row. selectDemo toggles rows; SCENES claim fields removed (claims live in HTML so search works without JS). Spec: 'situation index' wording + search requirement recorded.

## Feedback round 23

- Demo selection encoded in URL as query param (?demo=slug, replaceState) — chose query over anchor: hash already owns section anchors, state composes as a set (direction + demo later), canonical can point at bare URL. Client captures the query before init state writes (initial selectDemo replaceState was clobbering the request — fixed by reading once at script start).
- Situation labels tightened to 2-4 words (Neighbor swap / Edge expand / Alone at the edge / Empty destination / Populated destination).
- Situation rows gained mini layout previews (tiny engine-state thumbnails per scenario, re-rendered per direction, first-workspace windows). Spec updated: query-param rationale, previews, concise labels, registry tab values.

## Feedback round 24

- Situation previews recolored to the paneform wm icon palette (DockIcon.svelte values): dark tile + muted panes + rose accent for the focused window, light-scheme variants from the same source (#f2e9e1/#575279/#d7827e). Previews now read as miniature wm icons; focused window identifiable by the accent color at any size.

## Feedback round 25

- Preview panes got a 2px tile-colored inset border (box-sizing: border-box), producing ~4px seams between windows and a clean inset from the tile edge — matching the wm icon's pane construction.

## Feedback round 26

- Preview palette aligned with site focus language: focused window = --rp-iris, unfocused = --rp-overlay, tile = --rp-base (was text/rose-on-overlay, which read bold and ambiguous). Renamed --pf-accent to --pf-focus.

## Feedback round 27

- Situation tabs simplified to preview + concise title (claims removed from tabs; active claim still visible via player-bar step title/caption).
- Fixed unequal tab widths: flex items were the <li> wrappers (default 0 1 auto), not the styled buttons; now .situations li flex 1 1 0 + buttons fill — equal 353px tabs verified by DOM measurement.
- Tab bar now connects to the stage: flush rail, hairline separators, active tab merged background + iris top accent line; demo border-top removed.

## Feedback round 28

- Unified tab language across param bar and situation selector: iris-filled selected tab with base text, --line separators between cells, no per-tab top/bottom border tricks.
- Fixed --line opacity bug: --line now mixes muted 40% with --page-bg (opaque) instead of transparent — identical rendering on the page background, consistent on recessed/raised surfaces.

## Feedback round 29

- Clarified bar-height state: the mockup's workspace bar is already fixed (1.1rem, structural flex workarea); the /wm/play route actually uses the proportional --camera-height (4.48%), legible only because play stages render large. Decision for the real component: the docs demo stage overrides --camera-height (1.1rem) on its container so DesktopTopBar needs no fork. Spec updated.

## Feedback round 30

- Window titlebars in demo screens (.workarea .win .bar) switched from 18%-of-window-height to fixed 1rem, matching the play route's --window-titlebar-height clamp approach — consistent titlebar thickness across tall and short windows. Spec notes the token.

## Feedback round 31

- Situation labels renamed: Borders a window / Shared edge / Exclusive edge (HTML + SCENES tab fields).
- Mobile: situation tabs stack preview-over-title to conserve width; titles wrap instead of truncating; titles centered on both layouts.

## Feedback round 32

- Demo scenarios no longer hardcode spacing: sessions apply a setup reconcile after creation (session.apply, not a counted step), so the engine refits the authored structural initial states with the scenario config's gap (LAYOUT_GAP=8pt) and margins. Changing config updates every demo automatically. Node-verified (reconcile produced 8pt gaps; swap step ran from reconciled state) and browser-verified. Spec authoring rules updated.

## Feedback round 33

- Situation tabs redesigned as rich preview tiles: each tab is a full-bleed mini layout thumbnail (touching top/left/bottom borders, right separator line) with the title as a caption strip at its bottom (muted translucency; iris strip + base text when active, plus a 2px iris top line). Tab height fixed 4.75rem on desktop; hidden demos keep no session. Mobile keeps the stacked flow layout (preview 16/10 + title below, static positioning restored after the absolute-position display:inline collapse bug). Pane seams preserved via 2px tile-colored borders. Verified desktop + 500px mobile headlessly.

## Feedback round 34

- Situation tabs unified on the stacked mobile styling everywhere: full-width 16/10 preview tile + centered title beneath, iris cell marks the active situation. Removed the desktop full-bleed overlay variant, its fixed tab height, and the mobile media overrides (now base styles). Preview tiles read much more clearly at this size.

## Feedback round 35

- Situation index switched from a scrolling flex rail to an equal-column grid (repeat(auto-fit, minmax(0, 1fr))) — every tab always fits the viewport width on mobile (2-5 tabs), no horizontal scroll; previews scale via their 16vw cap. Desktop unchanged (equal thirds of the stage panel).

## Feedback round 36

- Upstreamed the focus treatments to WindowSurface.svelte (renders /wm/play AND the /wm hero demo via DisplaySurface): unfocused managed-window bodies use --color-screen-background (focused keeps --color-window-background), unfocused traffic dots recolor to --rp-subtle (focused keep love/gold/pine), background added to the motion transition list for smooth focus changes. svelte-check clean; verified on the live /wm hero via vite dev server.

## Feedback round 37

- Hero 'broken on refresh' report investigated with an A/B (changes stashed vs applied) at matched virtual timestamps: playback animates normally in both states — WindowSurface/DesktopDisplay changes are not the cause. The earlier symptom was almost certainly a stale HMR state after dev-server restarts during verification; a full reload resolves it. Interactivity (dock, close, drag) confirmed intact in the with-changes run.

## Feedback round 37 addendum

- Added presentation.interactive flag (default true) to PresentationSchema: gates all pointer interaction on the rendered desktop (drag, resize, close, focus, dock activation). ScenarioStage combines it with its own interactive prop for WindowSurface (interactive + selectable) and DesktopDock. Schema regenerated; layout-browser tests green (143 passed); svelte-check clean. SCENARIOS.md documents the flag; docs-experience-design.md authoring rules updated: docs demo scenarios set interactive false (read-only playback, Run is the only control), /wm hero and /wm/play stay interactive by default.

## Feedback round 38

- Demo display fills the stage: removed screenwrap padding and the display shell's side/top borders inside the stage (panel border is the edge, bottom hairline meets the player bar); stage height derives from the screen's 16:10 aspect plus shell/bezel borders, so the display fills the panel perfectly.

## Feedback round 39

- Stage display fills the panel completely: zeroed the display shell padding + borders and the bezel padding inside the stage (the panel's own border/radius frames the screen). Removed the light gap between the panel edge and the screen that appeared when the stage went full-width (bezel percentage padding had scaled up).

## Feedback round 40

- Restored the display bezel/shell chrome inside the stage (previous round over-removed it) and zeroed the actual gap source: .demo .screenwrap's 0.7rem side padding, overridden inside the stage with a higher-specificity .demo-stage .demo .screenwrap rule. Display + bezel now fill the stage panel edge-to-edge.

## Feedback round 41

- Player step titles wrap to a second line when needed (2-line clamp, no ellipsis truncation) — long scenario captions like the edge-expand result now read in full. Verified with an engine-run edge-expand demo.

## Feedback round 42

- Tab/window state colors simplified to the user-specified mapping in both schemes: active tab + focused window = --rp-overlay, inactive tabs + unfocused windows = --rp-surface, text always --rp-text. Removed my per-scheme flip; situation previews match the demo windows via shared --pf-raised/--pf-sunken vars (dark: overlay/surface; light: same tokens, no flip).

## Feedback round 43

- Light-mode tab colors reversed per feedback: active tab = --rp-surface (raised/brightest), inactive = --rp-overlay (sunken). Scoped as a .situation variable override inside the light media query, so the flip covers tabs and their preview panes without touching the demo windows (which keep screen-bg/surface focus distinction).

## Feedback round 44

- Dark-mode window backgrounds swapped at the token level in global.css (single source): --color-window-background = --rp-overlay (focused/raised), --color-screen-background = --rp-surface (unfocused/sunken + desktop bg). Propagates to /wm hero, /wm/play, and docs. Verified dark-mode /wm: focused editor rises, unfocused windows recede. Light mode unchanged.

## Feedback round 45

- Mockup .win rules aligned with the global.css dark swap (they still used --win-bg/--screen-bg with the old mapping — no competing selector, just unwired tokens): .win = --screen-bg (sunken after swap), .win.focused = --win-raised (overlay in dark, surface in light; --win-raised added to :root + light block). Mockup --screen-bg dark value aligned to rp-surface to mirror the global.css change. Verified dark + light.

## Summary of Changes

Completed the interactive documentation design review with Allan. The reference snapshot includes `docs/docs-experience-design.md`, the interactive `docs/mockups/docs-experience.html`, and its bundled `layout-engine.js`. It covers reference and guide pages, fixed command examples with live scenario-backed demos, shared argument/method metadata guidance, accessible docs typography/colors, and a connected scroll-progress TOC. Reviewed desktop/mobile layout and demo interactions in Chrome, validated command syntax examples, and checked the rail animation and reduced-motion behavior. Keep this snapshot as the baseline for subsequent docs implementation work.
