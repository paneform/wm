import Testing

@testable import wm_sidecar

@Suite struct KeyMonitorTests {
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
    #expect(KeyMonitor.matchingAction(
      code: 11, isRepeat: false, candidates: [(chord, "workspace focus B")], pressed: [.rshift]
    ) == "workspace focus B")
  }

  @Test func unmatchedKeyDownDoesNotResolveAnAction() {
    let chord = KeyChord(modifiers: [.rshift], keyCode: 11)
    #expect(KeyMonitor.matchingAction(
      code: 17, isRepeat: false, candidates: [(chord, "workspace focus B")], pressed: [.rshift]
    ) == nil)
    #expect(KeyMonitor.matchingAction(
      code: 11, isRepeat: false, candidates: [(chord, "workspace focus B")], pressed: [.lshift]
    ) == nil)
  }

  @Test func repeatedKeyDownDoesNotResolveAnAction() {
    let chord = KeyChord(modifiers: [.rshift], keyCode: 11)
    #expect(KeyMonitor.matchingAction(
      code: 11, isRepeat: true, candidates: [(chord, "workspace focus B")], pressed: [.rshift]
    ) == nil)
  }
}
