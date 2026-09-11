# @paneform/layout-browser

Browser renderer and deterministic virtual window-system simulator for
`@paneform/layout`.

The package is in alpha. Its public API may change before `1.0.0`.

## Install

```sh
npm install @paneform/layout@alpha @paneform/layout-browser@alpha
```

## Interactive Simulator

```ts
import { createLayoutSimulator } from "@paneform/layout-browser";
import "@paneform/layout-browser/styles.css";

const simulator = await createLayoutSimulator(document.querySelector("#layout-demo")!);

simulator.sim.addWindow({
  title: "Terminal",
  bundleId: "com.example.terminal",
  width: 800,
  height: 600,
});
```

Use `mountLayoutRenderer(container, engine)` to render an existing layout
engine instead of creating a simulated system. Existing engines are read-only
by default; pass `{ enableCommands: true }` only in a trusted operator UI.

## Portable Scenarios

Use `createScenarioSession(document)` to load exact window geometry without
reconciling it. Call `step()` for interactive playback or `run()` for the complete
sequence. `runScenario(document)` runs and disposes a session for headless tests.

The same JSON drives the site's `/wm/play/` demo and tests. Commands use the WM
CLI syntax; events, captions, timing, and expectations are data, not scripts.
No command is sent to a shell or a live desktop.

See [the scenario specification](./SCENARIOS.md) for the format, examples, and
JSON Schema editor setup. Import `LayoutScenario` for TypeScript completion or
use `@paneform/layout-browser/scenario.schema.json` in a JSON editor.

## License

MIT
