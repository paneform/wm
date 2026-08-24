import AppKit
import Foundation

// wm-sidecar entry point. The main thread runs the main run loop so that
// NSWorkspace notifications (sleep/wake/space/activation) are delivered;
// all protocol work runs as structured concurrency on the MainActor, which
// cooperates with that run loop.
//
// Topology changes are detected by polling CGGetOnlineDisplayList (~500 ms):
// without an event loop AppKit screen notifications never deliver (bean
// wm-dm8l), and polling is authoritative even for sleep/clamshell states.

let server = SidecarServer()
server.start()
RunLoop.main.run()
