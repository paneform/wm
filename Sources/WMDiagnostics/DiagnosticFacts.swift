import Foundation

public struct DiagnosticKey: Codable, Hashable, Sendable {
  public var id: String
  public var revision: Int
  public var fingerprint: String

  public init(id: String, revision: Int, fingerprint: String) {
    self.id = id
    self.revision = revision
    self.fingerprint = fingerprint
  }
}

public struct DiagnosticProvenance: Codable, Equatable, Sendable {
  public var key: DiagnosticKey
  public var generation: UUID
  public var measuredAt: Date

  public init(key: DiagnosticKey, generation: UUID = UUID(), measuredAt: Date = Date()) {
    self.key = key
    self.generation = generation
    self.measuredAt = measuredAt
  }
}

public struct ResolvedDiagnostic<Value: Codable & Sendable>: Codable, Sendable {
  public var value: Value
  public var provenance: DiagnosticProvenance

  public init(value: Value, provenance: DiagnosticProvenance) {
    self.value = value
    self.provenance = provenance
  }
}

public struct DiagnosticRecord: Codable, Sendable {
  public var provenance: DiagnosticProvenance
  public var payload: Data

  public init<Value>(_ resolved: ResolvedDiagnostic<Value>, encoder: JSONEncoder = JSONEncoder()) throws {
    provenance = resolved.provenance
    payload = try encoder.encode(resolved.value)
  }

  public func resolve<Value>(_ type: Value.Type, decoder: JSONDecoder = JSONDecoder()) throws
    -> ResolvedDiagnostic<Value>
  {
    .init(value: try decoder.decode(type, from: payload), provenance: provenance)
  }
}

public protocol DiagnosticRecordPersisting: Sendable {
  func load(key: DiagnosticKey) throws -> DiagnosticRecord?
  func save(_ record: DiagnosticRecord) throws
  func remove(key: DiagnosticKey, generation: UUID?) throws
}

public actor DiagnosticCoordinator {
  private let persistence: any DiagnosticRecordPersisting
  private struct Flight: Sendable {
    let id: UUID
    let task: Task<DiagnosticRecord, Error>
  }
  private var inFlight: [DiagnosticKey: Flight] = [:]

  public init(persistence: any DiagnosticRecordPersisting) { self.persistence = persistence }

  public func resolve<Value: Codable & Sendable>(
    key: DiagnosticKey,
    run: @escaping @Sendable () async throws -> Value
  ) async throws -> ResolvedDiagnostic<Value> {
    if let stored = try persistence.load(key: key) { return try stored.resolve(Value.self) }
    if let flight = inFlight[key] { return try await flight.task.value.resolve(Value.self) }
    let persistence = persistence
    let id = UUID()
    let task = Task {
      try Task.checkCancellation()
      let resolved = ResolvedDiagnostic(
        value: try await run(), provenance: DiagnosticProvenance(key: key))
      try Task.checkCancellation()
      let record = try DiagnosticRecord(resolved)
      try persistence.save(record)
      return record
    }
    inFlight[key] = Flight(id: id, task: task)
    defer {
      if inFlight[key]?.id == id { inFlight[key] = nil }
    }
    return try await task.value.resolve(Value.self)
  }

  public func invalidate(_ provenance: DiagnosticProvenance) async throws {
    inFlight[provenance.key]?.task.cancel()
    if let flight = inFlight[provenance.key] {
      _ = await flight.task.result
      if inFlight[provenance.key]?.id == flight.id { inFlight[provenance.key] = nil }
    }
    try persistence.remove(key: provenance.key, generation: provenance.generation)
  }

  public func cancel(key: DiagnosticKey) async {
    guard let flight = inFlight[key] else { return }
    flight.task.cancel()
    _ = await flight.task.result
    if inFlight[key]?.id == flight.id { inFlight[key] = nil }
  }
}
