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
  public var maximumSize: WorkspaceMaximumSize
  public var isCooperative: Bool

  public init(minimumSize: WorkspaceMinimumSize = .init(), maximumSize: WorkspaceMaximumSize = .init(), isCooperative: Bool = true) {
    self.minimumSize = minimumSize
    self.maximumSize = maximumSize
    self.isCooperative = isCooperative
  }
}

public struct WorkspaceMaximumSize: Equatable, Sendable {
  public var width: Double?
  public var height: Double?
  public init(width: Double? = nil, height: Double? = nil) { self.width = width; self.height = height }
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
    let maximumSizes = cooperation.mapValues(\.maximumSize)
    guard
      cooperation.values.contains(where: { !$0.isCooperative })
        || !canFit(in: bounds, minimumSizes: minimumSizes)
    else {
      return .frames(layout(in: bounds, minimumSizes: minimumSizes, maximumSizes: maximumSizes))
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
      return .frames(layout(in: bounds, minimumSizes: minimumSizes, maximumSizes: maximumSizes))
    case .stack:
      let order = windowIDs.filter { $0 != focusedWindowID } + [focusedWindowID].compactMap { $0 }
      return .frames(Dictionary(uniqueKeysWithValues: order.map { id in
        let maximum = cooperation[id]?.maximumSize ?? .init()
        let width = min(content.width, maximum.width ?? content.width)
        let height = min(content.height, maximum.height ?? content.height)
        return (id, .init(x: content.x, y: content.y, width: width, height: height))
      }))
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
            let maximum = cooperation[id]?.maximumSize ?? .init()
            let width = min(content.width, maximum.width ?? content.width, max(tile.width, minimum.width))
            let height = min(content.height, maximum.height ?? content.height, max(tile.height, minimum.height))
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

extension Workspace {
  private func layout(
    in bounds: WorkspaceLayoutRect,
    minimumSizes: [WorkspaceWindowID: WorkspaceMinimumSize],
    maximumSizes: [WorkspaceWindowID: WorkspaceMaximumSize]
  ) -> [WorkspaceWindowID: WorkspaceLayoutRect] {
    guard mode == .bsp, let root = bsp.root else { return [:] }
    let content = WorkspaceLayoutRect(
      x: bounds.x + margin.left, y: bounds.y + margin.top,
      width: max(0, bounds.width - margin.left - margin.right),
      height: max(0, bounds.height - margin.top - margin.bottom))
    return root.layout(in: content, gap: max(0, gap), minimumSizes: minimumSizes, maximumSizes: maximumSizes)
  }
}

extension BSPNode {
  fileprivate func layout(
    in frame: WorkspaceLayoutRect,
    gap: Double,
    minimumSizes: [WorkspaceWindowID: WorkspaceMinimumSize]
  ) -> [WorkspaceWindowID: WorkspaceLayoutRect] {
    layout(in: frame, gap: gap, minimumSizes: minimumSizes, maximumSizes: [:])
  }

  fileprivate func layout(
    in frame: WorkspaceLayoutRect, gap: Double,
    minimumSizes: [WorkspaceWindowID: WorkspaceMinimumSize],
    maximumSizes: [WorkspaceWindowID: WorkspaceMaximumSize]
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
      let firstMaximum = first.maximumSize(gap: gap, maximumSizes: maximumSizes)
      let secondMaximum = second.maximumSize(gap: gap, maximumSizes: maximumSizes)
      let firstMax = axis == .vertical ? firstMaximum.width : firstMaximum.height
      let secondMax = axis == .vertical ? secondMaximum.width : secondMaximum.height
      let preferred = floor(available * ratio)
      let lower = max(firstBound, secondMax.map { available - $0 } ?? firstBound)
      let upper = min(firstMax ?? available, available - secondBound)
      let firstLength = min(max(preferred, lower), max(lower, upper))
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
      return first.layout(in: firstFrame, gap: gap, minimumSizes: minimumSizes, maximumSizes: maximumSizes)
        .merging(second.layout(in: secondFrame, gap: gap, minimumSizes: minimumSizes, maximumSizes: maximumSizes)) { first, _ in
          first
        }
    }
  }

  fileprivate func maximumSize(
    gap: Double, maximumSizes: [WorkspaceWindowID: WorkspaceMaximumSize]
  ) -> WorkspaceMaximumSize {
    switch self {
    case .leaf(let id): return maximumSizes[id] ?? .init()
    case .split(let axis, _, let first, let second):
      let a = first.maximumSize(gap: gap, maximumSizes: maximumSizes)
      let b = second.maximumSize(gap: gap, maximumSizes: maximumSizes)
      if axis == .vertical {
        let width = a.width.flatMap { av in b.width.map { av + gap + $0 } }
        let height = [a.height, b.height].compactMap { $0 }.min()
        return .init(width: width, height: height)
      }
      let width = [a.width, b.width].compactMap { $0 }.min()
      let height = a.height.flatMap { av in b.height.map { av + gap + $0 } }
      return .init(width: width, height: height)
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
