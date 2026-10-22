import Foundation

/// Opt-in, monotonic native timing for diagnosing the focus critical path.
/// No window titles or documents are emitted.
enum FocusLatencyTrace {
    static let enabled = ProcessInfo.processInfo.environment["WM_FOCUS_TRACE"] == "1"

    static func record(_ stage: String, windowId: String?) {
        guard enabled else { return }
        let line = "[wm-focus] stage=\(stage) window=\(windowId ?? "none") ns=\(DispatchTime.now().uptimeNanoseconds)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }
}
