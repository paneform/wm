import XCTest
@testable import WMDiagnostics

final class DiagnosticFactsTests: XCTestCase {
  func testResolveCachesAndInvalidationUsesGeneration() async throws {
    let store = MemoryStore()
    let coordinator = DiagnosticCoordinator(persistence: store)
    let key = DiagnosticKey(id: "example", revision: 1, fingerprint: "environment")
    let first: ResolvedDiagnostic<Int> = try await coordinator.resolve(key: key) { 7 }
    let cached: ResolvedDiagnostic<Int> = try await coordinator.resolve(key: key) { 8 }
    XCTAssertEqual(cached.value, 7)
    XCTAssertEqual(cached.provenance.generation, first.provenance.generation)
    try await coordinator.invalidate(first.provenance)
    let refreshed: ResolvedDiagnostic<Int> = try await coordinator.resolve(key: key) { 8 }
    XCTAssertEqual(refreshed.value, 8)
    XCTAssertNotEqual(refreshed.provenance.generation, first.provenance.generation)
  }

  func testInvalidationCancelsInFlightAndDoesNotDeleteReplacement() async throws {
    let store = MemoryStore()
    let coordinator = DiagnosticCoordinator(persistence: store)
    let key = DiagnosticKey(id: "example", revision: 1, fingerprint: "environment")
    let gate = Gate()
    let first = Task {
      try await coordinator.resolve(key: key) {
        try await gate.wait()
        return 1
      } as ResolvedDiagnostic<Int>
    }
    await gate.waitUntilEntered()
    let stale = DiagnosticProvenance(key: key)
    try await coordinator.invalidate(stale)
    await gate.release()
    _ = await first.result
    let replacement: ResolvedDiagnostic<Int> = try await coordinator.resolve(key: key) { 2 }
    try await coordinator.invalidate(stale)
    let cached: ResolvedDiagnostic<Int> = try await coordinator.resolve(key: key) { 3 }
    XCTAssertEqual(cached.value, 2)
    XCTAssertEqual(cached.provenance.generation, replacement.provenance.generation)
  }
}

private actor Gate {
  private var entered = false
  private var continuation: CheckedContinuation<Void, Error>?
  func wait() async throws {
    entered = true
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation = $0 }
    } onCancel: { Task { await self.cancel() } }
  }
  func waitUntilEntered() async { while !entered { await Task.yield() } }
  func release() { continuation?.resume(); continuation = nil }
  private func cancel() { continuation?.resume(throwing: CancellationError()); continuation = nil }
}

private final class MemoryStore: DiagnosticRecordPersisting, @unchecked Sendable {
  private let lock = NSLock()
  private var records: [DiagnosticKey: DiagnosticRecord] = [:]
  func load(key: DiagnosticKey) -> DiagnosticRecord? { lock.withLock { records[key] } }
  func save(_ record: DiagnosticRecord) { lock.withLock { records[record.provenance.key] = record } }
  func remove(key: DiagnosticKey, generation: UUID?) {
    lock.withLock {
      guard generation == nil || records[key]?.provenance.generation == generation else { return }
      records[key] = nil
    }
  }
}
