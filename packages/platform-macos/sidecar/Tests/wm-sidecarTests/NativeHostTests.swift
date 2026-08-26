import Testing

@testable import wm_sidecar

@Suite struct NativeHostTests {
  @Test func parsesExplicitAbsoluteHostConfiguration() {
    #expect(
      NativeHostConfiguration.parse([
        "host", "--node", "/usr/local/bin/node", "--entry", "/opt/wm/cli.js",
        "--config", "/Users/test/.config/wm/config.jsonc", "--port", "17832",
      ])
        == NativeHostConfiguration(
          node: "/usr/local/bin/node", entry: "/opt/wm/cli.js",
          config: "/Users/test/.config/wm/config.jsonc", port: 17_832))
  }

  @Test func rejectsRelativePathsAndInvalidPorts() {
    #expect(NativeHostConfiguration.parse(["host", "--node", "node"]) == nil)
    #expect(
      NativeHostConfiguration.parse([
        "host", "--node", "/node", "--entry", "/cli", "--config", "/config",
        "--port", "0",
      ]) == nil)
  }
}
