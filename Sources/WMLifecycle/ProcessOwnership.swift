import Darwin
import Foundation

public enum DaemonMode: String, Codable, Sendable { case manual, service }
public enum DaemonReadyState: String, Codable, Sendable { case starting, ready }

public struct DaemonOwnership: Codable, Equatable, Sendable {
    public var pid: Int32
    public var processStartIdentity: UInt64
    public var mode: DaemonMode
    public var endpoint: URL
    public var readyState: DaemonReadyState

    public init(pid: Int32, processStartIdentity: UInt64, mode: DaemonMode, endpoint: URL, readyState: DaemonReadyState) {
        self.pid = pid
        self.processStartIdentity = processStartIdentity
        self.mode = mode
        self.endpoint = endpoint
        self.readyState = readyState
    }
}

public enum OwnershipMetadataError: Error, Equatable { case unsafePath, processIdentityUnavailable, unavailable(Int32) }

public final class OperationLock: @unchecked Sendable {
    private let descriptor: Int32

    public init(url: URL) throws {
        guard url.isFileURL, url.path.hasPrefix("/"), url.lastPathComponent.hasSuffix(".lock") else {
            throw OwnershipMetadataError.unsafePath
        }
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: NSNumber(value: Int16(0o700))])
        var directoryStatus = stat()
        guard lstat(directory.path, &directoryStatus) == 0, directoryStatus.st_uid == geteuid(),
              directoryStatus.st_mode & S_IFMT == S_IFDIR, directoryStatus.st_mode & 0o022 == 0 else {
            throw OwnershipMetadataError.unsafePath
        }
        let descriptor = open(url.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw OwnershipMetadataError.unavailable(errno) }
        var status = stat()
        guard fstat(descriptor, &status) == 0, status.st_uid == geteuid(), status.st_mode & S_IFMT == S_IFREG,
              status.st_mode & 0o077 == 0 else {
            close(descriptor)
            throw OwnershipMetadataError.unsafePath
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            close(descriptor)
            throw OwnershipMetadataError.unavailable(code)
        }
        self.descriptor = descriptor
    }

    deinit { flock(descriptor, LOCK_UN); close(descriptor) }
}

public struct OwnershipMetadataStore: Sendable {
    public let url: URL

    public init(url: URL) { self.url = url }

    public func readVerified() throws -> DaemonOwnership? {
        guard let data = try? Data(contentsOf: url), let owner = try? JSONDecoder().decode(DaemonOwnership.self, from: data) else {
            return nil
        }
        guard try processStartIdentity(pid: owner.pid) == owner.processStartIdentity else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        return owner
    }

    public func write(_ owner: DaemonOwnership) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: NSNumber(value: Int16(0o700))])
        let temporary = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString)")
        try JSONEncoder().encode(owner).write(to: temporary, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        if rename(temporary.path, url.path) != 0 {
            let code = errno
            try? FileManager.default.removeItem(at: temporary)
            throw OwnershipMetadataError.unavailable(code)
        }
    }

    public func remove(ifOwnedBy owner: DaemonOwnership) {
        guard (try? JSONDecoder().decode(DaemonOwnership.self, from: Data(contentsOf: url))) == owner else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

public func processStartIdentity(pid: Int32) throws -> UInt64 {
    var info = proc_bsdinfo()
    let size = MemoryLayout<proc_bsdinfo>.stride
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(size)) == size else {
        throw OwnershipMetadataError.processIdentityUnavailable
    }
    return UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec)
}
