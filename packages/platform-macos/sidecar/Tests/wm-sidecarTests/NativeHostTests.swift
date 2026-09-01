import Foundation
import Testing

@testable import wm_sidecar

@Suite struct NativeHostTests {
  @Test func parsesExplicitAbsoluteHostConfiguration() {
    #expect(
      NativeHostConfiguration.parse([
        "host", "--config", "/Users/test/.config/wm/config.jsonc", "--port", "17832",
      ])
        == NativeHostConfiguration(
          config: "/Users/test/.config/wm/config.jsonc", port: 17_832))
  }

  @Test func rejectsRelativePathsAndInvalidPorts() {
    #expect(
      NativeHostConfiguration.parse(["host", "--config", "config", "--port", "17832"]) == nil)
    #expect(
      NativeHostConfiguration.parse([
        "host", "--config", "/config", "--port", "0",
      ]) == nil)
  }

  @Test func locatesRuntimeRelativeToResolvedExecutable() throws {
    let temporary = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let executable = temporary.appendingPathComponent("wm.app/Contents/MacOS/wm")
    let resources = temporary.appendingPathComponent("wm.app/Contents/Resources")
    try FileManager.default.createDirectory(
      at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: executable.path, contents: Data())
    FileManager.default.createFile(
      atPath: resources.appendingPathComponent("node").path, contents: Data())
    FileManager.default.createFile(
      atPath: resources.appendingPathComponent("cli.mjs").path, contents: Data())
    FileManager.default.createFile(
      atPath: resources.appendingPathComponent("wm-service.sh").path, contents: Data())
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700], ofItemAtPath: resources.appendingPathComponent("node").path)
    defer { try? FileManager.default.removeItem(at: temporary) }

    #expect(
      try BundledRuntime.resolve(executableURL: executable)
        == BundledRuntime(
          node: resources.appendingPathComponent("node"),
          entry: resources.appendingPathComponent("cli.mjs"),
          serviceScript: resources.appendingPathComponent("wm-service.sh"),
          nativeExecutable: executable))
  }
}
