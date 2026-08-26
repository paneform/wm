import AppKit
import Foundation

/// Serializes every stdout/stderr write; stdout carries protocol JSON only,
/// one object per line. Human logs go to stderr.
final class LineWriter: @unchecked Sendable {
  private let lock = NSLock()
  private let output: FileHandle
  private let errors: FileHandle

  init(output: FileHandle = .standardOutput, errors: FileHandle = .standardError) {
    self.output = output
    self.errors = errors
  }

  func write(line: String) {
    lock.lock()
    defer { lock.unlock() }
    output.write(Data((line + "\n").utf8))
  }

  func log(_ message: String) {
    lock.lock()
    defer { lock.unlock() }
    errors.write(Data((message + "\n").utf8))
  }
}

/// Request router and protocol lifecycle. stdin ops are dispatched as
/// concurrent tasks; results are correlated by reqId. Events flow once the
/// engine sends `subscribe`.
@MainActor
final class SidecarServer {
  private let input: FileHandle
  private let writer: LineWriter
  private lazy var inventory = InventoryService { [weak self] event in
    Task { @MainActor in self?.forward(event) }
  }
  private var subscribed = false
  private var inFlight = 0
  private var shutdownRequested = false
  private lazy var keyMonitor = KeyMonitor { [weak self] action in
    Task { @MainActor in self?.forward(.keybind(action: action)) }
  }

  init(input: FileHandle = .standardInput, writer: LineWriter = LineWriter()) {
    self.input = input
    self.writer = writer
  }

  func start() {
    if let line = Wire.encodeLine(
      ReadyMessage(
        version: Wire.version,
        accessibility: Permissions.accessibilityGranted,
        screenRecording: Permissions.screenRecordingGranted))
    {
      writer.write(line: line)
    }
    inventory.start()
    installSignalHandlers()
    startStdinReader()
  }

  // MARK: stdin

  private func startStdinReader() {
    let input = input
    let thread = Thread { [weak self] in
      var buffered = Data()
      while true {
        let chunk = input.availableData
        guard !chunk.isEmpty else { break }
        buffered.append(chunk)
        while let newline = buffered.firstIndex(of: 0x0A) {
          let line = String(decoding: buffered[..<newline], as: UTF8.self)
          buffered.removeSubrange(...newline)
          self?.receive(line: line)
        }
      }
      if !buffered.isEmpty { self?.receive(line: String(decoding: buffered, as: UTF8.self)) }
      Task { @MainActor in self?.stdinClosed() }
    }
    thread.name = "sidecar-stdin"
    thread.start()
  }

  nonisolated private func receive(line: String) {
    Task { @MainActor in self.handle(line: line) }
  }

  private func handle(line: String) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return }
    guard let request = Wire.decodeRequest(trimmed) else {
      writer.log("[wm-sidecar] unparseable request line")
      send(
        ErrorMessage(
          reqId: nil,
          error: .init(code: "invalid_request", detail: "request is not valid protocol JSON")))
      return
    }
    inFlight += 1
    Task { @MainActor in
      await self.dispatch(request)
      self.inFlight -= 1
      if self.shutdownRequested && self.inFlight == 0 { exit(0) }
    }
  }

  /// EOF on stdin: finish outstanding work, then exit cleanly.
  private func stdinClosed() {
    shutdownRequested = true
    if inFlight == 0 { exit(0) }
  }

  private func installSignalHandlers() {
    for name in [SIGTERM, SIGINT] {
      signal(name, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: name, queue: .main)
      source.setEventHandler { exit(0) }
      source.resume()
    }
  }

  // MARK: Dispatch

  private func dispatch(_ request: RequestMessage) async {
    switch request.op {
    case "ping":
      send(ResultMessage(reqId: requestId(request), result: .pong(version: Wire.version)))

    case "permissionsStatus":
      send(ResultMessage(reqId: requestId(request), result: .permissions(Permissions.current)))

    case "requestPermissions":
      // TCC prompts MUST originate from this executable to be attributed
      // to wm-sidecar; both calls are idempotent when already granted.
      _ = Permissions.requestAccessibility()
      _ = Permissions.requestScreenRecording()
      send(ResultMessage(reqId: requestId(request), result: .permissions(Permissions.current)))

    case "openPermissionsSettings":
      guard let target = request.target else {
        return sendError(
          request, code: "invalid_request",
          detail: "openPermissionsSettings requires \"target\"")
      }
      guard Permissions.openSettings(target: target) else {
        return sendError(
          request, code: "invalid_request",
          detail: "unknown settings target \(target)")
      }
      send(ResultMessage(reqId: requestId(request), result: .opened))

    case "subscribe":
      subscribed = true
      send(ResultMessage(reqId: requestId(request), result: .subscribed))

    case "configureKeybinds":
      guard let keybinds = request.keybinds else {
        return sendError(
          request, code: "invalid_request", detail: "configureKeybinds requires keybinds")
      }
      do {
        try keyMonitor.configure(keybinds)
        send(ResultMessage(reqId: requestId(request), result: .keybindsConfigured(keybinds.count)))
      } catch KeyMonitorError.permissionDenied {
        sendError(
          request, code: "permission",
          detail: "Input Monitoring permission is required for keybinds")
      } catch {
        sendError(request, code: "invalid_request", detail: String(describing: error))
      }

    case "getTopology":
      if let topology = inventory.currentTopology() {
        send(ResultMessage(reqId: requestId(request), result: .topology(topology)))
      } else {
        sendError(request, code: "unavailable", detail: "topology not yet observed")
      }

    case "getWindows":
      send(ResultMessage(reqId: requestId(request), result: .windows(inventory.currentWindows())))

    case "getWindow":
      guard let id = request.id else {
        return sendError(request, code: "invalid_request", detail: "getWindow requires \"id\"")
      }
      guard let meta = inventory.metadata(for: id) else {
        return send(ResultMessage(reqId: requestId(request), result: .window(nil)))
      }
      send(
        ResultMessage(
          reqId: requestId(request),
          result: .window(inventory.liveObservation(for: meta))))

    case "setWindowFrame":
      await dispatchWrite(request)

    case "executeBatch":
      await dispatchBatch(request)

    case "focusWindow":
      guard let id = request.id else {
        return sendError(request, code: "invalid_request", detail: "focusWindow requires \"id\"")
      }
      guard let meta = inventory.metadata(for: id) else {
        return sendError(request, code: "not_found", detail: "unknown window \(id)")
      }
      do {
        try await inventory.focus(meta: meta)
        send(ResultMessage(reqId: requestId(request), result: .focused))
      } catch let error as AdapterError {
        sendError(request, code: error.wireCode, detail: "focus failed")
      } catch {
        sendError(request, code: "rejected", detail: "focus failed: \(error)")
      }

    default:
      sendError(request, code: "invalid_request", detail: "unknown op \(request.op)")
    }
  }

  /// mode=frame does size→position→size bookends; position/size do a single
  /// component write against a merged target.
  private func dispatchWrite(_ request: RequestMessage) async {
    guard let id = request.id else {
      return sendError(request, code: "invalid_request", detail: "setWindowFrame requires \"id\"")
    }
    guard let frameValue = request.frame else {
      return sendError(
        request, code: "invalid_request", detail: "setWindowFrame requires \"frame\"")
    }
    let mode = request.mode ?? "frame"
    guard ["frame", "position", "size"].contains(mode) else {
      return sendError(request, code: "invalid_request", detail: "invalid mode \(mode)")
    }
    guard let meta = inventory.metadata(for: id) else {
      return sendError(request, code: "not_found", detail: "unknown window \(id)")
    }
    var target = Rect(frameValue)
    do {
      let components: [GeometryAdapter.Component]
      switch mode {
      case "position":
        target = try inventory.mergedTarget(meta: meta) {
          $0.x = frameValue.x
          $0.y = frameValue.y
        }
        components = [.position]
      case "size":
        target = try inventory.mergedTarget(meta: meta) {
          $0.width = frameValue.width
          $0.height = frameValue.height
        }
        components = [.size]
      default:
        components = [.size, .position, .size]
      }
      let write = try await inventory.write(
        meta: meta,
        requested: target,
        components: components,
        expectedIdentity: request.expectedIdentity)
      send(ResultMessage(reqId: requestId(request), result: .write(write)))
    } catch let error as AdapterError {
      // The platform API itself refused; report honestly with the last
      // observed frame so the engine can classify.
      let observed = inventory.currentObservedFrame(for: meta) ?? target
      send(
        ResultMessage(
          reqId: requestId(request),
          result: .write(
            WriteValue(
              requested: target.frameValue,
              observed: observed.frameValue,
              stable: false,
              errorKind: error.wireCode))))
    } catch {
      let observed = inventory.currentObservedFrame(for: meta) ?? target
      send(
        ResultMessage(
          reqId: requestId(request),
          result: .write(
            WriteValue(
              requested: target.frameValue,
              observed: observed.frameValue,
              stable: false,
              errorKind: AdapterError.rejected.wireCode))))
    }
  }

  /// Captures every target before mutation, then runs dependency waves.
  /// Same-window operations are serialized; independent windows overlap
  /// while AX settle sleeps suspend. Aggregate results are request ordered.
  private func dispatchBatch(_ request: RequestMessage) async {
    guard let operations = request.operations else {
      return sendError(request, code: "invalid_request", detail: "executeBatch requires operations")
    }
    let metas = Dictionary(
      uniqueKeysWithValues: Set(operations.map(\.windowId)).compactMap {
        id in inventory.metadata(for: id).map { (id, $0) }
      })
    var pending = Set(operations.indices)
    var results: [Int: BatchOperationResultValue] = [:]
    while !pending.isEmpty {
      var windows = Set<String>()
      let ready = pending.sorted().filter { index in
        let operation = operations[index]
        guard
          (operation.dependsOn ?? []).allSatisfy({ dependency in
            results.values.contains(where: { $0.operationId == dependency })
          }), !windows.contains(operation.windowId)
        else { return false }
        windows.insert(operation.windowId)
        return true
      }
      guard !ready.isEmpty else {
        for index in pending {
          results[index] = batchFailure(
            operations[index], code: "rejected", detail: "cyclic or unknown dependency")
        }
        break
      }
      await withTaskGroup(of: (Int, BatchOperationResultValue).self) { group in
        let prior = results
        for index in ready {
          let operation = operations[index]
          let meta = metas[operation.windowId]
          group.addTask {
            (index, await self.executeBatchOperation(operation, meta: meta, prior: prior))
          }
        }
        for await (index, result) in group { results[index] = result }
      }
      pending.subtract(ready)
    }
    let ordered = operations.indices.map { results[$0]! }
    send(
      ResultMessage(
        reqId: requestId(request),
        result: .batch(
          BatchResultValue(
            operations: ordered,
            completed: ordered.filter { $0.error == nil }.count,
            failed: ordered.filter { $0.error != nil }.count))))
  }

  private func executeBatchOperation(
    _ operation: BatchOperationValue,
    meta: WindowMeta?,
    prior: [Int: BatchOperationResultValue]
  ) async -> BatchOperationResultValue {
    if let failedDependency = (operation.dependsOn ?? []).first(where: { dependency in
      prior.values.contains(where: { $0.operationId == dependency && $0.error != nil })
    }) {
      return batchFailure(
        operation, code: "rejected", detail: "dependency \(failedDependency) failed")
    }
    guard let meta else {
      return batchFailure(operation, code: "not_found", detail: "unknown window")
    }
    do {
      if operation.kind == "focus" {
        try await inventory.focus(meta: meta, expectedIdentity: operation.expectedIdentity)
        return BatchOperationResultValue(operationId: operation.operationId)
      }
      guard operation.kind == "setFrame", let frame = operation.frame else {
        return batchFailure(operation, code: "invalid_request", detail: "invalid batch operation")
      }
      let write = try await inventory.write(
        meta: meta, requested: Rect(frame), components: [.size, .position, .size],
        expectedIdentity: operation.expectedIdentity)
      return BatchOperationResultValue(
        operationId: operation.operationId, requested: write.requested,
        observed: write.observed, stable: write.stable,
        stableReads: write.stableReads, error: nil)
    } catch let error as AdapterError {
      return batchFailure(operation, code: error.wireCode, detail: "batch operation failed")
    } catch {
      return batchFailure(operation, code: "rejected", detail: "batch operation failed")
    }
  }

  private func batchFailure(_ operation: BatchOperationValue, code: String, detail: String)
    -> BatchOperationResultValue
  {
    BatchOperationResultValue(
      operationId: operation.operationId, requested: operation.frame,
      observed: nil, stable: false, stableReads: 0,
      error: BatchErrorValue(code: code, detail: detail))
  }

  // MARK: Output

  fileprivate func forward(_ event: EventMessage) {
    guard subscribed else { return }
    if let line = Wire.encodeLine(event) { writer.write(line: line) }
  }

  private func send(_ message: ResultMessage) {
    guard let line = Wire.encodeLine(message) else { return }
    writer.write(line: line)
  }

  private func send(_ message: ErrorMessage) {
    guard let line = Wire.encodeLine(message) else { return }
    writer.write(line: line)
  }

  private func sendError(_ request: RequestMessage, code: String, detail: String?) {
    send(ErrorMessage(reqId: request.reqId, error: .init(code: code, detail: detail)))
  }

  private func requestId(_ request: RequestMessage) -> String {
    request.reqId ?? ""
  }
}
