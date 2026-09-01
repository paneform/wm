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

const simulator = await createLayoutSimulator(
  document.querySelector("#layout-demo")!,
);

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

## License

MIT
