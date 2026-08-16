import Foundation
import Testing
@testable import WMConfiguration

private let basic = #"{"workspaces":[{"name":"main"}]}"#

@Test func parsesJSONCAndAppliesDefaultsFieldByField() throws {
    let value = try ConfigurationParser.parse(#"""
    {
      // global layout
      "defaults": { "mode": "floating", "margin": {"top":12,"right":12,"bottom":12,"left":12}, "gap": 7, "resize_increment": 4, "layout_policy":["overlap"] },
      "workspaces": [
        { "name": "code", "gap": 2 }, /* local override */
        { "name": "web", "preferred_display": "external" }
      ]
    }
    """#)
    #expect(value.hotload)
    #expect(value.port == 17_832)
    let margin = WorkspaceMargins(top: 12, right: 12, bottom: 12, left: 12)
    #expect(value.resolvedWorkspaces[0].settings == .init(mode: .floating, margin: margin, gap: 2, resizeIncrement: 4, layoutPolicy: [.overlap], maxGeometryRetries: 5, geometryProfileMode: .store))
    #expect(value.resolvedWorkspaces[1].settings == .init(preferredDisplay: .init(id: "external"), mode: .floating, margin: margin, gap: 7, resizeIncrement: 4, layoutPolicy: [.overlap], maxGeometryRetries: 5, geometryProfileMode: .store))
}

@Test func layoutPolicyDefaultsAndWorkspaceOverridesGlobal() throws {
    #expect(try ConfigurationParser.parse("{}").defaults.layoutPolicy == [.greedy, .overlap, .stack, .overflow])
    let value = try ConfigurationParser.parse(#"{"defaults":{"layout_policy":["stack","overflow"]},"workspaces":[{"name":"code","layout_policy":["reject"]},{"name":"web"}]}"#)
    #expect(value.resolvedWorkspaces.map(\.settings.layoutPolicy) == [[.reject], [.stack, .overflow]])
}

@Test(arguments: [
    #"{"defaults":{"layout_policy":[]}}"#,
    #"{"defaults":{"layout_policy":["stack","stack"]}}"#,
    #"{"defaults":{"layout_policy":["reject","overflow"]}}"#,
]) func invalidLayoutPolicyChainsFail(_ source: String) {
    #expect(throws: ConfigurationError.self) { try ConfigurationParser.parse(source) }
}

@Test func adaptiveGeometryDefaultsAndWorkspaceOverridesResolve() throws {
    let defaults = try ConfigurationParser.parse("{}").defaults
    #expect(defaults.maxGeometryRetries == 5)
    #expect(defaults.geometryProfileMode == .store)
    let value = try ConfigurationParser.parse(#"{"defaults":{"max_geometry_retries":4,"geometry_profile_mode":"optimistic"},"workspaces":[{"name":"code","max_geometry_retries":2,"geometry_profile_mode":"infer"},{"name":"web"}]}"#)
    #expect(value.resolvedWorkspaces.map(\.settings.maxGeometryRetries) == [2, 4])
    #expect(value.resolvedWorkspaces.map(\.settings.geometryProfileMode) == [.infer, .optimistic])
}

@Test(arguments: [0, 6])
func rejectsInvalidGeometryRetryCount(value: Int) {
    #expect(throws: ConfigurationError.self) {
        try ConfigurationParser.parse(#"{"defaults":{"max_geometry_retries":\#(value)}}"#)
    }
}

@Test func displayAffinityAcceptsCanonicalAndSelectorForms() throws {
    let value = try ConfigurationParser.parse(#"""
    {
      "workspaces":[
        {"name":"id","preferred_display":"display:uuid"},
        {"name":"cg","preferred_display":{"core_graphics_display_id":"2"}},
        {"name":"ns","preferred_display":{"ns_screen_number":"2"}},
        {"name":"name","preferred_display":{"name":"DELL C3422WE"}}
      ]
    }
    """#)
    let affinities = Dictionary(uniqueKeysWithValues: value.workspaces.map { ($0.name, $0.settings.preferredDisplay) })
    #expect(affinities["id"] == .init(id: "display:uuid"))
    #expect(affinities["cg"] == .init(coreGraphicsDisplayID: "2"))
    #expect(affinities["ns"] == .init(nsScreenNumber: "2"))
    #expect(affinities["name"] == .init(name: "DELL C3422WE"))
}

@Test func commentsInsideStringsArePreserved() throws {
    let value = try ConfigurationParser.parse(#"{"workspaces":[{"name":"https://example.test/*literal*/"}]}"#)
    #expect(value.workspaces.first?.name == "https://example.test/*literal*/")
}

@Test(arguments: [
    #"{"unknown":true}"#,
    #"{"defaults":{"unknown":true}}"#,
    #"{"workspaces":[{"name":"x","unknown":true}]}"#,
    #"{"workspaces":[{"name":"x","initial_assignment":[{"property":"title","operator":"exact","value":"x","unknown":true}]}]}"#,
    #"{"rules":[]}"#,
])
func rejectsUnknownFieldsAtEverySchemaLevel(source: String) {
    #expect(throws: ConfigurationError.self) { try ConfigurationParser.parse(source) }
}

@Test func parsesPerDisplayMarginAndGapOverrides() throws {
    let value = try ConfigurationParser.parse(#"""
    {
      "defaults":{"margin":{"top":1,"right":2,"bottom":3,"left":4},"gap":5},
      "displays":[
        {"display":{"core_graphics_display_id":"2"},"margin":{"top":20,"left":40},"gap":12}
      ]
    }
    """#)
    #expect(value.displays == [.init(
        display: .init(coreGraphicsDisplayID: "2"),
        margin: .init(top: 20, left: 40), gap: 12
    )])
}

@Test(arguments: [
    #"{"port":0}"#,
    #"{"defaults":{"gap":-1}}"#,
    #"{"defaults":{"margin":{"left":-1}}}"#,
    #"{"displays":[{"display":{"name":"A"},"gap":-1}]}"#,
    #"{"displays":[{"display":{"name":"A"},"margin":{"left":-1}}]}"#,
    #"{"displays":[{"display":{"name":"A"}},{"display":{"name":"A"}}]}"#,
    #"{"displays":[{"display":{"name":"A","ns_screen_number":"1"}}]}"#,
    #"{"workspaces":[{"name":"x"},{"name":"x"}]}"#,
    #"{"workspaces":[{"name":"x","initial_assignment":[{"property":"title","operator":"regex","value":"["}]}]}"#,
])
func rejectsSemanticErrors(source: String) {
    #expect(throws: Error.self) { try ConfigurationParser.parse(source) }
}

@Test func matcherSupportsPropertiesOperatorsCaseAndComposition() throws {
    let window = WindowDescriptor(bundleID: "com.Example.Editor", executablePath: "/Applications/Code.app/Code", processID: 42, title: "README.md", role: "AXWindow", subrole: "AXStandardWindow")
    let source = #"""
    {"workspaces":[{"name":"code","initial_assignment":[
      {"all":[
        {"property":"bundle_id","operator":"exact","value":"com.example.editor"},
        {"property":"executable_name","operator":"contains","value":"cod"},
        {"not":{"property":"title","operator":"regex","value":"^Settings$"}},
        {"any":[
          {"property":"process_id","operator":"exact","value":"42"},
          {"property":"role","operator":"exact","value":"other"}
        ]}
      ]}
    ]}]}
    """#
    let config = try ConfigurationParser.parse(source)
    #expect(config.initialWorkspace(for: window) == "code")
}

@Test func caseSensitivityAndMissingPropertiesDoNotMatch() throws {
    let source = #"""
    {"workspaces":[{"name":"ignored","initial_assignment":[
      {"property":"title","operator":"exact","value":"readme","case_sensitive":true},
      {"property":"subrole","operator":"contains","value":"dialog"}
    ]}]}
    """#
    let config = try ConfigurationParser.parse(source)
    #expect(config.initialWorkspace(for: .init(processID: 1, title: "README")) == nil)
}

@Test func firstMatchingWorkspaceWins() throws {
    let source = #"""
    {"workspaces":[
      {"name":"one","initial_assignment":[{"property":"title","operator":"contains","value":"term"}]},
      {"name":"two","initial_assignment":[{"property":"title","operator":"contains","value":"term"}]}
    ]}
    """#
    let workspace = try ConfigurationParser.parse(source).initialWorkspace(for: .init(processID: 1, title: "Terminal"))
    #expect(workspace == "one")
}

@Test func schemaDeclaresStrictRootAndDefaults() {
    #expect(ConfigurationParser.schema.contains(#""additionalProperties":false"#))
    #expect(ConfigurationParser.schema.contains(#""default":17832"#))
    #expect(ConfigurationParser.schema.contains(#""layout_policy""#))
    #expect(ConfigurationParser.schema.contains(#"["greedy","overlap","stack","overflow","reject"]"#))
    #expect(ConfigurationParser.schema.contains(#""max_geometry_retries""#))
    #expect(ConfigurationParser.schema.contains(#"["store","infer","optimistic"]"#))
}

@Test func reloadIsAtomicAndPreservesRuntimeOverlay() async throws {
    let store = ConfigurationStore()
    try await store.reload(source: basic)
    await store.setRuntimeOverlay(.init(workspaceSettings: ["main": .init(gap: 99)]))
    let before = await store.snapshot()
    do { try await store.reload(source: #"{"workspaces":[{"name":"broken","oops":true}]}"#) }
    catch {}
    let after = await store.snapshot()
    #expect(after.configuration == before.configuration)
    #expect(after.runtimeOverlay == before.runtimeOverlay)
    #expect(after.revision == before.revision)
    #expect(!after.degraded)
    #expect(after.events.last?.kind == .rejected)
}

@Test func hotloadDefaultsToDeltaDegradesAndValidReloadRecovers() async throws {
    let store = ConfigurationStore()
    do { try await store.reload(source: #"{"bad":true}"#, trigger: .hotload) } catch {}
    var state = await store.snapshot()
    #expect(state.degraded)
    #expect(state.events.last == .init(kind: .rejected, trigger: .hotload, mode: .delta, message: state.events.last?.message))
    try await store.reload(source: basic, trigger: .hotload)
    state = await store.snapshot()
    #expect(!state.degraded)
    #expect(state.events.last == .init(kind: .applied, trigger: .hotload, mode: .delta, message: nil))
}

@Test func explicitDefaultsToFullAndNoOpReloadKeepsRevision() async throws {
    let store = ConfigurationStore()
    let first = try await store.reload(source: basic)
    let second = try await store.reload(source: basic)
    #expect(first.revision == second.revision)
    #expect(second.events.last == .init(kind: .applied, trigger: .explicit, mode: .full, message: nil))
}

@Test func configPathUsesXDGAndFallsBackToHomeConfig() {
    #expect(ConfigurationFile.path(environment: ["XDG_CONFIG_HOME": "/tmp/xdg"]).path == "/tmp/xdg/wm/config.jsonc")
    #expect(ConfigurationFile.path(environment: ["HOME": "/tmp/home"]).path == "/tmp/home/.config/wm/config.jsonc")
    #expect(ConfigurationFile.path(environment: ["XDG_CONFIG_HOME": "relative", "HOME": "/tmp/home"]).path == "/tmp/home/.config/wm/config.jsonc")
}

@Test func exampleRoundTripsWithExplicitDefaults() throws {
    let source = try ConfigurationFile.example(displays: [
        .init(id: "display:12345678-abcd", name: "Studio Display")
    ])
    let value = try ConfigurationParser.parse(source)
    #expect(value == Configuration())
    #expect(source.contains(#""resize_increment": 10"#))
    #expect(source.contains(#""layout_policy": ["greedy", "overlap", "stack", "overflow"]"#))
    #expect(source.contains(#""max_geometry_retries": 5"#))
    #expect(source.contains(#""geometry_profile_mode": "store""#))
    #expect(source.contains(#""top": 0"#))
    #expect(source.contains(#""right": 0"#))
    #expect(source.contains(#""bottom": 0"#))
    #expect(source.contains(#""left": 0"#))
    #expect(source.contains("// Default layout settings inherited by every workspace."))
    #expect(source.contains("// Layout algorithm used unless a workspace overrides it."))
    #expect(source.contains("// Space between the display work area and tiled windows, in points."))
    #expect(source.contains("// Space along the top edge."))
    #expect(source.contains("// Space along the right edge."))
    #expect(source.contains("// Space along the bottom edge."))
    #expect(source.contains("// Space along the left edge."))
    #expect(source.contains("// Space between adjacent tiled windows, in points."))
    #expect(source.contains("// Keyboard resize step, in points."))
    #expect(source.contains("// Explicit workspace definitions, initial assignments, and per-workspace overrides."))
    #expect(source.contains("// New matching windows start here; manual moves remain authoritative."))
    #expect(source.contains(#"//   "initial_assignment": ["#))
    #expect(source.contains(#""property": "bundle_id", "operator": "exact""#))
    #expect(source.contains("// Per-display layout overrides"))
    #expect(source.contains("// Studio Display"))
    #expect(source.contains(#"//   "display": "display:12345678-abcd""#))
    #expect(source.contains(#"//   "margin": {"top": 0, "right": 0, "bottom": 0, "left": 0}"#))
    #expect(source.contains(#"//   "gap": 0"#))
    #expect(source.contains("// Reload this file automatically when it changes."))
    #expect(source.contains("// Local WebSocket API port used by the daemon."))
    #expect(source.hasSuffix("\n"))
}

@Test func initializationCreatesParentsAndNeverOverwrites() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("wm/config.jsonc")
    try ConfigurationFile.initialize(at: path)
    let initial = try String(contentsOf: path, encoding: .utf8)
    #expect(throws: ConfigurationError.self) { try ConfigurationFile.initialize(at: path) }
    #expect(try String(contentsOf: path, encoding: .utf8) == initial)
}

@Test func adoptionPreservesSettingsAndReplacesConflictingExecutableAssignments() throws {
    let original = try ConfigurationParser.parse(#"""
    {
      "defaults": {"gap": 8},
      "workspaces": [
        {"name":"Compound","initial_assignment":[{"any":[{"property":"executable_name","operator":"exact","value":"Ghostty"},{"property":"title","operator":"contains","value":"term"}]}]},
        {"name":"T","mode":"floating","preferred_display":"old","initial_assignment":[{"property":"role","operator":"exact","value":"AXWindow"}]},
        {"name":"Other","gap":3,"initial_assignment":[{"property":"title","operator":"contains","value":"docs"}]},
        {"name":"ExactPath","initial_assignment":[{"property":"executable_path","operator":"exact","value":"/bin/Ghostty"}]}
      ]
    }
    """#)
    let adopted = ConfigurationFile.adopt(
        original,
        workspaceDisplays: ["T": "display:2", "New": "display:1"],
        windows: [.init(executableName: "Ghostty", workspace: "T")]
    )
    #expect(adopted.defaults.gap == 8)
    #expect(adopted.workspaces.first(where: { $0.name == "T" })?.settings == .init(preferredDisplay: .init(id: "display:2"), mode: .floating))
    #expect(adopted.workspaces.first(where: { $0.name == "Other" })?.settings.gap == 3)
    #expect(adopted.workspaces.first(where: { $0.name == "New" })?.settings.preferredDisplay == .init(id: "display:1"))
    #expect(adopted.initialWorkspace(for: .init(executablePath: "/bin/Ghostty", processID: 1)) == "T")
    #expect(adopted.initialWorkspace(for: .init(processID: 2, title: "docs")) == "Other")
    #expect(adopted.workspaces.first(where: { $0.name == "Compound" })?.initialAssignment.count == 1)
    #expect(adopted.workspaces.first(where: { $0.name == "T" })?.initialAssignment.contains(
        .value(property: .role, operator: .exact, value: "AXWindow", caseSensitive: false)
    ) == true)
    #expect(adopted.workspaces.first(where: { $0.name == "ExactPath" })?.initialAssignment.isEmpty == true)
    #expect(try ConfigurationParser.parse(ConfigurationFile.encode(adopted)) == adopted)
}

@Test func watcherKeepsObservingWhenHotloadIsDisabledAndReenablesLater() async throws {
    let watcher = ConfigurationWatcher()
    let applied = AppliedConfigurations()
    let disabled = #"{"hotload":false,"defaults":{"gap":4}}"#
    try await watcher.poll(path: URL(fileURLWithPath: "/ignored"), read: { _ in disabled }) { value, _ in
        await applied.record(value)
    }
    #expect(await applied.values.isEmpty)
    let enabled = #"{"hotload":true,"defaults":{"gap":9}}"#
    try await watcher.poll(path: URL(fileURLWithPath: "/ignored"), read: { _ in enabled }) { value, _ in
        await applied.record(value)
    }
    #expect(await applied.values.map(\.defaults.gap) == [9])
}

@Test func watcherRetriesSameContentsAfterApplyFailure() async throws {
    let watcher = ConfigurationWatcher()
    let attempts = ApplyAttempts()
    let source = #"{"hotload":true,"defaults":{"gap":9}}"#
    do {
        try await watcher.poll(path: URL(fileURLWithPath: "/ignored"), read: { _ in source }) { _, _ in
            await attempts.record()
            throw ConfigurationError.invalid("transient")
        }
    } catch {}
    try await watcher.poll(path: URL(fileURLWithPath: "/ignored"), read: { _ in source }) { _, _ in
        await attempts.record()
    }
    #expect(await attempts.count == 2)
}

private actor AppliedConfigurations {
    private(set) var values: [Configuration] = []
    func record(_ value: Configuration) { values.append(value) }
}

private actor ApplyAttempts {
    private(set) var count = 0
    func record() { count += 1 }
}
