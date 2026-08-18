import Foundation

public enum WMServiceIdentity {
    public static let label = "com.allandeutsch.wm"
    public static let serviceModeEnvironmentKey = "WM_SERVICE_MODE"

    public static func plistURL(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        homeDirectory.appending(path: "Library/LaunchAgents/\(label).plist")
    }

    public static func stateDirectory(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        if let state = ProcessInfo.processInfo.environment["XDG_STATE_HOME"], !state.isEmpty {
            return URL(fileURLWithPath: state, isDirectory: true).appending(path: "wm")
        }
        return homeDirectory.appending(path: ".local/state/wm")
    }

    public static func logDirectory(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        stateDirectory(homeDirectory: homeDirectory).appending(path: "logs")
    }

    public static func endpoint(port: UInt16 = 17_832) -> URL {
        URL(string: "ws://127.0.0.1:\(port)/v1")!
    }
}
