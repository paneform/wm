import Foundation

public enum WorkspaceMode: String, Codable, Sendable { case bsp, floating }
public enum WindowBehavior: String, Codable, Sendable { case tiled, floating }
public enum ResistantWindowPolicy: String, Codable, Sendable { case float, ignore }

public struct WorkspaceSettings: Codable, Equatable, Sendable {
    public var preferredDisplay: String?
    public var mode: WorkspaceMode?
    public var margin: Double?
    public var gap: Double?
    public var resizeIncrement: Double?

    public init(preferredDisplay: String? = nil, mode: WorkspaceMode? = nil, margin: Double? = nil, gap: Double? = nil, resizeIncrement: Double? = nil) {
        self.preferredDisplay = preferredDisplay; self.mode = mode; self.margin = margin; self.gap = gap
        self.resizeIncrement = resizeIncrement
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case preferredDisplay = "preferred_display", mode, margin, gap
        case resizeIncrement = "resize_increment"
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknown(decoder, allowed: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        preferredDisplay = try values.decodeIfPresent(String.self, forKey: .preferredDisplay)
        mode = try values.decodeIfPresent(WorkspaceMode.self, forKey: .mode)
        margin = try values.decodeIfPresent(Double.self, forKey: .margin)
        gap = try values.decodeIfPresent(Double.self, forKey: .gap)
        resizeIncrement = try values.decodeIfPresent(Double.self, forKey: .resizeIncrement)
    }

    func inheriting(_ defaults: Self) -> Self {
        Self(preferredDisplay: preferredDisplay ?? defaults.preferredDisplay, mode: mode ?? defaults.mode,
             margin: margin ?? defaults.margin, gap: gap ?? defaults.gap,
             resizeIncrement: resizeIncrement ?? defaults.resizeIncrement)
    }
}

public struct WorkspaceConfiguration: Codable, Equatable, Sendable {
    public var name: String
    public var settings: WorkspaceSettings

    public init(name: String, settings: WorkspaceSettings = .init()) { self.name = name; self.settings = settings }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case name, preferredDisplay = "preferred_display", mode, margin, gap
        case resizeIncrement = "resize_increment"
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknown(decoder, allowed: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decode(String.self, forKey: .name)
        settings = WorkspaceSettings(
            preferredDisplay: try values.decodeIfPresent(String.self, forKey: .preferredDisplay),
            mode: try values.decodeIfPresent(WorkspaceMode.self, forKey: .mode),
            margin: try values.decodeIfPresent(Double.self, forKey: .margin),
            gap: try values.decodeIfPresent(Double.self, forKey: .gap),
            resizeIncrement: try values.decodeIfPresent(Double.self, forKey: .resizeIncrement)
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
    public func encode(to encoder: Encoder) throws { fatalError("configuration encoding is not supported") }

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
    public var defaults: WorkspaceSettings; public var workspaces: [WorkspaceConfiguration]; public var rules: [WindowRule]
    public var hotload: Bool; public var port: UInt16
    enum CodingKeys: String, CodingKey, CaseIterable { case defaults, workspaces, rules, hotload, port }
    public init(defaults: WorkspaceSettings = .init(mode: .bsp, margin: 0, gap: 0, resizeIncrement: 10), workspaces: [WorkspaceConfiguration] = [], rules: [WindowRule] = [], hotload: Bool = true, port: UInt16 = 17_832) { self.defaults = defaults; self.workspaces = workspaces; self.rules = rules; self.hotload = hotload; self.port = port }
    public init(from decoder: Decoder) throws {
        try rejectUnknown(decoder, allowed: CodingKeys.allCases.map(\.rawValue)); let c = try decoder.container(keyedBy: CodingKeys.self)
        defaults = try c.decodeIfPresent(WorkspaceSettings.self, forKey: .defaults) ?? .init(mode: .bsp, margin: 0, gap: 0, resizeIncrement: 10)
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
        for value in [defaults.margin, defaults.gap, defaults.resizeIncrement].compactMap({ $0 }) where !value.isFinite || value < 0 { throw ConfigurationError.invalid("workspace measurements must be finite and non-negative") }
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

    public static let schema = ##"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,"properties":{"defaults":{"$ref":"#/$defs/settings"},"workspaces":{"type":"array"},"rules":{"type":"array"},"hotload":{"type":"boolean","default":true},"port":{"type":"integer","minimum":1,"maximum":65535,"default":17832}},"$defs":{"settings":{"type":"object","additionalProperties":false}}}"##
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
