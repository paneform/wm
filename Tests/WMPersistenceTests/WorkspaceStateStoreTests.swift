import Foundation
import XCTest
import WMLifecycle
@testable import WMPersistence

final class WorkspaceStateStoreTests: XCTestCase {
    func testDaemonLockIsExclusiveAndReacquirableAfterRelease() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let url = directory.appendingPathComponent("daemon.lock")
        var first: DaemonProcessLock? = try DaemonProcessLock(url: url)
        XCTAssertNotNil(first)
        XCTAssertTrue(first?.isCloseOnExec == true)
        XCTAssertThrowsError(try DaemonProcessLock(url: url)) { error in
            XCTAssertEqual(error as? DaemonProcessLockError, .alreadyRunning)
        }
        first = nil
        XCTAssertNoThrow(try DaemonProcessLock(url: url))
        try? FileManager.default.removeItem(at: directory)
    }

    func testDaemonLockRejectsSymlinkAndUnsafeDirectoryMode() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = directory.appendingPathComponent("target")
        FileManager.default.createFile(atPath: target.path, contents: Data())
        let lock = directory.appendingPathComponent("daemon.lock")
        try FileManager.default.createSymbolicLink(at: lock, withDestinationURL: target)
        XCTAssertThrowsError(try DaemonProcessLock(url: lock))
        try FileManager.default.removeItem(at: lock)
        try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: directory.path)
        XCTAssertThrowsError(try DaemonProcessLock(url: lock)) { error in
            XCTAssertEqual(error as? DaemonProcessLockError, .unsafePath)
        }
        try? FileManager.default.removeItem(at: directory)
    }

    func testRelativeXDGStateHomeFallsBackToUserStateDirectory() {
        let result = WorkspaceStatePath.resolve(
            environment: ["XDG_STATE_HOME": "relative"],
            homeDirectory: URL(fileURLWithPath: "/home/test")
        )
        XCTAssertEqual(result.path, "/home/test/.local/state/wm/state.json")
    }

    func testPathUsesXDGStateHome() {
        let url = WorkspaceStatePath.resolve(
            environment: ["XDG_STATE_HOME": "/state"],
            homeDirectory: URL(fileURLWithPath: "/home/test")
        )
        XCTAssertEqual(url.path, "/state/wm/state.json")
    }

    func testPathFallsBackToLocalState() {
        let url = WorkspaceStatePath.resolve(
            environment: [:],
            homeDirectory: URL(fileURLWithPath: "/home/test")
        )
        XCTAssertEqual(url.path, "/home/test/.local/state/wm/state.json")
    }

    func testAbsentLoadDoesNotMutateFileSystem() throws {
        let fileSystem = MemoryFileSystem()
        let result = try makeStore(fileSystem: fileSystem).load()
        guard case .absent = result else { return XCTFail("Expected absent state") }
        XCTAssertTrue(fileSystem.operations.isEmpty)
    }

    func testSaveFsyncsTemporaryFileThenAtomicallyRenames() throws {
        let fileSystem = MemoryFileSystem()
        let store = makeStore(fileSystem: fileSystem)

        try store.save(TestState(stateVersion: 7, names: ["T"]))

        XCTAssertEqual(fileSystem.operations.first, "mkdir:/state/wm")
        XCTAssertTrue(fileSystem.operations[1].hasPrefix("write-sync:/state/wm/.state."))
        XCTAssertTrue(fileSystem.operations[2].hasPrefix("rename:/state/wm/.state."))
        XCTAssertTrue(fileSystem.operations[2].hasSuffix("->/state/wm/state.json"))
        let envelope = try JSONDecoder().decode(
            WorkspaceSnapshotEnvelope<TestState>.self,
            from: try XCTUnwrap(fileSystem.files["/state/wm/state.json"])
        )
        XCTAssertEqual(envelope.snapshotVersion, 1)
        XCTAssertEqual(envelope.buildVersion, "test-build")
        XCTAssertEqual(envelope.state.stateVersion, 7)
    }

    func testRoundTripLoadsIdentically() throws {
        let fileSystem = MemoryFileSystem()
        let store = makeStore(fileSystem: fileSystem)
        let state = TestState(stateVersion: 3, names: ["A", "B"])
        try store.save(state)

        guard case let .loaded(loaded) = try store.load() else {
            return XCTFail("Expected loaded state")
        }
        XCTAssertEqual(loaded, state)
    }

    func testDecodeFailureQuarantinesWholeSnapshot() throws {
        let fileSystem = MemoryFileSystem(files: ["/state/wm/state.json": Data("not json".utf8)])
        let result = try makeStore(fileSystem: fileSystem).load()

        guard case let .quarantined(url) = result else { return XCTFail("Expected quarantine") }
        XCTAssertEqual(url.path, "/state/wm/state.corrupt.fixed.json")
        XCTAssertNil(fileSystem.files["/state/wm/state.json"])
        XCTAssertNotNil(fileSystem.files[url.path])
    }

    func testValidationFailureQuarantinesWholeSnapshot() throws {
        let fileSystem = MemoryFileSystem()
        let invalid = WorkspaceSnapshotEnvelope(
            snapshotVersion: 1,
            buildVersion: "test-build",
            state: TestState(stateVersion: 0, names: ["duplicate", "duplicate"])
        )
        fileSystem.files["/state/wm/state.json"] = try JSONEncoder().encode(invalid)

        guard case .quarantined = try makeStore(fileSystem: fileSystem).load() else {
            return XCTFail("Expected quarantine")
        }
    }

    func testFailedRenamePreservesPreviousSnapshot() throws {
        let old = Data("old".utf8)
        let fileSystem = MemoryFileSystem(files: ["/state/wm/state.json": old])
        fileSystem.failDestinationRename = true

        XCTAssertThrowsError(try makeStore(fileSystem: fileSystem).save(.init(stateVersion: 2, names: ["T"])))
        XCTAssertEqual(fileSystem.files["/state/wm/state.json"], old)
    }

    private func makeStore(fileSystem: MemoryFileSystem) -> WorkspaceStateStore<TestState> {
        WorkspaceStateStore(
            stateURL: URL(fileURLWithPath: "/state/wm/state.json"),
            buildVersion: "test-build",
            fileSystem: fileSystem,
            validate: { state in
                guard state.stateVersion > 0, Set(state.names).count == state.names.count else {
                    throw TestError.invalid
                }
            },
            quarantineSuffix: { "fixed" }
        )
    }
}

private struct TestState: Codable, Equatable, Sendable {
    var stateVersion: UInt64
    var names: [String]
}

private enum TestError: Error { case invalid; case injected }

private final class MemoryFileSystem: WorkspaceStateFileSystem, @unchecked Sendable {
    var files: [String: Data]
    var operations: [String] = []
    var failDestinationRename = false

    init(files: [String: Data] = [:]) { self.files = files }

    func fileExists(at url: URL) -> Bool { files[url.path] != nil }
    func read(at url: URL) throws -> Data { try XCTUnwrap(files[url.path]) }
    func createDirectory(at url: URL) { operations.append("mkdir:\(url.path)") }

    func writeAndSynchronize(_ data: Data, to url: URL) {
        operations.append("write-sync:\(url.path)")
        files[url.path] = data
    }

    func rename(_ source: URL, to destination: URL) throws {
        operations.append("rename:\(source.path)->\(destination.path)")
        if failDestinationRename && destination.lastPathComponent == "state.json" { throw TestError.injected }
        files[destination.path] = try XCTUnwrap(files.removeValue(forKey: source.path))
    }
}
