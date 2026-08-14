import WMWorkspace

let workspace = Workspace(
    name: "verify",
    origin: .configured,
    displayID: "display",
    margin: .init(top: 10, right: 20, bottom: 30, left: 40),
    gap: 8,
    windowIDs: ["a", "b", "c"],
    bsp: .init(root: .split(
        axis: .vertical,
        ratio: 0.5,
        first: .leaf(windowID: "a"),
        second: .split(
            axis: .horizontal,
            ratio: 0.5,
            first: .leaf(windowID: "b"),
            second: .leaf(windowID: "c")
        )
    ))
)

let layout = workspace.layout(in: .init(x: 0, y: 0, width: 1000, height: 800))
precondition(layout["a"] == .init(x: 40, y: 10, width: 466, height: 760))
precondition(layout["b"] == .init(x: 514, y: 10, width: 466, height: 376))
precondition(layout["c"] == .init(x: 514, y: 394, width: 466, height: 376))
print("workspace layout verification passed")
