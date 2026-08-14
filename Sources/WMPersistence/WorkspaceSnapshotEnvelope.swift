import Foundation

public struct WorkspaceSnapshotEnvelope<State: Codable & Sendable>: Codable, Sendable {
    public var snapshotVersion: UInt64
    public var buildVersion: String
    public var state: State

    public init(snapshotVersion: UInt64, buildVersion: String, state: State) {
        self.snapshotVersion = snapshotVersion
        self.buildVersion = buildVersion
        self.state = state
    }

    enum CodingKeys: String, CodingKey {
        case snapshotVersion = "snapshot_version"
        case buildVersion = "build_version"
        case state
    }
}

extension WorkspaceSnapshotEnvelope: Equatable where State: Equatable {}
