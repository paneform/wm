# Pause Behavior

Pause is an engine state, not a native-window-manager mode. The engine owns the
state and remains the authority for command validation, observation, diagnostics,
and reconciliation policy.

## State Transitions

The `pause`, `resume`, and `togglePause` commands run through the normal engine
command queue. Before committing a changed state, the engine tells a native
adapter whether matched hotkeys should be swallowed:

- Running: swallow matched configured hotkeys.
- Paused: do not swallow matched configured hotkeys.

The engine sends the initial setting before loading keybinds, so an
`--observe-only` daemon starts without a window in which it swallows shortcuts.

## Hotkeys While Paused

The native host forwards every matched non-repeat keydown to the engine in both
states. The swallow decision is separate from action delivery.

While paused, only configured chords mapped to `togglePause` or `resume` remain
swallowed. They are the unpause controls. All other configured actions, including
the `pause` command itself, are forwarded to the engine and returned to the
focused application.

The native host receives the exception chord strings during keybind
configuration. It does not inspect action strings or decide which commands are
allowed while paused.

## Engine Handling

Commands continue to reach the engine while paused. The engine applies the
existing pause gate: blocked layout and geometry mutations return a structured
`paused` error, while pause controls, queries, observation, diagnostics, and
other commands follow their normal engine rules. A paused hotkey therefore does
not become an invisible shortcut or a native-side special case.

When the engine resumes, it first restores native hotkey swallowing and then
performs the normal observed rebuild and reconciliation before accepting layout
mutations.
