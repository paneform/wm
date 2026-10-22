import AppKit
import CoreGraphics
import Foundation

enum KeyMonitorError: Error, CustomStringConvertible {
  case invalidChord(String)
  case duplicateChord(String)
  case permissionDenied
  case tapUnavailable

  var description: String {
    switch self {
    case .invalidChord(let chord): "invalid key chord: \(chord)"
    case .duplicateChord(let chord): "duplicate key chord: \(chord)"
    case .permissionDenied: "Input Monitoring permission is required for keybinds"
    case .tapUnavailable: "unable to create keyboard event tap"
    }
  }
}

enum KeyModifier: String, CaseIterable, Hashable {
  case shift, lshift, rshift, control, lcontrol, rcontrol, option, loption, roption
  case command, lcommand, rcommand, fn
}

struct KeyChord: Hashable {
  let modifiers: Set<KeyModifier>
  let keyCode: Int64
}

final class KeyMonitor {
  private let onAction: @Sendable (String) -> Void
  private var bindings: [Int64: [(KeyChord, String)]] = [:]
  private var alwaysSwallowed = Set<KeyChord>()
  private var swallowHotkeys = true
  private var tap: CFMachPort?
  private var source: CFRunLoopSource?

  init(onAction: @escaping @Sendable (String) -> Void) {
    self.onAction = onAction
  }

  func configure(
    _ values: [String: String], alwaysSwallowing: [String] = [], captureKeyboard: Bool = true
  ) throws {
    var parsed: [(KeyChord, String)] = []
    var chords = Set<KeyChord>()
    for (source, action) in values.sorted(by: { $0.key < $1.key }) {
      let chord = try Self.parse(source)
      guard chords.insert(chord).inserted else { throw KeyMonitorError.duplicateChord(source) }
      parsed.append((chord, action))
    }
    let parsedAlwaysSwallowed = try alwaysSwallowing.map(Self.parse)
    if captureKeyboard && !parsed.isEmpty && tap == nil { try start() }
    bindings = Dictionary(grouping: parsed, by: { $0.0.keyCode })
    alwaysSwallowed = Set(parsedAlwaysSwallowed)
    if parsed.isEmpty || !captureKeyboard { stop() }
  }

  func setHotkeySwallowing(_ enabled: Bool) {
    swallowHotkeys = enabled
  }

  deinit { stop() }

  private func start() throws {
    guard CGPreflightListenEventAccess() || CGRequestListenEventAccess() else {
      throw KeyMonitorError.permissionDenied
    }
    let mask = [CGEventType.keyDown, .flagsChanged].reduce(CGEventMask(0)) {
      $0 | (CGEventMask(1) << CGEventMask($1.rawValue))
    }
    let context = Unmanaged.passUnretained(self).toOpaque()
    guard
      let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
        eventsOfInterest: mask, callback: keyMonitorCallback, userInfo: context
      )
    else { throw KeyMonitorError.tapUnavailable }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    self.tap = tap
    self.source = source
  }

  private func stop() {
    if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
    if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
    source = nil
    tap = nil
  }

  func handle(type: CGEventType, event: CGEvent) -> Bool {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return false
    }
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    if type == .flagsChanged {
      return false
    }
    guard type == .keyDown else { return false }
    guard
      let binding = Self.matchingBinding(
        code: code,
        isRepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0,
        candidates: bindings[code] ?? [],
        pressed: Self.modifiers(from: event.flags)
      )
    else { return false }
    onAction(binding.1)
    return Self.shouldSwallow(
      chord: binding.0, swallowHotkeys: swallowHotkeys, alwaysSwallowed: alwaysSwallowed)
  }

  /// Each key-down is authoritative. Lost modifier events must not turn OS
  /// Command shortcuts into wm Shift bindings or swallow ordinary typing.
  static func modifiers(from flags: CGEventFlags) -> Set<KeyModifier> {
    var pressed = Set<KeyModifier>()
    for (mask, generic, sides) in modifierGroups where flags.contains(mask) {
      let active = sides.filter { isPressed($0, flags: flags) }
      if active.isEmpty { pressed.insert(generic) } else { pressed.formUnion(active) }
    }
    if flags.contains(.maskSecondaryFn) { pressed.insert(.fn) }
    return pressed
  }

  static func matches(expected: Set<KeyModifier>, pressed: Set<KeyModifier>) -> Bool {
    for generic in [KeyModifier.shift, .control, .option, .command] {
      let active = pressed.filter { Self.generic($0) == generic }
      let required = expected.filter { Self.generic($0) == generic }
      if required.contains(generic) {
        if active.isEmpty { return false }
      } else if active != required {
        return false
      }
    }
    return pressed.contains(.fn) == expected.contains(.fn)
  }

  static func matchingAction(
    code: Int64,
    isRepeat: Bool,
    candidates: [(KeyChord, String)],
    pressed: Set<KeyModifier>
  ) -> String? {
    matchingBinding(code: code, isRepeat: isRepeat, candidates: candidates, pressed: pressed)?.1
  }

  static func matchingBinding(
    code: Int64,
    isRepeat: Bool,
    candidates: [(KeyChord, String)],
    pressed: Set<KeyModifier>
  ) -> (KeyChord, String)? {
    guard !isRepeat else { return nil }
    return candidates.first {
      $0.0.keyCode == code && matches(expected: $0.0.modifiers, pressed: pressed)
    }
  }

  static func shouldSwallow(
    chord: KeyChord,
    swallowHotkeys: Bool,
    alwaysSwallowed: Set<KeyChord>
  ) -> Bool {
    swallowHotkeys || alwaysSwallowed.contains(chord)
  }

  private static func parse(_ source: String) throws -> KeyChord {
    let parts = source.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
    var modifiers = Set<KeyModifier>()
    var keyCode: Int64?
    for part in parts {
      if let modifier = KeyModifier(rawValue: part) {
        guard modifiers.insert(modifier).inserted else {
          throw KeyMonitorError.invalidChord(source)
        }
      } else if let code = keyCodes[part], keyCode == nil {
        keyCode = code
      } else {
        throw KeyMonitorError.invalidChord(source)
      }
    }
    guard let keyCode else { throw KeyMonitorError.invalidChord(source) }
    for generic in [KeyModifier.shift, .control, .option, .command]
    where modifiers.contains(generic) {
      guard !modifiers.contains(where: { $0 != generic && Self.generic($0) == generic }) else {
        throw KeyMonitorError.invalidChord(source)
      }
    }
    return KeyChord(modifiers: modifiers, keyCode: keyCode)
  }

  private static func generic(_ modifier: KeyModifier) -> KeyModifier {
    switch modifier {
    case .lshift, .rshift: .shift
    case .lcontrol, .rcontrol: .control
    case .loption, .roption: .option
    case .lcommand, .rcommand: .command
    default: modifier
    }
  }

  private static func isPressed(_ modifier: KeyModifier, flags: CGEventFlags) -> Bool {
    let deviceMask: Int32
    switch modifier {
    case .lshift: deviceMask = NX_DEVICELSHIFTKEYMASK
    case .rshift: deviceMask = NX_DEVICERSHIFTKEYMASK
    case .lcontrol: deviceMask = NX_DEVICELCTLKEYMASK
    case .rcontrol: deviceMask = NX_DEVICERCTLKEYMASK
    case .loption: deviceMask = NX_DEVICELALTKEYMASK
    case .roption: deviceMask = NX_DEVICERALTKEYMASK
    case .lcommand: deviceMask = NX_DEVICELCMDKEYMASK
    case .rcommand: deviceMask = NX_DEVICERCMDKEYMASK
    case .fn: return flags.contains(.maskSecondaryFn)
    default: return false
    }
    return flags.rawValue & UInt64(deviceMask) != 0
  }

  private static let modifierGroups: [(CGEventFlags, KeyModifier, [KeyModifier])] = [
    (.maskShift, .shift, [.lshift, .rshift]),
    (.maskControl, .control, [.lcontrol, .rcontrol]),
    (.maskAlternate, .option, [.loption, .roption]),
    (.maskCommand, .command, [.lcommand, .rcommand]),
  ]

  private static let keyCodes: [String: Int64] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32,
    "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "k": 40, "n": 45,
    "m": 46, "tab": 48, "space": 49, "delete": 51, "escape": 53,
    "=": 24, "-": 27, "]": 30, "[": 33, "'": 39, ";": 41, "\\": 42,
    ",": 43, "/": 44, ".": 47, "`": 50,
    "home": 115, "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  ]
}

private func keyMonitorCallback(
  proxy _: CGEventTapProxy, type: CGEventType, event: CGEvent,
  refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
  if let refcon {
    let monitor = Unmanaged<KeyMonitor>.fromOpaque(refcon).takeUnretainedValue()
    if monitor.handle(type: type, event: event) { return nil }
  }
  return Unmanaged.passUnretained(event)
}
