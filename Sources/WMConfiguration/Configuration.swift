import Foundation

public enum WorkspaceMode: String, Codable, Sendable { case bsp, floating }
public enum WindowBehavior: String, Codable, Sendable { case tiled, floating }
public enum ResistantWindowPolicy: String, Codable, Sendable { case float, ignore }
public enum UncooperativeWindowPolicy: String, Codable, CaseIterable, Sendable { case greedy, stack, overlap, reject }
public enum GeometryProfileMode: String, Codable, CaseIterable, Sendable { case store, infer, optimistic }

public struct DisplayAffinity: Codable, Equatable, Hashable, Sendable {
    public var id: String?
    public var coreGraphicsDisplayID: String?
    public var nsScreenNumber: String?
    public var name: String?

    public init(id: String? = nil, coreGraphicsDisplayID: String? = nil, nsScreenNumber: String? = nil, name: String? = nil) {
        self.id = id; self.coreGraphicsDisplayID = coreGraphicsDisplayID
        self.nsScreenNumber = nsScreenNumber; self.name = name
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case id, name
        case coreGraphicsDisplayID = "core_graphics_display_id"
        case nsScreenNumber = "ns_screen_number"
    }

    public init(from decoder: Decoder) throws {
        if let value = try? decoder.singleValueContainer().decode(String.self) {
            self.init(id: value); return
        }
        try rejectUnknown(decoder, allowed: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try values.decodeIfPresent(String.self, forKey: .id),
            coreGraphicsDisplayID: try values.decodeIfPresent(String.self, forKey: .coreGraphicsDisplayID),
            nsScreenNumber: try values.decodeIfPresent(String.self, forKey: .nsScreenNumber),
            name: try values.decodeIfPresent(String.self, forKey: .name)
        )
    }

    public func encode(to encoder: Encoder) throws {
        if let id, coreGraphicsDisplayID == nil, nsScreenNumber == nil, name == nil {
            var value = encoder.singleValueContainer(); try value.encode(id); return
        }
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(id, forKey: .id)
        try values.encodeIfPresent(coreGraphicsDisplayID, forKey: .coreGraphicsDisplayID)
        try values.encodeIfPresent(nsScreenNumber, forKey: .nsScreenNumber)
        try values.encodeIfPresent(name, forKey: .name)
    }
}

public struct WorkspaceMargins: Codable, Equatable, Sendable {
    public var top: Double?; public var right: Double?; public var bottom: Double?; public var left: Double?
    public init(top: Double? = nil, right: Double? = nil, bottom: Double? = nil, left: Double? = nil) {
        self.top = top; self.right = right; self.bottom = bottom; self.left = left
    }
    enum CodingKeys: String, CodingKey, CaseIterable { case top, right, bottom, left }
    public init(from decoder: Decoder) throws {
        try rejectUnknown(decoder, allowed: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        top = try values.decodeIfPresent(Double.self, forKey: .top)
        right = try values.decodeIfPresent(Double.self, forKey: .right)
        bottom = try values.decodeIfPresent(Double.self, forKey: .bottom)
        left = try values.decodeIfPresent(Double.self, forKey: .left)
    }
    public func inheriting(_ defaults: Self) -> Self {
        Self(top: top ?? defaults.top, right: right ?? defaults.right,
             bottom: bottom ?? defaults.bottom, left: left ?? defaults.left)
    }
}

public struct WorkspaceSettings: Codable, Equatable, Sendable {
    public var preferredDisplay: DisplayAffinity?
    public var mode: WorkspaceMode?
    public var margin: WorkspaceMargins?
    public var gap: Double?
    public var resizeIncrement: Double?
    public var uncooperativeWindowPolicy: UncooperativeWindowPolicy?
    public var maxGeometryRetries: Int?
    public var geometryProfileMode: GeometryProfileMode?

    public init(preferredDisplay: DisplayAffinity? = nil, mode: WorkspaceMode? = nil, margin: WorkspaceMargins? = nil, gap: Double? = nil, resizeIncrement: Double? = nil, uncooperativeWindowPolicy: UncooperativeWindowPolicy? = nil, maxGeometryRetries: Int? = nil, geometryProfileMode: GeometryProfileMode? = nil) {
        self.preferredDisplay = preferredDisplay; self.mode = mode; self.margin = margin; self.gap = gap
        self.resizeIncrement = resizeIncrement
        self.uncooperativeWindowPolicy = uncooperativeWindowPolicy
        self.maxGeometryRetries = maxGeometryRetries
        self.geometryProfileMode = geometryProfileMode
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case preferredDisplay = "preferred_display", mode, margin, gap
        case resizeIncrement = "resize_increment"
        case uncooperativeWindowPolicy = "uncooperative_window_policy"
        case maxGeometryRetries = "max_geometry_retries"
        case geometryProfileMode = "geometry_profile_mode"
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknown(decoder, allowed: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        preferredDisplay = try values.decodeIfPresent(DisplayAffinity.self, forKey: .preferredDisplay)
        mode = try values.decodeIfPresent(WorkspaceMode.self, forKey: .mode)
        margin = try values.decodeIfPresent(WorkspaceMargins.self, forKey: .margin)
        gap = try values.decodeIfPresent(Double.self, forKey: .gap)
        resizeIncrement = try values.decodeIfPresent(Double.self, forKey: .resizeIncrement)
        uncooperativeWindowPolicy = try values.decodeIfPresent(UncooperativeWindowPolicy.self, forKey: .uncooperativeWindowPolicy)
        maxGeometryRetries = try values.decodeIfPresent(Int.self, forKey: .maxGeometryRetries)
        geometryProfileMode = try values.decodeIfPresent(GeometryProfileMode.self, forKey: .geometryProfileMode)
    }

    func inheriting(_ defaults: Self) -> Self {
        Self(preferredDisplay: preferredDisplay ?? defaults.preferredDisplay, mode: mode ?? defaults.mode,
             margin: margin.map { $0.inheriting(defaults.margin ?? .init()) } ?? defaults.margin, gap: gap ?? defaults.gap,
             resizeIncrement: resizeIncrement ?? defaults.resizeIncrement,
             uncooperativeWindowPolicy: uncooperativeWindowPolicy ?? defaults.uncooperativeWindowPolicy,
             maxGeometryRetries: maxGeometryRetries ?? defaults.maxGeometryRetries,
             geometryProfileMode: geometryProfileMode ?? defaults.geometryProfileMode)
    }
}

public struct WorkspaceConfiguration: Codable, Equatable, Sendable {
    public var name: String
    public var settings: WorkspaceSettings

    public init(name: String, settings: WorkspaceSettings = .init()) { self.name = name; self.settings = settings }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case name, preferredDisplay = "preferred_display", mode, margin, gap
        case resizeIncrement = "resize_increment"
        case uncooperativeWindowPolicy = "uncooperative_window_policy"
        case maxGeometryRetries = "max_geometry_retries"
        case geometryProfileMode = "geometry_profile_mode"
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknown(decoder, allowed: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decode(String.self, forKey: .name)
        settings = WorkspaceSettings(
            preferredDisplay: try values.decodeIfPresent(DisplayAffinity.self, forKey: .preferredDisplay),
            mode: try values.decodeIfPresent(WorkspaceMode.self, forKey: .mode),
            margin: try values.decodeIfPresent(WorkspaceMargins.self, forKey: .margin),
            gap: try values.decodeIfPresent(Double.self, forKey: .gap),
            resizeIncrement: try values.decodeIfPresent(Double.self, forKey: .resizeIncrement)
            , uncooperativeWindowPolicy: try values.decodeIfPresent(UncooperativeWindowPolicy.self, forKey: .uncooperativeWindowPolicy),
            maxGeometryRetries: try values.decodeIfPresent(Int.self, forKey: .maxGeometryRetries),
            geometryProfileMode: try values.decodeIfPresent(GeometryProfileMode.self, forKey: .geometryProfileMode)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(name, forKey: .name)
        try values.encodeIfPresent(settings.preferredDisplay, forKey: .preferredDisplay)
        try values.encodeIfPresent(settings.mode, forKey: .mode)
        try values.encodeIfPresent(settings.margin, forKey: .margin)
        try values.encodeIfPresent(settings.gap, forKey: .gap)
        try values.encodeIfPresent(settings.resizeIncrement, forKey: .resizeIncrement)
        try values.encodeIfPresent(settings.uncooperativeWindowPolicy, forKey: .uncooperativeWindowPolicy)
        try values.encodeIfPresent(settings.maxGeometryRetries, forKey: .maxGeometryRetries)
        try values.encodeIfPresent(settings.geometryProfileMode, forKey: .geometryProfileMode)
    }
}

public struct DisplayConfiguration: Codable, Equatable, Sendable {
    public var display: DisplayAffinity
    public var margin: WorkspaceMargins?
    public var gap: Double?

    public init(display: DisplayAffinity, margin: WorkspaceMargins? = nil, gap: Double? = nil) {
        self.display = display; self.margin = margin; self.gap = gap
    }

    enum CodingKeys: String, CodingKey, CaseIterable { case display, margin, gap }

    public init(from decoder: Decoder) throws {
        try rejectUnknown(decoder, allowed: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        display = try values.decode(DisplayAffinity.self, forKey: .display)
        margin = try values.decodeIfPresent(WorkspaceMargins.self, forKey: .margin)
        gap = try values.decodeIfPresent(Double.self, forKey: .gap)
    }
}

public enum StringOperator: String, Codable, Sendable { case exact, contains, regex }
public enum WindowProperty: String, Codable, Sendable {
    case bundleID = "bundle_id", executablePath = "executable_path", executableName = "executable_name"
    case processID = "process_id", title, role, subrole
}

public struct WindowDescriptor: Equatable, Sendable {
    public var bundleID: String?; public var executablePath: String?; public var processID: Int32
    public var title: String?; public var role: String?; public var subrole: String?
    public init(bundleID: String? = nil, executablePath: String? = nil, processID: Int32, title: String? = nil, role: String? = nil, subrole: String? = nil) {
        self.bundleID = bundleID; self.executablePath = executablePath; self.processID = processID
        self.title = title; self.role = role; self.subrole = subrole
    }
}

public indirect enum RuleMatch: Codable, Equatable, Sendable {
    case value(property: WindowProperty, operator: StringOperator, value: String, caseSensitive: Bool)
    case all([RuleMatch]), any([RuleMatch]), not(RuleMatch)

    enum Keys: String, CodingKey { case property, `operator`, value, caseSensitive = "case_sensitive", all, any, not }
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode([String: JSONValue].self)
        if let value = raw["all"] { try ensureOnly(raw, ["all"]); self = .all(try value.decode([RuleMatch].self)); return }
        if let value = raw["any"] { try ensureOnly(raw, ["any"]); self = .any(try value.decode([RuleMatch].self)); return }
        if let value = raw["not"] { try ensureOnly(raw, ["not"]); self = .not(try value.decode(RuleMatch.self)); return }
        try ensureOnly(raw, ["property", "operator", "value", "case_sensitive"])
        guard case .string(let property)? = raw["property"], let property = WindowProperty(rawValue: property),
              case .string(let operation)? = raw["operator"], let operation = StringOperator(rawValue: operation),
              case .string(let value)? = raw["value"] else { throw ConfigurationError.invalid("invalid rule matcher") }
        let sensitive = raw["case_sensitive"] == .bool(true)
        if operation == .regex { _ = try NSRegularExpression(pattern: value) }
        self = .value(property: property, operator: operation, value: value, caseSensitive: sensitive)
    }
    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: Keys.self)
        switch self {
        case .value(let property, let operation, let value, let caseSensitive):
            try values.encode(property, forKey: .property)
            try values.encode(operation, forKey: .operator)
            try values.encode(value, forKey: .value)
            if caseSensitive { try values.encode(true, forKey: .caseSensitive) }
        case .all(let matches): try values.encode(matches, forKey: .all)
        case .any(let matches): try values.encode(matches, forKey: .any)
        case .not(let match): try values.encode(match, forKey: .not)
        }
    }

    public func matches(_ window: WindowDescriptor) -> Bool {
        switch self {
        case let .all(values): return !values.isEmpty && values.allSatisfy { $0.matches(window) }
        case let .any(values): return values.contains { $0.matches(window) }
        case let .not(value): return !value.matches(window)
        case let .value(property, operation, expected, sensitive):
            let actual: String?
            switch property {
            case .bundleID: actual = window.bundleID
            case .executablePath: actual = window.executablePath
            case .executableName: actual = window.executablePath.map { URL(fileURLWithPath: $0).lastPathComponent }
            case .processID: actual = String(window.processID)
            case .title: actual = window.title
            case .role: actual = window.role
            case .subrole: actual = window.subrole
            }
            guard let actual else { return false }
            let options: String.CompareOptions = sensitive ? [] : [.caseInsensitive]
            switch operation {
            case .exact: return actual.compare(expected, options: options) == .orderedSame
            case .contains: return actual.range(of: expected, options: options) != nil
            case .regex:
                let options: NSRegularExpression.Options = sensitive ? [] : [.caseInsensitive]
                return (try? NSRegularExpression(pattern: expected, options: options).firstMatch(in: actual, range: NSRange(actual.startIndex..., in: actual))) != nil
            }
        }
    }
}

public struct RuleActions: Codable, Equatable, Sendable {
    public var manage: Bool?; public var workspace: String?; public var behavior: WindowBehavior?
    public var floatingGeometry: String?; public var resistantFallback: ResistantWindowPolicy?; public var workspaceMode: WorkspaceMode?
    enum CodingKeys: String, CodingKey, CaseIterable { case manage, workspace, behavior; case floatingGeometry = "floating_geometry"; case resistantFallback = "resistant_fallback"; case workspaceMode = "workspace_mode" }
    public init(manage: Bool? = nil, workspace: String? = nil, behavior: WindowBehavior? = nil, floatingGeometry: String? = nil, resistantFallback: ResistantWindowPolicy? = nil, workspaceMode: WorkspaceMode? = nil) { self.manage = manage; self.workspace = workspace; self.behavior = behavior; self.floatingGeometry = floatingGeometry; self.resistantFallback = resistantFallback; self.workspaceMode = workspaceMode }
    public init(from decoder: Decoder) throws {
        try rejectUnknown(decoder, allowed: CodingKeys.allCases.map(\.rawValue)); let c = try decoder.container(keyedBy: CodingKeys.self)
        manage = try c.decodeIfPresent(Bool.self, forKey: .manage); workspace = try c.decodeIfPresent(String.self, forKey: .workspace); behavior = try c.decodeIfPresent(WindowBehavior.self, forKey: .behavior); floatingGeometry = try c.decodeIfPresent(String.self, forKey: .floatingGeometry); resistantFallback = try c.decodeIfPresent(ResistantWindowPolicy.self, forKey: .resistantFallback); workspaceMode = try c.decodeIfPresent(WorkspaceMode.self, forKey: .workspaceMode)
    }
}

public struct WindowRule: Codable, Equatable, Sendable {
    public var match: RuleMatch; public var actions: RuleActions
    enum CodingKeys: String, CodingKey, CaseIterable { case match, actions }
    public init(match: RuleMatch, actions: RuleActions) { self.match = match; self.actions = actions }
    public init(from decoder: Decoder) throws { try rejectUnknown(decoder, allowed: CodingKeys.allCases.map(\.rawValue)); let c = try decoder.container(keyedBy: CodingKeys.self); match = try c.decode(RuleMatch.self, forKey: .match); actions = try c.decode(RuleActions.self, forKey: .actions) }
}

public struct Configuration: Codable, Equatable, Sendable {
    public var defaults: WorkspaceSettings; public var displays: [DisplayConfiguration]
    public var workspaces: [WorkspaceConfiguration]; public var rules: [WindowRule]
    public var hotload: Bool; public var port: UInt16
    enum CodingKeys: String, CodingKey, CaseIterable { case defaults, displays, workspaces, rules, hotload, port }
    public init(defaults: WorkspaceSettings = .init(mode: .bsp, margin: .init(top: 0, right: 0, bottom: 0, left: 0), gap: 0, resizeIncrement: 10, uncooperativeWindowPolicy: .greedy, maxGeometryRetries: 5, geometryProfileMode: .store), displays: [DisplayConfiguration] = [], workspaces: [WorkspaceConfiguration] = [], rules: [WindowRule] = [], hotload: Bool = true, port: UInt16 = 17_832) { self.defaults = defaults; self.displays = displays; self.workspaces = workspaces; self.rules = rules; self.hotload = hotload; self.port = port }
    public init(from decoder: Decoder) throws {
        try rejectUnknown(decoder, allowed: CodingKeys.allCases.map(\.rawValue)); let c = try decoder.container(keyedBy: CodingKeys.self)
        defaults = try c.decodeIfPresent(WorkspaceSettings.self, forKey: .defaults) ?? .init(mode: .bsp, margin: .init(top: 0, right: 0, bottom: 0, left: 0), gap: 0, resizeIncrement: 10, uncooperativeWindowPolicy: .greedy, maxGeometryRetries: 5, geometryProfileMode: .store)
        defaults.uncooperativeWindowPolicy = defaults.uncooperativeWindowPolicy ?? .greedy
        defaults.maxGeometryRetries = defaults.maxGeometryRetries ?? 5
        defaults.geometryProfileMode = defaults.geometryProfileMode ?? .store
        displays = try c.decodeIfPresent([DisplayConfiguration].self, forKey: .displays) ?? []
        workspaces = try c.decodeIfPresent([WorkspaceConfiguration].self, forKey: .workspaces) ?? []
        rules = try c.decodeIfPresent([WindowRule].self, forKey: .rules) ?? []
        hotload = try c.decodeIfPresent(Bool.self, forKey: .hotload) ?? true; port = try c.decodeIfPresent(UInt16.self, forKey: .port) ?? 17_832
        try validate()
    }
    public var resolvedWorkspaces: [WorkspaceConfiguration] { workspaces.map { .init(name: $0.name, settings: $0.settings.inheriting(defaults)) } }
    public func actions(for window: WindowDescriptor) -> RuleActions? { rules.first { $0.match.matches(window) }?.actions }
    private func validate() throws {
        guard port > 0 else { throw ConfigurationError.invalid("port must be greater than zero") }
        guard Set(workspaces.map(\.name)).count == workspaces.count, workspaces.allSatisfy({ !$0.name.isEmpty }) else { throw ConfigurationError.invalid("workspace names must be non-empty and unique") }
        let margins = [defaults.margin] + workspaces.map(\.settings.margin) + displays.map(\.margin)
        let measurements = margins.compactMap { $0 }.flatMap { [$0.top, $0.right, $0.bottom, $0.left] }
            + [defaults.gap, defaults.resizeIncrement] + workspaces.flatMap { [$0.settings.gap, $0.settings.resizeIncrement] }
            + displays.map(\.gap)
        for value in measurements.compactMap({ $0 }) where !value.isFinite || value < 0 { throw ConfigurationError.invalid("workspace measurements must be finite and non-negative") }
        for value in ([defaults.maxGeometryRetries] + workspaces.map(\.settings.maxGeometryRetries)).compactMap({ $0 }) where !(1...5).contains(value) {
            throw ConfigurationError.invalid("max_geometry_retries must be between 1 and 5")
        }
        let affinities = ([defaults.preferredDisplay] + workspaces.map(\.settings.preferredDisplay)).compactMap { $0 }
            + displays.map(\.display)
        for affinity in affinities {
            let selectors = [affinity.id, affinity.coreGraphicsDisplayID, affinity.nsScreenNumber, affinity.name].compactMap { $0 }
            guard selectors.count == 1, selectors[0].isEmpty == false else {
                throw ConfigurationError.invalid("preferred_display must contain exactly one non-empty selector")
            }
        }
        let displaySelectors = displays.map(\.display)
        guard Set(displaySelectors).count == displaySelectors.count else {
            throw ConfigurationError.invalid("display selectors must be unique")
        }
    }
}

public enum ConfigurationError: Error, Equatable, CustomStringConvertible { case invalid(String); public var description: String { if case .invalid(let value) = self { value } else { "invalid configuration" } } }

public enum ConfigurationParser {
    public static func parse(_ source: String) throws -> Configuration {
        let data = Data(try stripJSONC(source).utf8)
        do { return try JSONDecoder().decode(Configuration.self, from: data) }
        catch let error as ConfigurationError { throw error }
        catch { throw ConfigurationError.invalid(String(describing: error)) }
    }

    public static let schema = ##"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,"properties":{"defaults":{"$ref":"#/$defs/settings"},"displays":{"type":"array"},"workspaces":{"type":"array"},"rules":{"type":"array"},"hotload":{"type":"boolean","default":true},"port":{"type":"integer","minimum":1,"maximum":65535,"default":17832}},"$defs":{"settings":{"type":"object","additionalProperties":false,"properties":{"uncooperative_window_policy":{"enum":["greedy","stack","overlap","reject"],"default":"greedy"},"max_geometry_retries":{"type":"integer","minimum":1,"maximum":5,"default":5},"geometry_profile_mode":{"enum":["store","infer","optimistic"],"default":"store"}}}}}"##
}

public struct AdoptedWindow: Equatable, Sendable {
    public var executableName: String
    public var workspace: String
    public init(executableName: String, workspace: String) {
        self.executableName = executableName; self.workspace = workspace
    }
}

public enum ConfigurationFile {
    public struct ExampleDisplay: Equatable, Sendable {
        public var id: String
        public var name: String

        public init(id: String, name: String) { self.id = id; self.name = name }
    }

    public static func path(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        let base: URL
        if let configured = environment["XDG_CONFIG_HOME"], configured.hasPrefix("/") {
            base = URL(fileURLWithPath: configured, isDirectory: true)
        } else {
            let home = environment["HOME"] ?? NSHomeDirectory()
            base = URL(fileURLWithPath: home, isDirectory: true).appendingPathComponent(".config", isDirectory: true)
        }
        return base.appendingPathComponent("wm", isDirectory: true).appendingPathComponent("config.jsonc")
    }

    public static func example(displays: [ExampleDisplay] = []) throws -> String {
        let displayOverrides = displays.sorted { ($0.name, $0.id) < ($1.name, $1.id) }.map {
            """
                // \($0.name)
                // {
                //   "display": "\($0.id)",
                //   "margin": {"top": 0, "right": 0, "bottom": 0, "left": 0},
                //   "gap": 0
                // }
            """
        }.joined(separator: ",\n")
        return """
        {
          // Default layout settings inherited by every workspace.
          "defaults": {
            // Layout algorithm used unless a workspace overrides it.
            "mode": "bsp",
            // Give constrained windows their minimum space by taking it from peers.
            "uncooperative_window_policy": "greedy",
            // "uncooperative_window_policy": "stack", // Stack all windows; focused window is front.
            // "uncooperative_window_policy": "overlap", // Keep constrained windows onscreen and allow overlap.
            // "uncooperative_window_policy": "reject", // Restore the source layout and fail the action.
            // Maximum verified geometry attempts per window action (1-5).
            "max_geometry_retries": 5,
            // Store and reuse learned constraints and retry policy.
            "geometry_profile_mode": "store",
            // "geometry_profile_mode": "infer", // Infer constraints on every request; ignore stored profiles.
            // "geometry_profile_mode": "optimistic", // Try the ideal frame first, then fall back to learned constraints.
            // Space between the display work area and tiled windows, in points.
            "margin": {
              // Space along the top edge.
              "top": 0,
              // Space along the right edge.
              "right": 0,
              // Space along the bottom edge.
              "bottom": 0,
              // Space along the left edge.
              "left": 0
            },
            // Space between adjacent tiled windows, in points.
            "gap": 0,
            // Keyboard resize step, in points.
            "resize_increment": 10
          },
          // Per-display layout overrides, selected by ID, CG ID, NSScreen number, or name.
          "displays": [
        \(displayOverrides)
          ],
          // Explicit workspace definitions and per-workspace overrides.
          "workspaces": [],
          // First-match window rules for assignment and behavior.
          "rules": [],
          // Reload this file automatically when it changes.
          "hotload": true,
          // Local WebSocket API port used by the daemon.
          "port": 17832
        }

        """
    }

    public static func encode(_ configuration: Configuration) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(configuration), as: UTF8.self) + "\n"
    }

    public static func load(at path: URL) throws -> Configuration {
        try ConfigurationParser.parse(String(contentsOf: path, encoding: .utf8))
    }

    public static func initialize(
        at path: URL, displays: [ExampleDisplay] = [], fileManager: FileManager = .default
    ) throws {
        guard !fileManager.fileExists(atPath: path.path) else {
            throw ConfigurationError.invalid("config file already exists")
        }
        try fileManager.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(example(displays: displays).utf8).write(to: path, options: .withoutOverwriting)
    }

    public static func adopt(
        _ configuration: Configuration,
        workspaceDisplays: [String: String],
        windows: [AdoptedWindow]
    ) -> Configuration {
        var result = configuration
        let existing = Dictionary(uniqueKeysWithValues: result.workspaces.map { ($0.name, $0) })
        result.workspaces = Set(existing.keys).union(workspaceDisplays.keys).sorted().map { name in
            var workspace = existing[name] ?? WorkspaceConfiguration(name: name)
            if let display = workspaceDisplays[name] { workspace.settings.preferredDisplay = .init(id: display) }
            return workspace
        }

        let assignments = Dictionary(grouping: windows, by: { $0.executableName.lowercased() }).compactMap { _, values -> AdoptedWindow? in
            guard let first = values.sorted(by: { ($0.executableName, $0.workspace) < ($1.executableName, $1.workspace) }).first else { return nil }
            return first
        }.sorted { ($0.executableName.lowercased(), $0.workspace) < ($1.executableName.lowercased(), $1.workspace) }
        let adoptedRules = assignments.map {
            WindowRule(
                match: .value(property: .executableName, operator: .exact, value: $0.executableName, caseSensitive: false),
                actions: .init(workspace: $0.workspace)
            )
        }
        let adoptedNames = Set(assignments.map { $0.executableName.lowercased() })
        result.rules.removeAll { rule in
            guard rule.actions.workspace != nil,
                  case let .value(property, .exact, value, _) = rule.match,
                  property == .executableName || property == .executablePath else { return false }
            let executable = property == .executablePath ? URL(fileURLWithPath: value).lastPathComponent : value
            return adoptedNames.contains(executable.lowercased())
        }
        result.rules.insert(contentsOf: adoptedRules, at: 0)
        return result
    }
}

public struct RuntimeOverlay: Equatable, Sendable { public var workspaceSettings: [String: WorkspaceSettings]; public init(workspaceSettings: [String: WorkspaceSettings] = [:]) { self.workspaceSettings = workspaceSettings } }
public enum ReloadMode: String, Codable, Sendable { case delta, full }
public enum ReloadTrigger: String, Codable, Sendable { case hotload, explicit }
public struct ConfigurationEvent: Equatable, Sendable { public enum Kind: Equatable, Sendable { case applied, rejected }; public var kind: Kind; public var trigger: ReloadTrigger; public var mode: ReloadMode; public var message: String? }
public struct ConfigurationSnapshot: Equatable, Sendable { public var configuration: Configuration?; public var runtimeOverlay: RuntimeOverlay; public var degraded: Bool; public var revision: UInt64; public var events: [ConfigurationEvent] }

public actor ConfigurationStore {
    private var value = ConfigurationSnapshot(configuration: nil, runtimeOverlay: .init(), degraded: false, revision: 0, events: [])
    public init() {}
    public func snapshot() -> ConfigurationSnapshot { value }
    public func setRuntimeOverlay(_ overlay: RuntimeOverlay) { value.runtimeOverlay = overlay }
    @discardableResult public func reload(source: String, trigger: ReloadTrigger = .explicit, mode: ReloadMode? = nil) throws -> ConfigurationSnapshot {
        let selected = mode ?? (trigger == .hotload ? .delta : .full)
        do {
            let candidate = try ConfigurationParser.parse(source)
            if candidate != value.configuration { value.configuration = candidate; value.revision += 1 }
            value.degraded = false; value.events.append(.init(kind: .applied, trigger: trigger, mode: selected, message: nil))
            return value
        } catch {
            if trigger == .hotload { value.degraded = true }
            value.events.append(.init(kind: .rejected, trigger: trigger, mode: selected, message: String(describing: error)))
            throw error
        }
    }
}

public actor ConfigurationWatcher {
    private var lastContents: String?
    public init() {}

    public func poll(
        path: URL,
        read: @Sendable (URL) throws -> String = { try String(contentsOf: $0, encoding: .utf8) },
        apply: @Sendable (Configuration, String) async throws -> Void
    ) async throws {
        let source = try read(path)
        guard source != lastContents else { return }
        let candidate = try ConfigurationParser.parse(source)
        guard candidate.hotload else { lastContents = source; return }
        try await apply(candidate, source)
        lastContents = source
    }
}

private enum JSONValue: Decodable, Equatable { case string(String), bool(Bool), array([JSONValue]), object([String: JSONValue]), number(Double), null
    init(from decoder: Decoder) throws { let c = try decoder.singleValueContainer(); if c.decodeNil() { self = .null } else if let v = try? c.decode(Bool.self) { self = .bool(v) } else if let v = try? c.decode(Double.self) { self = .number(v) } else if let v = try? c.decode(String.self) { self = .string(v) } else if let v = try? c.decode([JSONValue].self) { self = .array(v) } else { self = .object(try c.decode([String: JSONValue].self)) } }
    func decode<T: Decodable>(_ type: T.Type) throws -> T { let data = try JSONSerialization.data(withJSONObject: foundation); return try JSONDecoder().decode(type, from: data) }
    private var foundation: Any { switch self { case .string(let v): v; case .bool(let v): v; case .array(let v): v.map(\.foundation); case .object(let v): v.mapValues(\.foundation); case .number(let v): v; case .null: NSNull() } }
}
private func rejectUnknown(_ decoder: Decoder, allowed: [String]) throws { let c = try decoder.container(keyedBy: AnyKey.self); let unknown = Set(c.allKeys.map(\.stringValue)).subtracting(allowed); if let key = unknown.sorted().first { throw ConfigurationError.invalid("unknown field: \(key)") } }
private func ensureOnly(_ values: [String: JSONValue], _ allowed: Set<String>) throws { if let key = Set(values.keys).subtracting(allowed).sorted().first { throw ConfigurationError.invalid("unknown matcher field: \(key)") } }
private struct AnyKey: CodingKey { var stringValue: String; var intValue: Int?; init?(stringValue: String) { self.stringValue = stringValue }; init?(intValue: Int) { self.stringValue = String(intValue); self.intValue = intValue } }
private func stripJSONC(_ source: String) throws -> String {
    var output = "", index = source.startIndex, quoted = false, escaped = false
    while index < source.endIndex {
        let character = source[index], next = source.index(after: index)
        if quoted { output.append(character); if escaped { escaped = false } else if character == "\\" { escaped = true } else if character == "\"" { quoted = false }; index = next; continue }
        if character == "\"" { quoted = true; output.append(character); index = next; continue }
        if character == "/", next < source.endIndex, source[next] == "/" { index = source[next...].firstIndex(of: "\n") ?? source.endIndex; continue }
        if character == "/", next < source.endIndex, source[next] == "*" { guard let end = source[next...].range(of: "*/") else { throw ConfigurationError.invalid("unterminated block comment") }; index = end.upperBound; continue }
        output.append(character); index = next
    }
    guard !quoted else { throw ConfigurationError.invalid("unterminated string") }
    return output
}
