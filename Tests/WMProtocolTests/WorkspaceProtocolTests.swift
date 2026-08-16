import Foundation
import Testing
@testable import WMProtocol

private let workspace = WorkspaceState(
    name: "T", origin: .runtime, displayId: "display:uuid", visible: true, focused: true,
    mode: .bsp, margin: .init(top: 0, right: 0, bottom: 0, left: 0), gap: 8,
    resizeIncrement: 0.05, windowIds: ["window:1", "window:2"], focusedWindowId: "window:2",
    bsp: .init(root: .split(
        axis: .vertical, ratio: 0.5, first: .leaf(windowId: "window:1"),
        second: .leaf(windowId: "window:2")
    ))
)

@Test func workspaceDTOsUseCanonicalWireShape() throws {
    let data = try ProtocolCodec.encode(workspace)
    let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(json["display_id"] as? String == "display:uuid")
    #expect(json["preferred_display_id"] is NSNull)
    #expect(json["resize_increment"] as? Double == 0.05)
    let bsp = try #require(json["bsp"] as? [String: Any])
    let root = try #require(bsp["root"] as? [String: Any])
    #expect(root["type"] as? String == "split")
    #expect((root["second"] as? [String: Any])?["window_id"] as? String == "window:2")
    #expect(try ProtocolCodec.decode(WorkspaceState.self, from: data) == workspace)
}

@Test func workspaceParamsAndResultsRoundTrip() throws {
    #expect(throws: Never.self) { try ProtocolCodec.encode(WorkspaceListParams()) }
    #expect(throws: Never.self) { try ProtocolCodec.encode(WorkspaceMoveWindowParams(windowIds: [], workspace: "T")) }
    #expect(throws: Never.self) { try ProtocolCodec.encode(WorkspaceMoveDisplayParams(workspace: "T", displayId: "display:uuid")) }
    #expect(throws: Never.self) { try ProtocolCodec.encode(WorkspaceSetModeParams(workspace: "T", mode: .floating)) }
    #expect(throws: Never.self) { try ProtocolCodec.encode(UncooperativeWindowPolicySetParams(policy: .overlap, workspace: "T")) }
    let policy = GeometryPolicySetParams(workspace: "T", maxGeometryRetries: 5, geometryProfileMode: .optimistic)
    #expect(try ProtocolCodec.decode(GeometryPolicySetParams.self, from: ProtocolCodec.encode(policy)) == policy)
    #expect(throws: Never.self) { try ProtocolCodec.encode(WorkspaceListResult(workspaces: [workspace], focusedWorkspaceName: "T")) }
    #expect(throws: Never.self) {
        try ProtocolCodec.encode(WorkspaceMutationResult(
            workspaceState: workspace, modifiedWorkspaces: ["T"], deletedWorkspaces: [], effectStatus: .simulated
        ))
    }

    let focusJSON = try #require(String(data: ProtocolCodec.encode(WorkspaceFocusParams(name: "T")), encoding: .utf8))
    #expect(focusJSON == #"{"display_id":null,"name":"T"}"#)
}

@Test func workspaceProtocolEnumsExposeDocumentedValues() {
    #expect(Method.workspaceList.rawValue == "workspace.list")
    #expect(Method.workspaceFocus.rawValue == "workspace.focus")
    #expect(Method.workspaceMoveWindow.rawValue == "workspace.move_window")
    #expect(Method.workspaceMoveDisplay.rawValue == "workspace.move_display")
    #expect(Method.workspaceSetMode.rawValue == "workspace.set_mode")
    #expect(Method.uncooperativeWindowPolicySet.rawValue == "uncooperative_window_policy.set")
    #expect(Method.geometryPolicySet.rawValue == "geometry_policy.set")
    #expect(Method.observeWorkspace.rawValue == "observe.workspace")
    #expect(EventTopic.workspaceDisplayChanged.rawValue == "workspace.display_changed")
    #expect(EventTopic.workspaceModeChanged.rawValue == "workspace.mode_changed")
    #expect(EventTopic.stateSnapshot.rawValue == "state.snapshot")
    #expect(EventTopic.daemonPaused.rawValue == "daemon.paused")
    #expect(EventTopic.daemonResumed.rawValue == "daemon.resumed")
    #expect(EventTopic.sessionResynchronized.rawValue == "session.resynchronized")
    #expect(ErrorCode.workspaceNotFound.rawValue == "workspace_not_found")
    #expect(ErrorCode.displayNotFound.rawValue == "display_not_found")
}
