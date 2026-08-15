import Foundation
import Testing
@testable import WMConfiguration

private let basic = #"{"workspaces":[{"name":"main"}]}"#

@Test func parsesJSONCAndAppliesDefaultsFieldByField() throws {
    let value = try ConfigurationParser.parse(#"""
    {
      // global layout
      "defaults": { "mode": "floating", "margin": {"top":12,"right":12,"bottom":12,"left":12}, "gap": 7, "resize_increment": 4 },
      "workspaces": [
        { "name": "code", "gap": 2 }, /* local override */
        { "name": "web", "preferred_display": "external" }
      ]
    }
    """#)
    #expect(value.hotload)
    #expect(value.port == 17_832)
    let margin = WorkspaceMargins(top: 12, right: 12, bottom: 12, left: 12)
    #expect(value.resolvedWorkspaces[0].settings == .init(mode: .floating, margin: margin, gap: 2, resizeIncrement: 4))
    #expect(value.resolvedWorkspaces[1].settings == .init(preferredDisplay: .init(id: "external"), mode: .floating, margin: margin, gap: 7, resizeIncrement: 4))
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
    #"{"rules":[{"match":{"property":"title","operator":"exact","value":"x","unknown":true},"actions":{}}]}"#,
    #"{"rules":[{"match":{"property":"title","operator":"exact","value":"x"},"actions":{"unknown":true}}]}"#,
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
    #"{"rules":[{"match":{"property":"title","operator":"regex","value":"["},"actions":{}}]}"#,
])
func rejectsSemanticErrors(source: String) {
    #expect(throws: Error.self) { try ConfigurationParser.parse(source) }
}

@Test func matcherSupportsPropertiesOperatorsCaseAndComposition() throws {
    let window = WindowDescriptor(bundleID: "com.Example.Editor", executablePath: "/Applications/Code.app/Code", processID: 42, title: "README.md", role: "AXWindow", subrole: "AXStandardWindow")
    let source = #"""
    {"rules":[
      {"match":{"all":[
        {"property":"bundle_id","operator":"exact","value":"com.example.editor"},
        {"property":"executable_name","operator":"contains","value":"cod"},
        {"not":{"property":"title","operator":"regex","value":"^Settings$"}},
        {"any":[
          {"property":"process_id","operator":"exact","value":"42"},
          {"property":"role","operator":"exact","value":"other"}
        ]}
      ]},"actions":{"workspace":"code","behavior":"tiled"}}
    ]}
    """#
    let config = try ConfigurationParser.parse(source)
    #expect(config.actions(for: window) == .init(workspace: "code", behavior: .tiled))
}

@Test func caseSensitivityAndMissingPropertiesDoNotMatch() throws {
    let source = #"""
    {"rules":[
      {"match":{"property":"title","operator":"exact","value":"readme","case_sensitive":true},"actions":{"manage":false}},
      {"match":{"property":"subrole","operator":"contains","value":"dialog"},"actions":{"manage":false}}
    ]}
    """#
    let config = try ConfigurationParser.parse(source)
    #expect(config.actions(for: .init(processID: 1, title: "README")) == nil)
}

@Test func firstMatchingRuleWinsWithCompleteInitialActions() throws {
    let source = #"""
    {"rules":[
      {"match":{"property":"title","operator":"contains","value":"term"},"actions":{"manage":false,"workspace":"one","behavior":"floating","floating_geometry":"centered","resistant_fallback":"ignore","workspace_mode":"floating"}},
      {"match":{"property":"title","operator":"contains","value":"term"},"actions":{"workspace":"two"}}
    ]}
    """#
    let actions = try ConfigurationParser.parse(source).actions(for: .init(processID: 1, title: "Terminal"))
    #expect(actions == .init(manage: false, workspace: "one", behavior: .floating, floatingGeometry: "centered", resistantFallback: .ignore, workspaceMode: .floating))
}

@Test func schemaDeclaresStrictRootAndDefaults() {
    #expect(ConfigurationParser.schema.contains(#""additionalProperties":false"#))
    #expect(ConfigurationParser.schema.contains(#""default":17832"#))
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
    #expect(source.contains("// Explicit workspace definitions and per-workspace overrides."))
    #expect(source.contains("// Per-display layout overrides"))
    #expect(source.contains("// Studio Display"))
    #expect(source.contains(#"//   "display": "display:12345678-abcd""#))
    #expect(source.contains(#"//   "margin": {"top": 0, "right": 0, "bottom": 0, "left": 0}"#))
    #expect(source.contains(#"//   "gap": 0"#))
    #expect(source.contains("// First-match window rules for assignment and behavior."))
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

@Test func adoptionPreservesSettingsAndReplacesConflictingExecutableRules() throws {
    let original = try ConfigurationParser.parse(#"""
    {
      "defaults": {"gap": 8},
      "workspaces": [
        {"name":"T","mode":"floating","preferred_display":"old"},
        {"name":"Other","gap":3}
      ],
      "rules": [
        {"match":{"property":"executable_name","operator":"exact","value":"Ghostty"},"actions":{"workspace":"GhosttyOnly","behavior":"floating"}},
        {"match":{"property":"title","operator":"contains","value":"docs"},"actions":{"workspace":"Docs"}},
        {"match":{"any":[{"property":"executable_name","operator":"exact","value":"Ghostty"},{"property":"title","operator":"contains","value":"term"}]},"actions":{"workspace":"Compound"}}
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
    #expect(adopted.rules.count == 3)
    #expect(adopted.actions(for: .init(executablePath: "/bin/Ghostty", processID: 1))?.workspace == "T")
    #expect(adopted.actions(for: .init(processID: 2, title: "docs"))?.workspace == "Docs")
    #expect(adopted.rules.contains { $0.actions.workspace == "Compound" })
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
