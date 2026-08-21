import Foundation
import XCTest
import WMDiagnostics
@testable import WMPersistence

final class DiagnosticStoreTests: XCTestCase {
  func testRoundTripAndGenerationAwareRemoval() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("wm-diagnostics-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = DiagnosticStore(url: directory.appendingPathComponent("diagnostics.json"))
    let key = DiagnosticKey(id: "parking-limits", revision: 1, fingerprint: "test")
    let resolved = ResolvedDiagnostic(value: 52, provenance: .init(key: key))
    try store.save(DiagnosticRecord(resolved))

    XCTAssertEqual(try store.load(key: key)?.resolve(Int.self).value, 52)
    try store.remove(key: key, generation: UUID())
    XCTAssertNotNil(try store.load(key: key))
    try store.remove(key: key, generation: resolved.provenance.generation)
    XCTAssertNil(try store.load(key: key))
  }

  func testCorruptAndUnsupportedCatalogsAreCacheMisses() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("wm-diagnostics-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("diagnostics.json")
    let store = DiagnosticStore(url: url)
    let key = DiagnosticKey(id: "parking-limits", revision: 1, fingerprint: "test")
    try Data("not-json".utf8).write(to: url)
    XCTAssertNil(try store.load(key: key))
    try Data(#"{"schemaVersion":999,"records":[]}"#.utf8).write(to: url)
    XCTAssertNil(try store.load(key: key))
  }
}
