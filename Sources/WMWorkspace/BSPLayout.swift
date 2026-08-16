import Foundation

public struct WorkspaceLayoutRect: Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }
}

public struct WorkspaceMinimumSize: Equatable, Sendable {
  public var width: Double
  public var height: Double

  public init(width: Double = 0, height: Double = 0) {
    self.width = width
    self.height = height
  }
}

public struct WorkspaceWindowCooperation: Equatable, Sendable {
  public var minimumSize: WorkspaceMinimumSize
  public var isCooperative: Bool

  public init(minimumSize: WorkspaceMinimumSize = .init(), isCooperative: Bool = true) {
    self.minimumSize = minimumSize
    self.isCooperative = isCooperative
  }
}

public enum WorkspaceLayoutPlan: Equatable, Sendable {
  case frames([WorkspaceWindowID: WorkspaceLayoutRect])
  case rejected
}

extension Workspace {
  public func layout(in bounds: WorkspaceLayoutRect) -> [WorkspaceWindowID: WorkspaceLayoutRect] {
    layout(in: bounds, minimumSizes: [:])
  }

  public func layout(
    in bounds: WorkspaceLayoutRect,
    minimumSizes: [WorkspaceWindowID: WorkspaceMinimumSize]
  ) -> [WorkspaceWindowID: WorkspaceLayoutRect] {
    guard mode == .bsp, let root = bsp.root else { return [:] }
    let content = WorkspaceLayoutRect(
      x: bounds.x + margin.left,
      y: bounds.y + margin.top,
      width: max(0, bounds.width - margin.left - margin.right),
      height: max(0, bounds.height - margin.top - margin.bottom)
    )
    return root.layout(in: content, gap: max(0, gap), minimumSizes: minimumSizes)
  }

  public func canFit(
    in bounds: WorkspaceLayoutRect,
    minimumSizes: [WorkspaceWindowID: WorkspaceMinimumSize]
  ) -> Bool {
    guard let root = bsp.root else { return true }
    let minimum = root.minimumSize(gap: max(0, gap), minimumSizes: minimumSizes)
    return minimum.width <= max(0, bounds.width - margin.left - margin.right)
      && minimum.height <= max(0, bounds.height - margin.top - margin.bottom)
  }

  public func layoutPlan(
    in bounds: WorkspaceLayoutRect,
    cooperation: [WorkspaceWindowID: WorkspaceWindowCooperation]
  ) -> WorkspaceLayoutPlan {
    let minimumSizes = cooperation.mapValues(\.minimumSize)
    guard
      cooperation.values.contains(where: { !$0.isCooperative })
        || !canFit(in: bounds, minimumSizes: minimumSizes)
    else {
      return .frames(layout(in: bounds, minimumSizes: minimumSizes))
    }
    let content = WorkspaceLayoutRect(
      x: bounds.x + margin.left,
      y: bounds.y + margin.top,
      width: max(0, bounds.width - margin.left - margin.right),
      height: max(0, bounds.height - margin.top - margin.bottom)
    )
    switch uncooperativeWindowPolicy {
    case .greedy:
      guard canFit(in: bounds, minimumSizes: minimumSizes) else { return .rejected }
      return .frames(layout(in: bounds, minimumSizes: minimumSizes))
    case .stack:
      let order = windowIDs.filter { $0 != focusedWindowID } + [focusedWindowID].compactMap { $0 }
      return .frames(Dictionary(uniqueKeysWithValues: order.map { ($0, content) }))
    case .overlap:
      guard
        cooperation.values.allSatisfy({
          $0.minimumSize.width <= content.width && $0.minimumSize.height <= content.height
        })
      else { return .rejected }
      let tiled = layout(in: bounds)
      return .frames(
        Dictionary(
          uniqueKeysWithValues: windowIDs.compactMap { id in
            guard let tile = tiled[id] else { return nil }
            let minimum = cooperation[id]?.minimumSize ?? .init()
            let width = min(content.width, max(tile.width, minimum.width))
            let height = min(content.height, max(tile.height, minimum.height))
            return (
              id,
              WorkspaceLayoutRect(
                x: min(max(tile.x, content.x), content.x + content.width - width),
                y: min(max(tile.y, content.y), content.y + content.height - height),
                width: width, height: height
              )
            )
          }))
    case .reject:
      return .rejected
    }
  }
}

extension BSPNode {
  fileprivate func layout(
    in frame: WorkspaceLayoutRect,
    gap: Double,
    minimumSizes: [WorkspaceWindowID: WorkspaceMinimumSize]
  ) -> [WorkspaceWindowID: WorkspaceLayoutRect] {
    switch self {
    case .leaf(let windowID):
      return [windowID: frame]
    case .split(let axis, let ratio, let first, let second):
      let available = max(0, (axis == .vertical ? frame.width : frame.height) - gap)
      let firstMinimum = first.minimumSize(gap: gap, minimumSizes: minimumSizes)
      let secondMinimum = second.minimumSize(gap: gap, minimumSizes: minimumSizes)
      let firstBound = axis == .vertical ? firstMinimum.width : firstMinimum.height
      let secondBound = axis == .vertical ? secondMinimum.width : secondMinimum.height
      let preferred = floor(available * ratio)
      let firstLength = min(max(preferred, firstBound), max(firstBound, available - secondBound))
      let secondLength = max(0, available - firstLength)
      let firstFrame: WorkspaceLayoutRect
      let secondFrame: WorkspaceLayoutRect
      if axis == .vertical {
        firstFrame = .init(x: frame.x, y: frame.y, width: firstLength, height: frame.height)
        secondFrame = .init(
          x: frame.x + firstLength + gap, y: frame.y, width: secondLength, height: frame.height)
      } else {
        firstFrame = .init(x: frame.x, y: frame.y, width: frame.width, height: firstLength)
        secondFrame = .init(
          x: frame.x, y: frame.y + firstLength + gap, width: frame.width, height: secondLength)
      }
      return first.layout(in: firstFrame, gap: gap, minimumSizes: minimumSizes)
        .merging(second.layout(in: secondFrame, gap: gap, minimumSizes: minimumSizes)) { first, _ in
          first
        }
    }
  }

  fileprivate func minimumSize(
    gap: Double,
    minimumSizes: [WorkspaceWindowID: WorkspaceMinimumSize]
  ) -> WorkspaceMinimumSize {
    switch self {
    case .leaf(let windowID):
      return minimumSizes[windowID] ?? .init()
    case .split(let axis, _, let first, let second):
      let a = first.minimumSize(gap: gap, minimumSizes: minimumSizes)
      let b = second.minimumSize(gap: gap, minimumSizes: minimumSizes)
      if axis == .vertical {
        return .init(width: a.width + gap + b.width, height: max(a.height, b.height))
      }
      return .init(width: max(a.width, b.width), height: a.height + gap + b.height)
    }
  }
}
