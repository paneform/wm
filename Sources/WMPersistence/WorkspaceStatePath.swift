import Foundation

public enum WorkspaceStatePath {
    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        let stateRoot: URL
        if let xdgStateHome = environment["XDG_STATE_HOME"], !xdgStateHome.isEmpty {
            stateRoot = URL(fileURLWithPath: xdgStateHome, isDirectory: true)
        } else {
            stateRoot = homeDirectory
                .appendingPathComponent(".local", isDirectory: true)
                .appendingPathComponent("state", isDirectory: true)
        }
        return stateRoot
            .appendingPathComponent("wm", isDirectory: true)
            .appendingPathComponent("state.json", isDirectory: false)
    }
}
