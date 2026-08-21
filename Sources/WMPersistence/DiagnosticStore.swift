import Foundation
import WMDiagnostics

public enum DiagnosticStorePath {
  public static func resolve(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) -> URL {
    WorkspaceStatePath.resolve(environment: environment, homeDirectory: homeDirectory)
      .deletingLastPathComponent().appendingPathComponent("diagnostics.json")
  }
}

public final class DiagnosticStore: DiagnosticRecordPersisting, @unchecked Sendable {
  private struct Catalog: Codable { var schemaVersion = 1; var records: [DiagnosticRecord] = [] }
  private static let schemaVersion = 1
  private static let maximumRecords = 128
  private static let maximumPayloadBytes = 256 * 1024
  private static let maximumCatalogBytes = 2 * 1024 * 1024
  public let url: URL
  private let fileSystem: any WorkspaceStateFileSystem
  private let lock = NSLock()

  public init(
    url: URL = DiagnosticStorePath.resolve(),
    fileSystem: any WorkspaceStateFileSystem = LocalWorkspaceStateFileSystem()
  ) {
    self.url = url
    self.fileSystem = fileSystem
  }

  public func load(key: DiagnosticKey) throws -> DiagnosticRecord? {
    try lock.withLock { try catalog().records.first { $0.provenance.key == key } }
  }

  public func save(_ record: DiagnosticRecord) throws {
    guard record.payload.count <= Self.maximumPayloadBytes else { return }
    try lock.withLock {
      var catalog = try catalog()
      catalog.records.removeAll { $0.provenance.key == record.provenance.key }
      catalog.records.append(record)
      catalog.records.sort { $0.provenance.measuredAt > $1.provenance.measuredAt }
      if catalog.records.count > Self.maximumRecords {
        catalog.records.removeLast(catalog.records.count - Self.maximumRecords)
      }
      try write(catalog)
    }
  }

  public func remove(key: DiagnosticKey, generation: UUID?) throws {
    try lock.withLock {
      var catalog = try catalog()
      catalog.records.removeAll {
        $0.provenance.key == key && (generation == nil || $0.provenance.generation == generation)
      }
      try write(catalog)
    }
  }

  private func catalog() throws -> Catalog {
    guard fileSystem.fileExists(at: url) else { return .init() }
    let data = try fileSystem.read(at: url)
    guard data.count <= Self.maximumCatalogBytes else { return .init() }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    guard let catalog = try? decoder.decode(Catalog.self, from: data),
      catalog.schemaVersion == Self.schemaVersion
    else { return .init() }
    return catalog
  }

  private func write(_ catalog: Catalog) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    encoder.dateEncodingStrategy = .iso8601
    let directory = url.deletingLastPathComponent()
    try fileSystem.createDirectory(at: directory)
    let temporary = directory.appendingPathComponent(".diagnostics.\(UUID().uuidString).tmp")
    try fileSystem.writeAndSynchronize(try encoder.encode(catalog), to: temporary)
    try fileSystem.rename(temporary, to: url)
  }
}
