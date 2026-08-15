import Foundation
import Testing
@testable import WMConfiguration

private let basic = #"{"workspaces":[{"name":"main"}]}"#

@Test func parsesJSONCAndAppliesDefaultsFieldByField() throws {
    let value = try ConfigurationParser.parse(#"""
    {
      // global layout
      "defaults": { "mode": "floating", "margin": 12, "gap": 7, "resize_increment": 4 },
      "workspaces": [
        { "name": "code", "gap": 2 }, /* local override */
        { "name": "web", "preferred_display": "external" }
      ]
    }
    """#)
    #expect(value.hotload)
    #expect(value.port == 17_832)
    #expect(value.resolvedWorkspaces[0].settings == .init(mode: .floating, margin: 12, gap: 2, resizeIncrement: 4))
    #expect(value.resolvedWorkspaces[1].settings == .init(preferredDisplay: "external", mode: .floating, margin: 12, gap: 7, resizeIncrement: 4))
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

@Test(arguments: [
    #"{"port":0}"#,
    #"{"defaults":{"gap":-1}}"#,
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
