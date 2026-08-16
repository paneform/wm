import Foundation
import WMInventory

public enum WindowGeometryProfilePath {
    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        WorkspaceStatePath.resolve(environment: environment, homeDirectory: homeDirectory)
            .deletingLastPathComponent().appendingPathComponent("geometry-profiles.json")
    }
}

public final class WindowGeometryProfileStore: WindowGeometryProfilePersisting, @unchecked Sendable {
    public let url: URL
    private let fileSystem: any WorkspaceStateFileSystem
    private let lock = NSLock()

    public init(
        url: URL = WindowGeometryProfilePath.resolve(),
        fileSystem: any WorkspaceStateFileSystem = LocalWorkspaceStateFileSystem()
    ) {
        self.url = url
        self.fileSystem = fileSystem
    }

    public func load() throws -> WindowGeometryProfileCatalog {
        guard fileSystem.fileExists(at: url) else { return .init() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(WindowGeometryProfileCatalog.self, from: fileSystem.read(at: url))
    }

    public func save(_ catalog: WindowGeometryProfileCatalog) throws {
        try lock.withLock {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(catalog)
            let directory = url.deletingLastPathComponent()
            try fileSystem.createDirectory(at: directory)
            let temporary = directory.appendingPathComponent(".geometry-profiles.\(UUID().uuidString).tmp")
            try fileSystem.writeAndSynchronize(data, to: temporary)
            try fileSystem.rename(temporary, to: url)
        }
    }
}
