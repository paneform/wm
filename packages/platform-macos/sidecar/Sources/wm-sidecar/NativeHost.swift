import Darwin
import Foundation
import Security

struct NativeHostConfiguration: Equatable {
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
      let config = values["config"], config.hasPrefix("/"),
      let rawPort = values["port"], let port = UInt16(rawPort), port > 0
    else { return nil }
    return Self(config: config, port: port)
  }
}

struct BundledRuntime: Equatable {
  let node: URL
  let entry: URL
  let serviceScript: URL
  let nativeExecutable: URL

  static func locate() throws -> Self {
    var size: UInt32 = 0
    _NSGetExecutablePath(nil, &size)
    var buffer = [CChar](repeating: 0, count: Int(size))
    guard _NSGetExecutablePath(&buffer, &size) == 0 else {
      throw RuntimeError.invalid("cannot resolve the loaded WM executable")
    }
    let executablePath = String(
      decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    let executable = URL(fileURLWithPath: executablePath).resolvingSymlinksInPath()
    try validateBundle(containing: executable)
    return try resolve(executableURL: executable)
  }

  static func resolve(executableURL: URL) throws -> Self {
    let executable = executableURL.resolvingSymlinksInPath()
    let expectedResources = executable.deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Resources", isDirectory: true)
    let resources = expectedResources.resolvingSymlinksInPath()
    guard resources == expectedResources else {
      throw RuntimeError.invalid("WM.app Resources must not be a symlink")
    }
    let runtime = Self(
      node: resources.appendingPathComponent("node").resolvingSymlinksInPath(),
      entry: resources.appendingPathComponent("cli.mjs").resolvingSymlinksInPath(),
      serviceScript: resources.appendingPathComponent("wm-service.sh").resolvingSymlinksInPath(),
      nativeExecutable: executable)
    guard
      [runtime.node, runtime.entry, runtime.serviceScript].allSatisfy({
        $0.deletingLastPathComponent() == resources
      })
    else {
      throw RuntimeError.invalid("bundled resource escapes WM.app")
    }
    guard FileManager.default.isExecutableFile(atPath: runtime.node.path) else {
      throw RuntimeError.missing(runtime.node.path)
    }
    guard FileManager.default.isReadableFile(atPath: runtime.entry.path) else {
      throw RuntimeError.missing(runtime.entry.path)
    }
    guard FileManager.default.isReadableFile(atPath: runtime.serviceScript.path) else {
      throw RuntimeError.missing(runtime.serviceScript.path)
    }
    return runtime
  }

  private static func validateBundle(containing executable: URL) throws {
    let bundle = executable.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    var staticCode: SecStaticCode?
    let created = SecStaticCodeCreateWithPath(bundle as CFURL, [], &staticCode)
    guard created == errSecSuccess, let staticCode else {
      throw RuntimeError.invalid(
        "cannot inspect WM.app signature at \(bundle.path) (OSStatus \(created))")
    }
    let validationFlags = SecCSFlags(
      rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode | kSecCSCheckAllArchitectures)
    let checked = SecStaticCodeCheckValidity(staticCode, validationFlags, nil)
    guard checked == errSecSuccess else {
      throw RuntimeError.invalid("WM.app signature is invalid (OSStatus \(checked))")
    }
  }
}

enum RuntimeError: Error, CustomStringConvertible {
  case missing(String)
  case invalid(String)

  var description: String {
    switch self {
    case .missing(let path): "bundled runtime file is missing: \(path)"
    case .invalid(let detail): detail
    }
  }
}

private func childEnvironment(_ additions: [String: String] = [:]) -> [String: String] {
  let inherited = ProcessInfo.processInfo.environment
  let allowed = [
    "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "PATH",
    "XDG_CONFIG_HOME", "XDG_STATE_HOME", "WM_CONFIG", "WM_OBSERVATIONS",
  ]
  var environment = inherited.filter { allowed.contains($0.key) }
  for (key, value) in additions { environment[key] = value }
  return environment
}

@MainActor
func runNativeHost(
  _ configuration: NativeHostConfiguration, runtime: BundledRuntime
) throws -> (Process, SidecarServer) {
  let requests = Pipe()
  let responses = Pipe()
  let child = Process()
  child.executableURL = runtime.node
  child.arguments = [runtime.entry.path, "serve", "--port", String(configuration.port)]
  child.environment = childEnvironment([
    "WM_CONFIG": configuration.config,
    "WM_NATIVE_STDIO": "1",
    "WM_SKETCHYBAR_BRIDGE": "1",
  ])
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

func runCLI(_ arguments: [String], runtime: BundledRuntime) throws -> Int32 {
  let child = Process()
  child.executableURL = runtime.node
  child.arguments = [runtime.entry.path] + arguments + ["--sidecar", runtime.nativeExecutable.path]
  child.environment = childEnvironment()
  child.standardInput = FileHandle.standardInput
  child.standardOutput = FileHandle.standardOutput
  child.standardError = FileHandle.standardError
  try child.run()
  child.waitUntilExit()
  return child.terminationStatus
}

func runService(_ arguments: [String], runtime: BundledRuntime) throws -> Int32 {
  let child = Process()
  child.executableURL = URL(fileURLWithPath: "/bin/bash")
  child.arguments = [runtime.serviceScript.path] + arguments
  child.environment = childEnvironment([
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    "WM_NATIVE_HOST": runtime.nativeExecutable.path,
  ])
  child.standardInput = FileHandle.standardInput
  child.standardOutput = FileHandle.standardOutput
  child.standardError = FileHandle.standardError
  try child.run()
  child.waitUntilExit()
  return child.terminationStatus
}
