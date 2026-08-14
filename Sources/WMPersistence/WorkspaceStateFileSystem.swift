import Darwin
import Foundation

public protocol WorkspaceStateFileSystem: Sendable {
    func fileExists(at url: URL) -> Bool
    func read(at url: URL) throws -> Data
    func createDirectory(at url: URL) throws
    func writeAndSynchronize(_ data: Data, to url: URL) throws
    func rename(_ source: URL, to destination: URL) throws
}

public struct LocalWorkspaceStateFileSystem: WorkspaceStateFileSystem {
    public init() {}

    public func fileExists(at url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    public func read(at url: URL) throws -> Data {
        try Data(contentsOf: url)
    }

    public func createDirectory(at url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    public func writeAndSynchronize(_ data: Data, to url: URL) throws {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw POSIXFailure(operation: "open", code: errno) }
        defer { close(descriptor) }

        try data.withUnsafeBytes { rawBuffer in
            guard var address = rawBuffer.baseAddress else { return }
            var remaining = rawBuffer.count
            while remaining > 0 {
                let count = Darwin.write(descriptor, address, remaining)
                guard count >= 0 else {
                    if errno == EINTR { continue }
                    throw POSIXFailure(operation: "write", code: errno)
                }
                address = address.advanced(by: Int(count))
                remaining -= count
            }
        }
        guard fsync(descriptor) == 0 else { throw POSIXFailure(operation: "fsync", code: errno) }
    }

    public func rename(_ source: URL, to destination: URL) throws {
        guard Darwin.rename(source.path, destination.path) == 0 else {
            throw POSIXFailure(operation: "rename", code: errno)
        }
    }
}

public struct POSIXFailure: Error, Equatable, CustomStringConvertible, Sendable {
    public var operation: String
    public var code: Int32

    public init(operation: String, code: Int32) {
        self.operation = operation
        self.code = code
    }

    public var description: String { "\(operation) failed with errno \(code)" }
}
