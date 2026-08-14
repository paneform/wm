import Darwin
import Foundation

public enum DaemonProcessLockError: Error, Equatable, Sendable {
    case alreadyRunning
    case unsafePath
    case unavailable(Int32)
}

public final class DaemonProcessLock: @unchecked Sendable {
    private let descriptor: Int32
    public let url: URL

    public init(
        url: URL = WorkspaceStatePath.resolve().deletingLastPathComponent().appendingPathComponent("daemon.lock")
    ) throws {
        guard url.isFileURL, url.path.hasPrefix("/"), url.lastPathComponent == "daemon.lock" else {
            throw DaemonProcessLockError.unsafePath
        }
        self.url = url
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
        )
        var directoryStatus = stat()
        guard lstat(directory.path, &directoryStatus) == 0,
              directoryStatus.st_uid == geteuid(),
              directoryStatus.st_mode & S_IFMT == S_IFDIR,
              directoryStatus.st_mode & 0o022 == 0 else { throw DaemonProcessLockError.unsafePath }

        let descriptor = open(url.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw DaemonProcessLockError.unavailable(errno) }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              status.st_uid == geteuid(),
              status.st_mode & S_IFMT == S_IFREG,
              status.st_mode & 0o077 == 0 else {
            close(descriptor)
            throw DaemonProcessLockError.unsafePath
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            close(descriptor)
            throw code == EWOULDBLOCK ? DaemonProcessLockError.alreadyRunning : .unavailable(code)
        }
        self.descriptor = descriptor
    }

    public var isCloseOnExec: Bool { fcntl(descriptor, F_GETFD) & FD_CLOEXEC != 0 }

    deinit {
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}
