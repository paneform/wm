import Foundation
import WMProtocol

public enum WorkspaceStateLoad<State: Sendable>: Sendable {
    case absent
    case loaded(State)
    case quarantined(URL)
}

public enum WorkspaceStateStoreError: Error, Equatable, Sendable {
    case unsupportedSnapshotVersion(expected: UInt64, actual: UInt64)
    case incompatibleBuildVersion(expected: String, actual: String)
}

public struct WorkspaceStateStore<State: Codable & Sendable>: Sendable {
    public static var currentSnapshotVersion: UInt64 { 1 }

    public let stateURL: URL
    public let buildVersion: String
    private let fileSystem: any WorkspaceStateFileSystem
    private let validate: @Sendable (State) throws -> Void
    private let quarantineSuffix: @Sendable () -> String

    public init(
        stateURL: URL = WorkspaceStatePath.resolve(),
        buildVersion: String,
        fileSystem: any WorkspaceStateFileSystem = LocalWorkspaceStateFileSystem(),
        validate: @escaping @Sendable (State) throws -> Void,
        quarantineSuffix: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.stateURL = stateURL
        self.buildVersion = buildVersion
        self.fileSystem = fileSystem
        self.validate = validate
        self.quarantineSuffix = quarantineSuffix
    }

    public func load() throws -> WorkspaceStateLoad<State> {
        guard fileSystem.fileExists(at: stateURL) else { return .absent }
        do {
            let envelope = try ProtocolCodec.decode(
                WorkspaceSnapshotEnvelope<State>.self,
                from: fileSystem.read(at: stateURL)
            )
            guard envelope.snapshotVersion == Self.currentSnapshotVersion else {
                throw WorkspaceStateStoreError.unsupportedSnapshotVersion(
                    expected: Self.currentSnapshotVersion,
                    actual: envelope.snapshotVersion
                )
            }
            guard envelope.buildVersion == buildVersion else {
                throw WorkspaceStateStoreError.incompatibleBuildVersion(
                    expected: buildVersion,
                    actual: envelope.buildVersion
                )
            }
            try validate(envelope.state)
            return .loaded(envelope.state)
        } catch {
            let quarantineURL = stateURL
                .deletingLastPathComponent()
                .appendingPathComponent("state.corrupt.\(quarantineSuffix()).json")
            try fileSystem.rename(stateURL, to: quarantineURL)
            return .quarantined(quarantineURL)
        }
    }

    public func save(_ state: State) throws {
        try validate(state)
        let envelope = WorkspaceSnapshotEnvelope(
            snapshotVersion: Self.currentSnapshotVersion,
            buildVersion: buildVersion,
            state: state
        )
        let data = try ProtocolCodec.encode(envelope)
        let directory = stateURL.deletingLastPathComponent()
        try fileSystem.createDirectory(at: directory)
        let temporaryURL = directory.appendingPathComponent(".state.\(UUID().uuidString).tmp")
        try fileSystem.writeAndSynchronize(data, to: temporaryURL)
        try fileSystem.rename(temporaryURL, to: stateURL)
    }
}
