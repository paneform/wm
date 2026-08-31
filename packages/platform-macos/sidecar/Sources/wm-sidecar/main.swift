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

let arguments = Array(CommandLine.arguments.dropFirst())
var retainedChild: Process?
var retainedServer: SidecarServer?
var retainedSignals: [DispatchSourceSignal] = []
if arguments.first == "sidecar" {
  guard arguments.count == 1 else {
    FileHandle.standardError.write(Data("usage: wm sidecar\n".utf8))
    exit(2)
  }
  retainedServer = SidecarServer()
  retainedServer?.start()
} else if arguments.first == "host" {
  guard let configuration = NativeHostConfiguration.parse(arguments) else {
    FileHandle.standardError.write(
      Data("usage: wm host --config PATH --port PORT\n".utf8))
    exit(2)
  }
  do {
    (retainedChild, retainedServer) = try runNativeHost(
      configuration, runtime: BundledRuntime.locate())
    for signalNumber in [SIGINT, SIGTERM] {
      signal(signalNumber, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
      source.setEventHandler { retainedChild?.terminate() }
      source.resume()
      retainedSignals.append(source)
    }
  } catch {
    FileHandle.standardError.write(Data("native host failed: \(error)\n".utf8))
    exit(1)
  }
} else if arguments.first == "service" {
  do {
    exit(try runService(Array(arguments.dropFirst()), runtime: BundledRuntime.locate()))
  } catch {
    FileHandle.standardError.write(Data("service command failed: \(error)\n".utf8))
    exit(1)
  }
} else {
  do {
    exit(try runCLI(arguments, runtime: BundledRuntime.locate()))
  } catch {
    FileHandle.standardError.write(Data("CLI failed: \(error)\n".utf8))
    exit(1)
  }
}
RunLoop.main.run()
