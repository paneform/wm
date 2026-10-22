import AppKit
import Foundation
import Testing

@testable import wm_sidecar

@Suite struct KeyMonitorTests {
  private final class Actions: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    func append(_ action: String) { lock.withLock { recorded.append(action) } }
    var values: [String] { lock.withLock { recorded } }
  }

  private func event(_ code: CGKeyCode, flags: CGEventFlags) throws -> CGEvent {
    let event = try #require(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true))
    event.flags = flags
    return event
  }

  private func shifted(_ masks: Int32) -> CGEventFlags {
    CGEventFlags(rawValue: CGEventFlags.maskShift.rawValue | UInt64(masks))
  }

  @Test func commandShortcutsDoNotAliasStaleShiftBindings() throws {
    let actions = Actions()
    let monitor = KeyMonitor(onAction: { actions.append($0) })
    try monitor.configure(
      [
        "rshift q": "workspace focus Q",
        "lshift rshift tab": "workspace move display next",
      ], captureKeyboard: false)
    _ = monitor.handle(
      type: .flagsChanged, event: try event(60, flags: shifted(NX_DEVICERSHIFTKEYMASK)))
    #expect(!monitor.handle(type: .keyDown, event: try event(12, flags: .maskCommand)))
    _ = monitor.handle(
      type: .flagsChanged,
      event: try event(56, flags: shifted(NX_DEVICELSHIFTKEYMASK | NX_DEVICERSHIFTKEYMASK)))
    #expect(!monitor.handle(type: .keyDown, event: try event(48, flags: .maskCommand)))
    #expect(actions.values.isEmpty)
  }

  @Test func missedShiftReleaseCannotSwallowOrdinaryTyping() throws {
    let actions = Actions()
    let monitor = KeyMonitor(onAction: { actions.append($0) })
    try monitor.configure(["rshift q": "workspace focus Q"], captureKeyboard: false)
    _ = monitor.handle(
      type: .flagsChanged, event: try event(60, flags: shifted(NX_DEVICERSHIFTKEYMASK)))
    #expect(!monitor.handle(type: .keyDown, event: try event(12, flags: [])))
    #expect(actions.values.isEmpty)
  }

  @Test func keyDownFlagsRecognizeHotkeysWithoutPriorModifierEvents() throws {
    let actions = Actions()
    let monitor = KeyMonitor(onAction: { actions.append($0) })
    try monitor.configure(["rshift q": "workspace focus Q"], captureKeyboard: false)
    #expect(
      monitor.handle(type: .keyDown, event: try event(12, flags: shifted(NX_DEVICERSHIFTKEYMASK))))
    #expect(actions.values == ["workspace focus Q"])
  }

  @Test func genericFlagsPreserveCommandAndAmbiguousSidesFailOpen() {
    let modifiers = KeyMonitor.modifiers(from: [.maskCommand, .maskShift])
    #expect(modifiers == [.command, .shift])
    #expect(KeyMonitor.matches(expected: [.command, .shift], pressed: modifiers))
    #expect(!KeyMonitor.matches(expected: [.rshift], pressed: modifiers))
    #expect(!KeyMonitor.matches(expected: [.rcommand, .rshift], pressed: modifiers))
    #expect(
      KeyMonitor.modifiers(from: CGEventFlags(rawValue: UInt64(NX_DEVICERSHIFTKEYMASK))).isEmpty)
  }

  @Test func sideSpecificModifiersRemainDistinct() {
    #expect(KeyMonitor.matches(expected: [.rshift], pressed: [.rshift]))
    #expect(!KeyMonitor.matches(expected: [.rshift], pressed: [.lshift]))
    #expect(!KeyMonitor.matches(expected: [.rshift], pressed: [.lshift, .rshift]))
    #expect(KeyMonitor.matches(expected: [.lshift, .rshift], pressed: [.lshift, .rshift]))
  }

  @Test func genericModifierMeansEitherSide() {
    #expect(KeyMonitor.matches(expected: [.shift], pressed: [.lshift]))
    #expect(KeyMonitor.matches(expected: [.shift], pressed: [.rshift]))
    #expect(KeyMonitor.matches(expected: [.shift], pressed: [.lshift, .rshift]))
    #expect(!KeyMonitor.matches(expected: [.shift], pressed: []))
  }

  @Test func unspecifiedModifiersPreventAMatch() {
    #expect(!KeyMonitor.matches(expected: [.rshift], pressed: [.rshift, .lcommand]))
  }

  @Test func matchedKeyDownResolvesItsAction() {
    let chord = KeyChord(modifiers: [.rshift], keyCode: 11)
    #expect(
      KeyMonitor.matchingAction(
        code: 11, isRepeat: false, candidates: [(chord, "workspace focus B")], pressed: [.rshift]
      ) == "workspace focus B")
  }

  @Test func unmatchedKeyDownDoesNotResolveAnAction() {
    let chord = KeyChord(modifiers: [.rshift], keyCode: 11)
    #expect(
      KeyMonitor.matchingAction(
        code: 17, isRepeat: false, candidates: [(chord, "workspace focus B")], pressed: [.rshift]
      ) == nil)
    #expect(
      KeyMonitor.matchingAction(
        code: 11, isRepeat: false, candidates: [(chord, "workspace focus B")], pressed: [.lshift]
      ) == nil)
  }

  @Test func repeatedKeyDownDoesNotResolveAnAction() {
    let chord = KeyChord(modifiers: [.rshift], keyCode: 11)
    #expect(
      KeyMonitor.matchingAction(
        code: 11, isRepeat: true, candidates: [(chord, "workspace focus B")], pressed: [.rshift]
      ) == nil)
  }

  @Test func pausedSwallowingKeepsOnlyConfiguredExceptionsSuppressed() {
    let regular = KeyChord(modifiers: [.rshift], keyCode: 11)
    let unpause = KeyChord(modifiers: [.rshift], keyCode: 12)

    #expect(
      KeyMonitor.shouldSwallow(
        chord: regular, swallowHotkeys: false, alwaysSwallowed: [unpause]) == false)
    #expect(
      KeyMonitor.shouldSwallow(
        chord: unpause, swallowHotkeys: false, alwaysSwallowed: [unpause]) == true)
    #expect(
      KeyMonitor.shouldSwallow(
        chord: regular, swallowHotkeys: true, alwaysSwallowed: [unpause]) == true)
  }
}
