import Foundation

public let CLIHelp = """
wm - control the window manager

USAGE
  wm [--pretty] <command>
  wm help
  wm --help

COMMANDS
  help                         Show this help.

  daemon                       Run the window manager daemon.
    --host HOST                Listen on a loopback host (default: 127.0.0.1).
    --port PORT                Listen on a port (default: 17832).
    --allow-origin ORIGIN      Allow an HTTP origin; may be repeated.

  ping                         Check whether the daemon is responding.
    --url URL                  Connect to a WebSocket URL.

  pause                        Pause automatic window management.
    --url URL                  Connect to a WebSocket URL.

  resume                       Resume automatic window management.
    --url URL                  Connect to a WebSocket URL.

  state                        Get the daemon's current state.
    observed                   Get the latest observed system state.
    --url URL                  Connect to a WebSocket URL.

  health                       Get daemon health and capabilities.
    --url URL                  Connect to a WebSocket URL.

  display                      Inspect connected displays.
    list                       List connected displays.
      --verbose                Include frames, scale, and hardware metadata.
      --url URL                Connect to a WebSocket URL.

  monitor                      Alias for display.
    list                       List connected displays.
      --url URL                Connect to a WebSocket URL.

  window                       Inspect and manage windows.
    list                       List known windows.
      --url URL                Connect to a WebSocket URL.
    focus DIRECTION            Focus and raise the nearest BSP window.
    move DIRECTION             Swap the focused BSP window spatially and retile.
      DIRECTION                left, down, up, or right.
      --url URL                Connect to a WebSocket URL.

  debug                        Bypass normal window-management behavior.
    ax focus WINDOW_ID         Focus and raise a window directly through AX.
    ax frame get WINDOW_ID     Read a frame directly through AX.
    ax frame set WINDOW_ID X Y WIDTH HEIGHT ORDER
                               Write AX position/size without reconciliation.
      ORDER                    position, size, position_then_size,
                               size_then_position, or size_position_size.
      --settle-ms MS           Wait before reading the observed frame.
      --url URL                Connect to a WebSocket URL.
    engine get                 Show runtime engine switches.
    engine set automatic-reconciliation on|off
                               Enable or suppress observer reconciliation.
      --url URL                Connect to a WebSocket URL.
    manage WINDOW_ID           Add a window to management.
      --url URL                Connect to a WebSocket URL.
    unmanage WINDOW_ID         Remove a window from management.
      --url URL                Connect to a WebSocket URL.
    frame get WINDOW_ID        Get a window's frame.
      --url URL                Connect to a WebSocket URL.
    frame set WINDOW_ID X Y WIDTH HEIGHT
                               Set and verify a window's frame.
      --tolerance POINTS       Allow this much frame variance (default: 1).
      --attempts COUNT         Try verification 1-5 times (default: 3).
      --url URL                Connect to a WebSocket URL.

  observe                      Inspect matching observed objects.
    window                     Observe windows, optionally filtered.
      --pid PID                Match a process ID.
      --exe NAME               Match an executable name.
      --app NAME               Match an application name.
      --id WINDOW_ID           Match a window ID.
      --url URL                Connect to a WebSocket URL.
    workspace NAME             Observe a workspace.
      --url URL                Connect to a WebSocket URL.

  workspace                    Inspect and control workspaces.
    list                       List workspaces.
      --url URL                Connect to a WebSocket URL.
    focus NAME                 Focus a workspace.
      --display DISPLAY_ID     Focus it on a specific display.
      --cg ID                  Select by Core Graphics display ID.
      --ns NUMBER              Select by NSScreen number.
      --name NAME              Select by exact display name.
      --url URL                Connect to a WebSocket URL.
    move-window NAME [WINDOW_ID ...]
                               Move windows to a workspace.
      --url URL                Connect to a WebSocket URL.
    move-window-bulk NAME WINDOW_ID ...
                               Move 1-128 windows in one transaction.
      --url URL                Connect to a WebSocket URL.
    move NAME [DISPLAY_ID]
                                Move a workspace to a display.
    move next [NAME]            Move the focused or named workspace to the next display.
      --cg ID                  Select by Core Graphics display ID.
      --core-graphics-display-id ID
      --core_graphics_display_id ID
      --ns NUMBER              Select by NSScreen number.
      --ns-screen-number NUMBER
      --ns_screen_number NUMBER
      --name NAME              Select by exact display name.
      --url URL                Connect to a WebSocket URL.
    mode NAME bsp|floating     Set a workspace's layout mode.
      --url URL                Connect to a WebSocket URL.
    uncooperative-window-policy NAME POLICY
                                Override constrained-window behavior for a workspace.
      greedy                    Take space from peer tiles to satisfy minimum sizes.
      stack                     Give every window the workspace frame; focus controls the front.
      overlap                   Keep constrained windows onscreen and allow tiles to overlap.
      reject                    Restore the previous layout and fail the action.
      --url URL                Connect to a WebSocket URL.

  uncooperative-window-policy POLICY
                                Set the global runtime constrained-window policy.
    greedy                     Take space from peer tiles to satisfy minimum sizes.
    stack                      Give every window the workspace frame; focus controls the front.
    overlap                    Keep constrained windows onscreen and allow tiles to overlap.
    reject                     Restore the previous layout and fail the action.
    --url URL                  Connect to a WebSocket URL.

  geometry-policy [WORKSPACE] Set global or per-workspace adaptive geometry behavior.
    --max-retries COUNT        Set verified geometry attempts from 1-5 (default: 5).
    --profile-mode MODE        store, infer, or optimistic.
                               store reuses and updates learned constraints/retry policy.
                               infer learns independently on every request.
                               optimistic tries ideal geometry before learned fallback.
    --url URL                  Connect to a WebSocket URL.

  diagnostics                  Inspect daemon diagnostics.
    inventory                  Show inventory diagnostics.
      --url URL                Connect to a WebSocket URL.

  inventory                    Control inventory collection.
    refresh                    Refresh the inventory now.
      --url URL                Connect to a WebSocket URL.

  config                       Manage $XDG_CONFIG_HOME/wm/config.jsonc.
                               Falls back to $HOME/.config/wm/config.jsonc.
    help                       Show config command help.
    validate                   Validate the config file.
    example                    Print a minimal example with defaults.
    init                       Create the config file without overwriting.
    adopt-state                Adopt current display and workspace affinities.
      --url URL                Connect to a WebSocket URL.
    reload                     Reload the config in the daemon.
      --mode delta|full        Select reload mode.
      --trigger hotload|explicit
      --url URL                Connect to a WebSocket URL.

  transaction                  Inspect command transactions.
    get ID                     Get a transaction by ID.
      --url URL                Connect to a WebSocket URL.

  batch JSON                   Run a JSON array of commands.
    --url URL                  Connect to a WebSocket URL.

  subscribe [TOPIC ...]        Stream subscription messages as NDJSON.
    --projection MODE          Use delta, snapshot, or invalidation events.
    --after-sequence NUMBER    Resume after an event sequence number.
    --url URL                  Connect to a WebSocket URL.

  start                        Start the installed daemon service (reserved).
  stop                         Stop the installed daemon service (reserved).
    --force                    Force the daemon to stop.
  restart                      Restart the installed daemon service (reserved).
  install-service              Install the daemon service (reserved).
  uninstall-service            Uninstall the daemon service (reserved).

  benchmark                    Measure daemon ping latency.
    --iterations COUNT         Set the number of requests (default: 10).
    --url URL                  Connect to a WebSocket URL.

  verify                       Verify daemon protocol behavior.
    --url URL                  Connect to a WebSocket URL.

GLOBAL FLAGS
  --pretty                     Pretty-print JSON output.
"""
