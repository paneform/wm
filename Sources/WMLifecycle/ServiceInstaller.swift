import Darwin
import Foundation
import SystemConfiguration

public struct ServiceInstallation: Equatable, Sendable {
  public var plist: URL
  public var executable: URL

  public init(plist: URL, executable: URL) {
    self.plist = plist
    self.executable = executable
  }
}

public struct ServiceInstaller: Sendable {
  public let launchd: any LaunchdControlling
  public let processes: any ProcessControlling
  public let metadata: OwnershipMetadataStore
  public let plist: URL
  public let operationLockURL: URL
  public let executable: URL
  public let logs: URL
  public let activeGUIUser: @Sendable () -> uid_t?
  public let validateConfiguration: @Sendable () throws -> Void
  public let removeItem: @Sendable (URL) throws -> Void

  public init(
    launchd: any LaunchdControlling,
    processes: any ProcessControlling,
    metadata: OwnershipMetadataStore,
    plist: URL,
    operationLockURL: URL,
    executable: URL,
    logs: URL,
    activeGUIUser: @escaping @Sendable () -> uid_t? = activeConsoleUser,
    validateConfiguration: @escaping @Sendable () throws -> Void = {},
    removeItem: @escaping @Sendable (URL) throws -> Void = {
      try FileManager.default.removeItem(at: $0)
    }
  ) {
    self.launchd = launchd
    self.processes = processes
    self.metadata = metadata
    self.plist = plist
    self.operationLockURL = operationLockURL
    self.executable = executable
    self.logs = logs
    self.activeGUIUser = activeGUIUser
    self.validateConfiguration = validateConfiguration
    self.removeItem = removeItem
  }

  public func install() async throws -> LifecycleResult {
    let lock = try lifecycleLock()
    _ = lock
    guard activeGUIUser() == geteuid() else { throw LifecycleFailure.activeSessionRequired }
    guard !FileManager.default.fileExists(atPath: plist.path) else {
      throw validInstalledPlist() ? LifecycleFailure.serviceAlreadyInstalled : .unsafeServiceFile
    }
    do { try validateConfiguration() } catch {
      throw LifecycleFailure.operationFailed(
        "The wm configuration is invalid. Fix it, then try `wm install` again. \(error)")
    }
    let warnings = try validateDestination()
    try createDirectories()
    try writePlist()
    do {
      try await launchd.bootstrap(plist: plist)
    } catch {
      try? FileManager.default.removeItem(at: plist)
      throw LifecycleFailure.operationFailed(
        "The wm service could not be registered with launchd. Fix the reported problem, then try `wm install` again. \(error)"
      )
    }
    return .init(action: "install", changed: true, warnings: warnings)
  }

  public func uninstall() async throws -> LifecycleResult {
    let lock = try lifecycleLock()
    _ = lock
    let exists = FileManager.default.fileExists(atPath: plist.path)
    let bootstrapped = await launchd.isBootstrapped(label: WMServiceIdentity.label)
    guard exists || bootstrapped else { throw LifecycleFailure.serviceNotInstalled }
    if let owner = try metadata.readVerified(), owner.mode == .service, processes.isRunning(owner) {
      throw LifecycleFailure.serviceRunning
    }
    if bootstrapped {
      do { try await launchd.bootout(label: WMServiceIdentity.label) } catch {
        throw LifecycleFailure.operationFailed(
          "The wm service could not be unloaded. Try `wm uninstall` again. \(error)")
      }
    }
    if exists {
      do { try removeItem(plist) } catch { throw LifecycleFailure.partialUninstall(plist.path) }
    }
    return .init(action: "uninstall", changed: true)
  }

  private func lifecycleLock() throws -> OperationLock {
    do { return try OperationLock(url: operationLockURL) } catch OwnershipMetadataError.unavailable(
      EWOULDBLOCK)
    { throw LifecycleFailure.lifecycleBusy } catch {
      throw LifecycleFailure.operationFailed(String(describing: error))
    }
  }

  private func validateDestination() throws -> [String] {
    let directory = plist.deletingLastPathComponent()
    guard plist.isFileURL, plist.lastPathComponent == "\(WMServiceIdentity.label).plist",
      directory.path.hasSuffix("/Library/LaunchAgents")
    else { throw LifecycleFailure.unsafeServiceFile }
    if FileManager.default.fileExists(atPath: directory.path) {
      var status = stat()
      guard lstat(directory.path, &status) == 0, status.st_uid == geteuid(),
        status.st_mode & S_IFMT == S_IFDIR,
        status.st_mode & 0o022 == 0
      else { throw LifecycleFailure.unsafeServiceFile }
      if status.st_mode & 0o055 != 0 {
        return [
          "The LaunchAgents directory is accessible to other users (mode \(String(status.st_mode & 0o777, radix: 8))). The wm service plist remains owner-writable only."
        ]
      }
    }
    return []
  }

  private func createDirectories() throws {
    try FileManager.default.createDirectory(
      at: plist.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.createDirectory(
      at: logs, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
  }

  private func writePlist() throws {
    let resolved = executable.resolvingSymlinksInPath().standardizedFileURL
    guard resolved.isFileURL, resolved.path.hasPrefix("/"),
      FileManager.default.isExecutableFile(atPath: resolved.path)
    else {
      throw LifecycleFailure.operationFailed(
        "The current wm executable cannot be used by launchd. Install wm at a stable absolute path, then try `wm install` again."
      )
    }
    let value: [String: Any] = [
      "Label": WMServiceIdentity.label,
      "ProgramArguments": [resolved.path, "daemon"],
      "EnvironmentVariables": [WMServiceIdentity.serviceModeEnvironmentKey: "1"],
      "RunAtLoad": false,
      "KeepAlive": ["SuccessfulExit": false],
      "ProcessType": "Interactive",
      "ThrottleInterval": 10,
      "StandardOutPath": logs.appending(path: "daemon.stdout.log").path,
      "StandardErrorPath": logs.appending(path: "daemon.stderr.log").path,
    ]
    let data = try PropertyListSerialization.data(fromPropertyList: value, format: .xml, options: 0)
    let temporary = plist.deletingLastPathComponent().appending(
      path: ".\(plist.lastPathComponent).\(UUID().uuidString)")
    try data.write(to: temporary, options: .withoutOverwriting)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
    guard rename(temporary.path, plist.path) == 0 else {
      let code = errno
      try? FileManager.default.removeItem(at: temporary)
      throw LifecycleFailure.operationFailed("The wm service file could not be installed: \(code)")
    }
  }

  private func validInstalledPlist() -> Bool {
    var status = stat()
    guard lstat(plist.path, &status) == 0, status.st_uid == geteuid(),
      status.st_mode & S_IFMT == S_IFREG,
      status.st_mode & 0o077 == 0, let data = try? Data(contentsOf: plist),
      let object = try? PropertyListSerialization.propertyList(from: data, format: nil)
        as? [String: Any],
      object["Label"] as? String == WMServiceIdentity.label
    else { return false }
    return true
  }
}

public func activeConsoleUser() -> uid_t? {
  var uid: uid_t = 0
  var gid: gid_t = 0
  guard let value = SCDynamicStoreCopyConsoleUser(nil, &uid, &gid) as String?,
    value != "loginwindow"
  else { return nil }
  return uid
}

public func isConsoleSessionActive() -> Bool {
  activeConsoleUser() == geteuid()
}

public func currentExecutableURL() throws -> URL {
  var path = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
  guard proc_pidpath(getpid(), &path, UInt32(path.count)) > 0 else {
    throw LifecycleFailure.operationFailed(
      "The current wm executable path could not be resolved. Install wm at a stable path, then try `wm install` again."
    )
  }
  let bytes = path.prefix { $0 != 0 }.map(UInt8.init(bitPattern:))
  return URL(fileURLWithPath: String(decoding: bytes, as: UTF8.self)).resolvingSymlinksInPath()
}
