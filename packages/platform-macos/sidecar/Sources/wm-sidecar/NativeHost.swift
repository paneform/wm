import Foundation

struct NativeHostConfiguration: Equatable {
  let node: String
  let entry: String
  let config: String
  let port: UInt16

  static func parse(_ arguments: [String]) -> Self? {
    guard arguments.first == "host" else { return nil }
    var values: [String: String] = [:]
    var index = 1
    while index < arguments.count {
      guard index + 1 < arguments.count, arguments[index].hasPrefix("--") else { return nil }
      values[String(arguments[index].dropFirst(2))] = arguments[index + 1]
      index += 2
    }
    guard
      let node = values["node"], node.hasPrefix("/"),
      let entry = values["entry"], entry.hasPrefix("/"),
      let config = values["config"], config.hasPrefix("/"),
      let rawPort = values["port"], let port = UInt16(rawPort), port > 0
    else { return nil }
    return Self(node: node, entry: entry, config: config, port: port)
  }
}

@MainActor
func runNativeHost(_ configuration: NativeHostConfiguration) throws -> (Process, SidecarServer) {
  let requests = Pipe()
  let responses = Pipe()
  let child = Process()
  child.executableURL = URL(fileURLWithPath: configuration.node)
  child.arguments = [configuration.entry, "serve", "--port", String(configuration.port)]
  var environment = ProcessInfo.processInfo.environment
  environment["WM_CONFIG"] = configuration.config
  environment["WM_NATIVE_STDIO"] = "1"
  environment["WM_SKETCHYBAR_BRIDGE"] = "1"
  child.environment = environment
  child.standardInput = responses
  child.standardOutput = requests
  child.standardError = FileHandle.standardError
  child.terminationHandler = { process in
    exit(process.terminationStatus == 0 ? 0 : 1)
  }
  try child.run()

  let server = SidecarServer(
    input: requests.fileHandleForReading,
    writer: LineWriter(output: responses.fileHandleForWriting))
  server.start()
  return (child, server)
}
