import Foundation
import WMConfiguration
import WMProtocol

public let CLIConfigHelp = """
wm config - manage window manager configuration

USAGE
  wm config <command>

COMMANDS
  help          Show this help.
  validate      Validate the config file.
  example       Print a minimal example with default values.
  init          Create the config file without overwriting an existing file.
  adopt-state   Adopt current workspace/display and window/workspace affinities.
  reload        Reload the config in the daemon.
"""

enum ConfigCommandError: Error, CustomStringConvertible {
    case missing(URL)
    case invalidState

    var description: String {
        switch self {
        case .missing(let path): "config file not found; expected at \(path.path)"
        case .invalidState: "daemon returned an invalid state payload"
        }
    }
}
