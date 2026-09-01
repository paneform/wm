# @paneform/layout

Portable TypeScript engine for window layout, workspace policy, reconciliation,
and platform-independent window management.

The package is in alpha. Its public API may change before `1.0.0`.

## Install

```sh
npm install @paneform/layout
```

## Usage

The engine runs against an injected `PlatformAdapter`, `ConfigSource`, and
`Clock`, allowing the same policy engine to run against macOS, a browser
simulation, or a test platform.

```ts
import { Effect } from "effect";
import { createEngine } from "@paneform/layout";

const engine = await Effect.runPromise(
  createEngine({ adapter, configSource, clock }),
);

await Effect.runPromise(engine.start());
```

Test utilities are available from `@paneform/layout/testing`.

## License

MIT
