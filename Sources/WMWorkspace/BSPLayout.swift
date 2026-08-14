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
}

private extension BSPNode {
    func layout(
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
            let secondLength = available - firstLength
            let firstFrame: WorkspaceLayoutRect
            let secondFrame: WorkspaceLayoutRect
            if axis == .vertical {
                firstFrame = .init(x: frame.x, y: frame.y, width: firstLength, height: frame.height)
                secondFrame = .init(x: frame.x + firstLength + gap, y: frame.y, width: secondLength, height: frame.height)
            } else {
                firstFrame = .init(x: frame.x, y: frame.y, width: frame.width, height: firstLength)
                secondFrame = .init(x: frame.x, y: frame.y + firstLength + gap, width: frame.width, height: secondLength)
            }
            return first.layout(in: firstFrame, gap: gap, minimumSizes: minimumSizes)
                .merging(second.layout(in: secondFrame, gap: gap, minimumSizes: minimumSizes)) { first, _ in first }
        }
    }

    func minimumSize(
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
