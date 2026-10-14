import ApplicationServices
import Testing

@testable import wm_sidecar

@Suite struct WindowFocusTests {
    // Synthetic AX references exercise identity matching without querying TCC
    // or relying on the test runner's current frontmost application.
    private let zen = AXUIElementCreateApplication(42)
    private let bambu = AXUIElementCreateApplication(43)

    @Test func focusedReferenceWinsWithoutWindowAXFocusedFlag() {
        #expect(WindowFocus.matches(zen, pid: 42, frontmostPID: 42, focusedWindow: zen))
    }

    @Test func inactiveApplicationCannotClaimGlobalFocus() {
        #expect(!WindowFocus.matches(bambu, pid: 43, frontmostPID: 42, focusedWindow: bambu))
    }

    @Test func anotherWindowInTheActiveApplicationIsNotFocused() {
        #expect(!WindowFocus.matches(bambu, pid: 42, frontmostPID: 42, focusedWindow: zen))
    }

    @Test func missingFocusedReferenceDoesNotFallBackToAppLocalFlags() {
        #expect(!WindowFocus.matches(zen, pid: 42, frontmostPID: 42, focusedWindow: nil))
        #expect(!WindowFocus.matches(zen, pid: 42, frontmostPID: nil, focusedWindow: zen))
    }

    @Test func aFocusChangeDuringEnumerationInvalidatesTheSnapshot() {
        let initial = WindowFocus.Snapshot(pid: 42, window: zen)
        #expect(initial == WindowFocus.Snapshot(pid: 42, window: zen))
        #expect(initial != WindowFocus.Snapshot(pid: 43, window: bambu))
        #expect(initial != WindowFocus.Snapshot(pid: 42, window: bambu))
        #expect(initial != WindowFocus.Snapshot(pid: 42, window: nil))
    }
}
