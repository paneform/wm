import Foundation
import WMDiagnostics
import WMInventory

enum ParkingDiagnosticError: Error {
  case missingDiagnosis
  case noProbeWindow
  case restorationFailed
}

protocol ParkingDiagnosticProviding: Sendable {
  func resolve(_ inventory: InventorySnapshot) async throws -> ResolvedDiagnostic<ParkingLimits>
  func invalidate(_ provenance: DiagnosticProvenance) async throws
}

final class TransientDiagnosticStore: DiagnosticRecordPersisting, @unchecked Sendable {
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
