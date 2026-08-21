import Foundation
import WMProtocol

public struct WindowGeometryHandle: Hashable, Sendable {
  public var rawValue: String

  public init(rawValue: String) { self.rawValue = rawValue }
}

public enum WindowGeometryComponent: Sendable {
  case position, size
}

public struct WindowGeometrySettlement: Equatable, Sendable {
  public var frame: InventoryRect
  public var reads: Int
  public var notifications: Int

  public init(frame: InventoryRect, reads: Int, notifications: Int = 0) {
    self.frame = frame
    self.reads = reads
    self.notifications = notifications
  }
}

public enum WindowGeometryTransaction: Equatable, Sendable {
  case positionSize, sizeOnly, sizePositionSize
}

public enum WindowGeometryAdapterError: Error, Equatable, Sendable {
  case notFound
  case ambiguous
  case stale
  case notControllable
  case rejected
  case readFailed
}

public protocol WindowGeometryAdapter: Sendable {
  func reconcile(windows: [NormalizedWindow]) async
  func evict(lifetimes: Set<WindowLifetime>) async
  func resolve(_ window: NormalizedWindow) async throws -> WindowGeometryHandle
  func validateIdentity(of handle: WindowGeometryHandle, expected window: NormalizedWindow)
    async throws
  func validateControllability(of handle: WindowGeometryHandle) async throws
  func readFrame(of handle: WindowGeometryHandle) async throws -> InventoryRect
  func write(
    _ component: WindowGeometryComponent, frame: InventoryRect, to handle: WindowGeometryHandle)
    async throws
  func park(frame: InventoryRect, handle: WindowGeometryHandle) async throws
  func delay() async throws
  func settle(
    _ handle: WindowGeometryHandle, requested: InventoryRect, tolerance: Double
  ) async throws -> WindowGeometrySettlement
  func transact(
    _ transaction: WindowGeometryTransaction, frame: InventoryRect,
    handle: WindowGeometryHandle
  ) async throws
  func focus(_ handle: WindowGeometryHandle) async throws
  func isFocused(_ handle: WindowGeometryHandle) async throws -> Bool
  func fit(_ handle: WindowGeometryHandle, within frame: InventoryRect) async throws
}

extension WindowGeometryAdapter {
  public func reconcile(windows: [NormalizedWindow]) async {}
  public func evict(lifetimes: Set<WindowLifetime>) async {}
  public func validateIdentity(of handle: WindowGeometryHandle, expected window: NormalizedWindow)
    async throws
  {}
  public func focus(_ handle: WindowGeometryHandle) async throws {
    throw WindowGeometryAdapterError.notControllable
  }
  public func isFocused(_ handle: WindowGeometryHandle) async throws -> Bool { false }
  public func settle(
    _ handle: WindowGeometryHandle, requested: InventoryRect, tolerance: Double
  ) async throws -> WindowGeometrySettlement {
    var observed = try await readFrame(of: handle)
    var reads = 1
    for _ in 0..<11 where !observed.approximatelyEquals(requested, tolerance: tolerance) {
      try await delay()
      observed = try await readFrame(of: handle)
      reads += 1
    }
    return .init(frame: observed, reads: reads)
  }
  public func transact(
    _ transaction: WindowGeometryTransaction, frame: InventoryRect,
    handle: WindowGeometryHandle
  ) async throws {
    switch transaction {
    case .positionSize:
      try await write(.position, frame: frame, to: handle)
      try await write(.size, frame: frame, to: handle)
    case .sizeOnly:
      try await write(.size, frame: frame, to: handle)
    case .sizePositionSize:
      try await write(.size, frame: frame, to: handle)
      try await write(.position, frame: frame, to: handle)
      try await write(.size, frame: frame, to: handle)
    }
  }
  public func fit(_ handle: WindowGeometryHandle, within frame: InventoryRect) async throws {
    throw WindowGeometryAdapterError.notControllable
  }
  public func park(frame: InventoryRect, handle: WindowGeometryHandle) async throws {
    try await write(.size, frame: frame, to: handle)
    try await write(.position, frame: frame, to: handle)
    try await write(.size, frame: frame, to: handle)
  }
}

public struct WindowGeometryFailure: Error, Equatable, Sendable {
  public var code: WindowGeometryErrorCode
  public var message: String
  public var observedFrame: Rectangle?

  public init(code: WindowGeometryErrorCode, message: String, observedFrame: Rectangle? = nil) {
    self.code = code
    self.message = message
    self.observedFrame = observedFrame
  }
}

public struct WindowGeometrySetRequest: Equatable, Sendable {
  public var frame: InventoryRect
  public var tolerance: Double
  public var policy: WindowGeometryRetryPolicy

  public init(
    frame: InventoryRect, tolerance: Double = 1,
    policy: WindowGeometryRetryPolicy = .init()
  ) {
    self.frame = frame
    self.tolerance = tolerance
    self.policy = policy
  }
}

public struct WindowGeometrySetOutcome: Equatable, Sendable {
  public var requestedFrame: InventoryRect
  public var observedFrame: InventoryRect
  public var classification: WindowGeometryAttemptOutcome
  public var attempts: Int
  public var strategy: WindowGeometryStrategy

  public init(
    requestedFrame: InventoryRect, observedFrame: InventoryRect,
    classification: WindowGeometryAttemptOutcome, attempts: Int,
    strategy: WindowGeometryStrategy
  ) {
    self.requestedFrame = requestedFrame
    self.observedFrame = observedFrame
    self.classification = classification
    self.attempts = attempts
    self.strategy = strategy
  }
}

public protocol WindowGeometryEffects: Sendable {
  func reconcile(windows: [NormalizedWindow]) async
  func evict(lifetimes: Set<WindowLifetime>) async
  func get(window: NormalizedWindow) async throws -> WindowFrameGetResult
  func set(window: NormalizedWindow, params: WindowFrameSetParams) async throws
    -> WindowFrameSetResult
  func setGeometry(window: NormalizedWindow, request: WindowGeometrySetRequest) async throws
    -> WindowGeometrySetOutcome
  func focus(window: NormalizedWindow) async throws
  func fit(window: NormalizedWindow, within frame: InventoryRect) async throws -> InventoryRect
  func park(window: NormalizedWindow, frame: InventoryRect) async throws -> InventoryRect
  func setPosition(window: NormalizedWindow, frame: InventoryRect) async throws -> InventoryRect
  func setPositionAllowingClamping(window: NormalizedWindow, frame: InventoryRect) async throws
    -> InventoryRect
  func probeCapabilities(window: NormalizedWindow) async throws -> GeometryCapabilityProbeResult
}

public struct WindowGeometryService<Adapter: WindowGeometryAdapter>: Sendable {
  private let adapter: Adapter
  private let now: @Sendable () -> Date
  private let profiles: WindowGeometryProfileRecorder?
  private let profileContext: @Sendable (NormalizedWindow) -> WindowGeometryProfileContext

  public init(
    adapter: Adapter, now: @escaping @Sendable () -> Date = Date.init,
    profiles: WindowGeometryProfileRecorder? = nil,
    profileContext: @escaping @Sendable (NormalizedWindow) -> WindowGeometryProfileContext = { _ in
      .init()
    }
  ) {
    self.adapter = adapter
    self.now = now
    self.profiles = profiles
    self.profileContext = profileContext
  }

  public func reconcile(windows: [NormalizedWindow]) async {
    await adapter.reconcile(windows: windows)
  }

  public func evict(lifetimes: Set<WindowLifetime>) async {
    await adapter.evict(lifetimes: lifetimes)
  }

  public func get(window: NormalizedWindow) async throws -> WindowFrameGetResult {
    let handle = try await resolve(window)
    let frame = try await read(handle)
    return WindowFrameGetResult(windowID: window.id, frame: frame.protocolFrame, observedAt: now())
  }

  public func set(window: NormalizedWindow, params: WindowFrameSetParams) async throws
    -> WindowFrameSetResult
  {
    let requested = InventoryRect(params.frame)
    try validate(requested, tolerance: params.tolerance, attempts: params.attempts)
    let started = now()
    let outcome = try await setGeometry(
      window: window,
      request: .init(
        frame: requested, tolerance: params.tolerance,
        policy: .init(maximumAttempts: params.attempts))
    )
    guard outcome.classification == .exact || outcome.classification == .constrained else {
      throw WindowGeometryFailure(
        code: .geometryVerificationFailed,
        message: "window frame did not match the requested frame within tolerance",
        observedFrame: outcome.observedFrame.protocolFrame
      )
    }
    return result(
      window.id, requested, outcome.observedFrame, outcome.attempts,
      outcome.strategy, started
    )
  }

  public func setGeometry(
    window: NormalizedWindow, request: WindowGeometrySetRequest
  ) async throws -> WindowGeometrySetOutcome {
    try requireMovable(window)
    let requested = request.frame
    try validate(requested, tolerance: request.tolerance, attempts: request.policy.maximumAttempts)
    let handle = try await resolve(window)
    try await validateControllability(handle)
    var observed = try await read(handle)
    let initial = observed
    var previous = observed
    let context = profileContext(window)
    let usesProfiles = request.policy.mode != .inferEveryRequest
    var profile = usesProfiles ? await profiles?.profile(for: window, context: context) : nil
    let attemptLimit = request.policy.maximumAttempts
    var lastClassification: WindowGeometryAttemptOutcome = .failed
    var stableClamp = false
    for index in 0..<attemptLimit {
      let candidate = transaction(at: index, policy: request.policy, profile: profile)
      do {
        try await adapter.transact(candidate.1, frame: requested, handle: handle)
      } catch {
        throw mapAdapter(error, defaultCode: .geometryRejected)
      }
      observed = try await settle(handle, requested: requested, tolerance: request.tolerance).frame
      lastClassification = classify(
        requested: requested, previous: previous, observed: observed,
        tolerance: request.tolerance, profile: profile
      )
      stableClamp = isStableClamp(
        requested: requested, initial: initial, previous: previous, observed: observed,
        tolerance: request.tolerance
      )
      if usesProfiles && stableClamp && lastClassification == .failed {
        try await observe(
          window, requested, observed, index + 1, lastClassification,
          stableClamp: true
        )
        profile = await profiles?.profile(for: window, context: context)
        lastClassification = classify(
          requested: requested, previous: previous, observed: observed,
          tolerance: request.tolerance, profile: profile
        )
      }
      if lastClassification == .exact || lastClassification == .constrained {
        if usesProfiles && !stableClamp {
          try await observe(
            window, requested, observed, index + 1, lastClassification,
            stableClamp: stableClamp
          )
        }
        return .init(
          requestedFrame: requested, observedFrame: observed,
          classification: lastClassification, attempts: index + 1, strategy: candidate.0
        )
      }
      previous = observed
    }
    if usesProfiles {
      try await observe(
        window, requested, observed, attemptLimit, lastClassification,
        stableClamp: stableClamp
      )
    }
    return .init(
      requestedFrame: requested, observedFrame: observed,
      classification: lastClassification, attempts: attemptLimit,
      strategy: transaction(at: attemptLimit - 1, policy: request.policy, profile: profile).0
    )
  }

  public func focus(window: NormalizedWindow) async throws {
    let handle = try await resolve(window)
    do {
      try await adapter.focus(handle)
      if try await adapter.isFocused(handle) { return }
      try await adapter.delay()
      guard try await adapter.isFocused(handle) else {
        throw WindowGeometryFailure(
          code: .geometryVerificationFailed, message: "window did not become focused")
      }
    } catch let failure as WindowGeometryFailure {
      throw failure
    } catch {
      if (try? await adapter.isFocused(handle)) == true { return }
      throw mapAdapter(error, defaultCode: .geometryRejected)
    }
  }

  public func fit(window: NormalizedWindow, within frame: InventoryRect) async throws
    -> InventoryRect
  {
    try requireMovable(window)
    let handle = try await resolve(window)
    do {
      try await adapter.fit(handle, within: frame)
      let observed = try await settle(handle, requested: frame, tolerance: 1).frame
      if observed.approximatelyEquals(frame) { return observed }
    } catch WindowGeometryAdapterError.notControllable {
      // Fall through to portable component writes.
    } catch {
      // Native zoom support varies by application; component writes remain authoritative.
    }
    let anchor = InventoryRect(
      x: frame.x, y: frame.y,
      width: max(1, frame.width * 0.75), height: max(1, frame.height * 0.75)
    )
    do {
      try await adapter.transact(.positionSize, frame: anchor, handle: handle)
      let anchored = try await settle(handle, requested: anchor, tolerance: 1).frame
      guard anchored.approximatelyEquals(anchor) else {
        throw WindowGeometryFailure(
          code: .geometryVerificationFailed,
          message: "window did not reach the in-bounds anchor frame",
          observedFrame: anchored.protocolFrame
        )
      }
    } catch let failure as WindowGeometryFailure {
      throw failure
    } catch {
      throw mapAdapter(error, defaultCode: .geometryRejected)
    }
    do {
      let result = try await set(
        window: window,
        params: .init(
          windowID: window.id, frame: frame.protocolFrame, attempts: 4
        ))
      return InventoryRect(result.observedFrame)
    } catch let failure as WindowGeometryFailure {
      guard failure.code == .geometryVerificationFailed,
        let observedFrame = failure.observedFrame
      else { throw failure }
      let observed = InventoryRect(observedFrame)
      guard frame.contains(observed, tolerance: 20) else { throw failure }
      return observed
    }
  }

  public func park(window: NormalizedWindow, frame: InventoryRect) async throws -> InventoryRect {
    try requireMovable(window)
    let handle = try await resolve(window)
    do {
      try await adapter.park(frame: frame, handle: handle)
      return try await adapter.readFrame(of: handle)
    } catch {
      throw mapAdapter(error, defaultCode: .geometryRejected)
    }
  }

  public func setPosition(
    window: NormalizedWindow, frame: InventoryRect
  ) async throws -> InventoryRect {
    try await setPosition(window: window, frame: frame, allowClamping: false)
  }

  public func setPositionAllowingClamping(
    window: NormalizedWindow, frame: InventoryRect
  ) async throws -> InventoryRect {
    try await setPosition(window: window, frame: frame, allowClamping: true)
  }

  private func setPosition(
    window: NormalizedWindow, frame: InventoryRect, allowClamping: Bool
  ) async throws -> InventoryRect {
    try requireMovable(window)
    guard WindowCapabilityPolicy.effective(window.geometryCapabilities.position) != .fixed else {
      throw WindowGeometryFailure(
        code: .windowNotControllable, message: "window position is not writable")
    }
    let handle = try await resolve(window)
    let original = try await read(handle)
    var requested = original
    requested.x = frame.x
    requested.y = frame.y
    do {
      try await adapter.write(.position, frame: requested, to: handle)
      let observed = try await settle(handle, requested: requested, tolerance: 1).frame
      guard
        allowClamping
          || (abs(observed.x - requested.x) <= 1 && abs(observed.y - requested.y) <= 1),
        abs(observed.width - original.width) <= 1, abs(observed.height - original.height) <= 1
      else {
        throw WindowGeometryFailure(
          code: .geometryVerificationFailed,
          message: "position-only write changed size or missed its target",
          observedFrame: observed.protocolFrame)
      }
      return observed
    } catch let failure as WindowGeometryFailure {
      throw failure
    } catch {
      throw mapAdapter(error, defaultCode: .geometryRejected)
    }
  }

  public func probeCapabilities(window: NormalizedWindow) async throws
    -> GeometryCapabilityProbeResult
  {
    let handle = try await resolve(window)
    try await adapter.validateIdentity(of: handle, expected: window)
    let original = try await read(handle)
    var attempts: [GeometryProbeAttempt] = []
    var errors: [String] = []
    var positionSupported = false
    var sizeSupported = false
    var positionUncertain = false
    var sizeUncertain = false
    var rejectedSizeDimensions: Set<GeometryProbeDimension> = []
    var changedComponents: Set<WindowGeometryComponent> = []
    let candidates: [(GeometryProbeDimension, WindowGeometryComponent, InventoryRect)] = [
      (
        .xNegative, .position,
        .init(x: original.x - 1, y: original.y, width: original.width, height: original.height)
      ),
      (
        .xPositive, .position,
        .init(x: original.x + 1, y: original.y, width: original.width, height: original.height)
      ),
      (
        .yNegative, .position,
        .init(x: original.x, y: original.y - 1, width: original.width, height: original.height)
      ),
      (
        .yPositive, .position,
        .init(x: original.x, y: original.y + 1, width: original.width, height: original.height)
      ),
      (
        .widthIn, .size,
        .init(
          x: original.x, y: original.y, width: max(1, original.width - 1), height: original.height)
      ),
      (
        .widthOut, .size,
        .init(x: original.x, y: original.y, width: original.width + 1, height: original.height)
      ),
      (
        .heightIn, .size,
        .init(
          x: original.x, y: original.y, width: original.width, height: max(1, original.height - 1))
      ),
      (
        .heightOut, .size,
        .init(x: original.x, y: original.y, width: original.width, height: original.height + 1)
      ),
    ]
    var restoration = GeometryProbeRestoration(attempted: false, succeeded: false, verified: false)
    do {
      candidateLoop: for (dimension, component, requested) in candidates {
        do {
          try Task.checkCancellation()
          try await adapter.validateIdentity(of: handle, expected: window)
          try await adapter.write(component, frame: requested, to: handle)
          changedComponents.insert(component)
          try await adapter.validateIdentity(of: handle, expected: window)
          let observed = try await adapter.settle(handle, requested: requested, tolerance: 0.25)
            .frame
          let changed = componentChanged(component, original, observed)
          let matched = componentMatches(component, requested, observed)
          let crossChanged = componentChanged(
            component == .position ? .size : .position, original, observed)
          attempts.append(
            .init(
              dimension: dimension, requestedFrame: requested.protocolFrame,
              observedFrame: observed.protocolFrame, changed: changed, matchedRequest: matched))
          if component == .position {
            positionSupported = positionSupported || changed && matched && !crossChanged
            positionUncertain = positionUncertain || crossChanged || changed && !matched
          } else {
            sizeSupported = sizeSupported || changed && matched && !crossChanged
            sizeUncertain = sizeUncertain || crossChanged || changed && !matched
          }
          if crossChanged {
            changedComponents.insert(component == .position ? .size : .position)
          }
          do {
            try await restore(component, original: original, handle: handle, window: window)
            changedComponents.remove(component)
          } catch is CancellationError {
            throw CancellationError()
          } catch {
            let message = "intermediate restoration: \(error)"
            errors.append(message)
            if component == .position { positionUncertain = true } else { sizeUncertain = true }
            break candidateLoop
          }
        } catch is CancellationError {
          throw CancellationError()
        } catch {
          let message = String(describing: error)
          attempts.append(
            .init(dimension: dimension, requestedFrame: requested.protocolFrame, error: message))
          errors.append("\(dimension.rawValue): \(message)")
          if component == .position {
            positionUncertain = true
          } else {
            sizeUncertain = true
            if case WindowGeometryAdapterError.rejected = error {
              rejectedSizeDimensions.insert(dimension)
            }
          }
          if case WindowGeometryAdapterError.stale = error { break candidateLoop }
        }
      }
    } catch is CancellationError {
      await bestEffortRestore(
        changedComponents, original: original, handle: handle, window: window)
      throw CancellationError()
    }
    restoration.attempted = true
    do {
      try await restore(
        changedComponents, original: original, handle: handle, window: window)
      restoration.succeeded = true
      try await adapter.validateIdentity(of: handle, expected: window)
      let final = try await adapter.readFrame(of: handle)
      restoration.verified = final.approximatelyEquals(original, tolerance: 0.25)
      let position = probeCapability(supported: positionSupported, uncertain: positionUncertain)
      let size = probeCapability(
        supported: sizeSupported, uncertain: sizeUncertain,
        fixed: rejectedSizeDimensions == [.widthIn, .widthOut, .heightIn, .heightOut])
      return .init(
        windowID: window.id, originalFrame: original.protocolFrame, finalFrame: final.protocolFrame,
        position: position, size: size, attempts: attempts, restoration: restoration, errors: errors
      )
    } catch {
      restoration.error = String(describing: error)
      errors.append("restoration: \(error)")
      let final = try? await adapter.readFrame(of: handle)
      return .init(
        windowID: window.id, originalFrame: original.protocolFrame,
        finalFrame: final?.protocolFrame,
        position: probeCapability(supported: positionSupported, uncertain: true),
        size: probeCapability(supported: sizeSupported, uncertain: true), attempts: attempts,
        restoration: restoration, errors: errors)
    }
  }

  private func probeCapability(
    supported: Bool, uncertain: Bool, fixed: Bool = false
  ) -> GeometryCapability {
    let state: GeometryCapabilityState =
      fixed ? .fixed : supported && !uncertain ? .supported : .inconclusive
    return .init(confirmed: state, evidence: [.init(source: .behavioralProbe, state: state)])
  }

  private func componentChanged(
    _ component: WindowGeometryComponent, _ lhs: InventoryRect, _ rhs: InventoryRect
  ) -> Bool {
    !componentMatches(component, lhs, rhs)
  }

  private func componentMatches(
    _ component: WindowGeometryComponent, _ lhs: InventoryRect, _ rhs: InventoryRect
  ) -> Bool {
    switch component {
    case .position: abs(lhs.x - rhs.x) <= 0.25 && abs(lhs.y - rhs.y) <= 0.25
    case .size: abs(lhs.width - rhs.width) <= 0.25 && abs(lhs.height - rhs.height) <= 0.25
    }
  }

  private func restore(
    _ component: WindowGeometryComponent, original: InventoryRect,
    handle: WindowGeometryHandle, window: NormalizedWindow
  ) async throws {
    try await adapter.validateIdentity(of: handle, expected: window)
    try await adapter.write(component, frame: original, to: handle)
    try await adapter.validateIdentity(of: handle, expected: window)
    let observed = try await adapter.settle(handle, requested: original, tolerance: 0.25).frame
    guard componentMatches(component, original, observed) else {
      throw WindowGeometryAdapterError.stale
    }
  }

  private func restore(
    _ components: Set<WindowGeometryComponent>, original: InventoryRect,
    handle: WindowGeometryHandle, window: NormalizedWindow
  ) async throws {
    for component in [WindowGeometryComponent.position, .size] where components.contains(component)
    {
      try await restore(component, original: original, handle: handle, window: window)
    }
  }

  private func bestEffortRestore(
    _ components: Set<WindowGeometryComponent>, original: InventoryRect,
    handle: WindowGeometryHandle, window: NormalizedWindow
  ) async {
    for component in [WindowGeometryComponent.position, .size] where components.contains(component)
    {
      do {
        try await restore(component, original: original, handle: handle, window: window)
      } catch {}
    }
  }

  private func requireMovable(_ window: NormalizedWindow) throws {
    guard window.classification == .normal else {
      throw WindowGeometryFailure(
        code: .windowNotControllable,
        message: "transient windows cannot be moved")
    }
  }

  private func resolve(_ window: NormalizedWindow) async throws -> WindowGeometryHandle {
    do { return try await adapter.resolve(window) } catch {
      throw mapAdapter(error, defaultCode: .inventoryStale)
    }
  }

  private func validateControllability(_ handle: WindowGeometryHandle) async throws {
    do { try await adapter.validateControllability(of: handle) } catch {
      throw mapAdapter(error, defaultCode: .windowNotControllable)
    }
  }

  private func read(_ handle: WindowGeometryHandle) async throws -> InventoryRect {
    do { return try await adapter.readFrame(of: handle) } catch {
      throw mapAdapter(error, defaultCode: .inventoryStale)
    }
  }

  private func settle(
    _ handle: WindowGeometryHandle, requested: InventoryRect, tolerance: Double
  ) async throws -> WindowGeometrySettlement {
    do {
      return try await adapter.settle(handle, requested: requested, tolerance: tolerance)
    } catch {
      throw mapAdapter(error, defaultCode: .inventoryStale)
    }
  }

  private func validate(_ frame: InventoryRect, tolerance: Double, attempts: Int) throws {
    guard frame.isUsable, attempts >= 1, attempts <= 5, tolerance.isFinite, tolerance >= 0,
      tolerance <= 20
    else {
      throw WindowGeometryFailure(
        code: .invalidFrame, message: "frame, tolerance, or attempts are outside supported bounds")
    }
  }

  private func transaction(
    at index: Int, policy: WindowGeometryRetryPolicy,
    profile: WindowGeometryProfile?
  ) -> (WindowGeometryStrategy, WindowGeometryTransaction) {
    if let profile {
      let learnedFallback: Int
      switch policy.mode {
      case .storeAndReuse: learnedFallback = profile.correctiveAttemptCount > 1 ? 0 : .max
      case .optimisticIdealFirst: learnedFallback = 1
      case .inferEveryRequest: learnedFallback = .max
      }
      if index >= learnedFallback {
        return (.convergedSizeThenPosition, .sizePositionSize)
      }
    }
    switch index {
    case 0: return (.positionThenSize, .positionSize)
    case 1: return (.sizeThenPosition, .sizeOnly)
    case 2: return (.sizeThenPosition, .sizePositionSize)
    default: return (.convergedSizeThenPosition, .sizePositionSize)
    }
  }

  private func isStableClamp(
    requested: InventoryRect, initial: InventoryRect, previous: InventoryRect,
    observed: InventoryRect,
    tolerance: Double
  ) -> Bool {
    guard observed.approximatelyEquals(previous, tolerance: tolerance),
      !observed.approximatelyEquals(requested, tolerance: tolerance),
      abs(observed.x - requested.x) <= tolerance,
      abs(observed.y - requested.y) <= tolerance
    else { return false }
    let widthClamped =
      abs(observed.width - requested.width) > tolerance
      && abs(observed.width - initial.width) > tolerance
    let heightClamped =
      abs(observed.height - requested.height) > tolerance
      && abs(observed.height - initial.height) > tolerance
    return widthClamped || heightClamped
  }

  private func classify(
    requested: InventoryRect, previous: InventoryRect, observed: InventoryRect,
    tolerance: Double, profile: WindowGeometryProfile?
  ) -> WindowGeometryAttemptOutcome {
    if observed.approximatelyEquals(requested, tolerance: tolerance) { return .exact }
    if matchesKnownConstraint(
      observed, requested: requested, profile: profile, tolerance: tolerance)
    {
      return .constrained
    }
    if observed.normalizedDistance(to: requested) < previous.normalizedDistance(to: requested) {
      return .progressing
    }
    return .failed
  }

  private func matchesKnownConstraint(
    _ observed: InventoryRect, requested: InventoryRect,
    profile: WindowGeometryProfile?, tolerance: Double
  ) -> Bool {
    guard let profile else { return false }
    let widthMatches: Bool
    if let minimum = profile.minimumWidth, requested.width < minimum {
      widthMatches = abs(observed.width - minimum) <= tolerance
    } else if let maximum = profile.maximumWidth, requested.width > maximum {
      widthMatches = abs(observed.width - maximum) <= tolerance
    } else {
      widthMatches = abs(observed.width - requested.width) <= tolerance
    }
    let heightMatches: Bool
    if let minimum = profile.minimumHeight, requested.height < minimum {
      heightMatches = abs(observed.height - minimum) <= tolerance
    } else if let maximum = profile.maximumHeight, requested.height > maximum {
      heightMatches = abs(observed.height - maximum) <= tolerance
    } else {
      heightMatches = abs(observed.height - requested.height) <= tolerance
    }
    return widthMatches && heightMatches
      && abs(observed.x - requested.x) <= tolerance
      && abs(observed.y - requested.y) <= tolerance
  }

  private func result(
    _ id: String, _ requested: InventoryRect, _ observed: InventoryRect, _ attempts: Int,
    _ strategy: WindowGeometryStrategy, _ started: Date
  ) -> WindowFrameSetResult {
    WindowFrameSetResult(
      windowID: id, requestedFrame: requested.protocolFrame, observedFrame: observed.protocolFrame,
      verified: true, attempts: attempts, strategy: strategy,
      durationMilliseconds: max(0, Int(now().timeIntervalSince(started) * 1_000)))
  }

  private func observe(
    _ window: NormalizedWindow, _ requested: InventoryRect, _ observed: InventoryRect,
    _ attempts: Int, _ outcome: WindowGeometryAttemptOutcome,
    stableClamp: Bool
  ) async throws {
    try await profiles?.record(
      .init(
        window: window, context: profileContext(window), requested: requested, observed: observed,
        attempts: attempts, outcome: outcome, stableClamp: stableClamp, observedAt: now()
      ))
  }

  private func mapAdapter(_ error: Error, defaultCode: WindowGeometryErrorCode)
    -> WindowGeometryFailure
  {
    guard let error = error as? WindowGeometryAdapterError else {
      return .init(code: defaultCode, message: String(describing: error))
    }
    switch error {
    case .notFound: return .init(code: .windowNotFound, message: "window no longer exists")
    case .ambiguous: return .init(code: .inventoryStale, message: "window identity is ambiguous")
    case .stale, .readFailed:
      return .init(code: .inventoryStale, message: "window inventory identity is stale")
    case .notControllable:
      return .init(code: .windowNotControllable, message: "window position or size is not writable")
    case .rejected:
      return .init(code: .geometryRejected, message: "platform rejected the frame change")
    }
  }
}

extension WindowGeometryService: WindowGeometryEffects {}

extension WindowGeometryStrategy {
  fileprivate static let all: [Self] = [
    .positionThenSize, .sizeThenPosition, .delayedPositionThenSize, .convergedSizeThenPosition,
  ]

  fileprivate var steps: [(component: WindowGeometryComponent, delayed: Bool)] {
    switch self {
    case .positionThenSize: [(.position, false), (.size, false)]
    case .sizeThenPosition: [(.size, false), (.position, false)]
    case .delayedPositionThenSize: [(.position, true), (.size, false)]
    case .convergedSizeThenPosition:
      [
        (.size, false), (.position, true), (.size, true), (.position, true),
      ]
    }
  }
}

extension InventoryRect {
  init(_ frame: Rectangle) {
    self.init(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
  }
  public var protocolFrame: Rectangle { Rectangle(x: x, y: y, width: width, height: height) }
  public func contains(_ other: Self, tolerance: Double = 0) -> Bool {
    other.x >= x - tolerance && other.y >= y - tolerance
      && other.x + other.width <= x + width + tolerance
      && other.y + other.height <= y + height + tolerance
  }
}
