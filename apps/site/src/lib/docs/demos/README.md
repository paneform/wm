# Command scenarios

Every JSON file here is a complete portable `LayoutScenario`. Use the smallest
scene that makes the command understandable: usually one or two windows and one
display. Display-move examples use two displays. The directional reference keeps
three situations because its behavior depends on the starting layout.

Describe windows by their visible starting roles: the focused window, its left
neighbor, or a window in the destination workspace. Keep captions short and use
the same roles in situation introductions. Previews do not show app names.
Role-based IDs such as `focused-window` and `left-neighbor` are stable identifiers
in these scenario files, not special CLI selectors. Use a current window ID from
`wm windows` when running an explicit-ID command against your live desktop.

Starting descriptions and step captions share a **32ch, two-line monospace**
area. Keep each to **64 characters maximum**, with words that wrap into at most
two 32-column lines. `demo-caption.ts` owns the width and derived limit;
`parseDocsScenario` and the automated docs tests enforce them. Text is wrapped
at word boundaries without truncation. This budget applies to docs examples,
not to general playground or hero scenarios.

## Add a demo

1. Add a JSON file with the initial state, explicit read-only presentation, and
   exactly one playable command. Put preparation steps first and mark the
   demonstrated command with `"playback": "start"`.
2. Give every preparation and playback step a meaningful `expect`. The runner
   validates these clauses; the test does not maintain a second expected state.
   Frames currently use exact logical points. Check the starting state after
   reconciliation rather than asserting the raw structural sketch.
3. Import the file in `../scenario-files.ts`. Its literal filename becomes a
   valid manifest file ID. Missing imports fail compilation.
4. Register a situation in `../demo-manifest.ts` under the engine command type
   or service action. Use an explicit `unavailable` entry with a reason for a
   command the simulator cannot execute.
5. Run `pnpm --filter @paneform/site exec vitest run test/docs.spec.ts` and
   `pnpm --filter @paneform/site typecheck`.

The manifest is exhaustive over the implementation's engine command union,
service action vocabulary, and local diagnostic command union. Adding a command
requires a coverage decision. Compile-time negative fixtures in
`test/docs-manifest.typecheck.ts` verify rejection of missing coverage, unknown
command/file IDs, empty desktop entries, and unexplained exceptions.

The test discovers files, rejects orphans and duplicate registrations, checks
that the playable command matches its manifest identity, and runs each scenario
with all expectations. Page demos are joined through the generated command
catalog, so aliases share coverage. The focused and explicit-ID workspace moves
remain distinct situations on one page, each labeled with its actual command.

Service scenarios start/stop/restart the simulated engine only. Queries verify
that the desktop stays unchanged; they do not fabricate native CLI output.
The limit-probe scenario prepares a parked window, as required by the engine.
Doctor retains its illustrative terminal replay; native installation, permission
prompts, and transport subscriptions are explicitly outside desktop simulation.
