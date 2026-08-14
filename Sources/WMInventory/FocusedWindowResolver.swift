import Foundation

public func resolveFocusedWindowID(
    windows: [NormalizedWindow],
    frontmostPID: Int32?
) -> String? {
    if let focused = windows.first(where: { $0.focused == true && $0.classification == .normal }) {
        return focused.id
    }
    guard let frontmostPID else { return nil }
    let candidates = windows.filter { $0.pid == frontmostPID && $0.classification == .normal }
    return candidates.first(where: { $0.main == true })?.id ?? candidates.first?.id
}
