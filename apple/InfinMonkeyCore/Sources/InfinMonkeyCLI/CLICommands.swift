import ArgumentParser
import Foundation
import InfinMonkeyCore

/// The management command line's syntax.
///
/// Only the shape lives here — command names, arguments, help text — so parsing
/// and usage errors come from the library instead of from hand-written argument
/// scanning. Executing a parsed command is `ManagementCLI`'s job, which keeps
/// the store and the output streams injectable rather than having a command
/// reach for globals.
///
/// These commands deliberately do not implement `run()`: the entry point parses,
/// maps the result to `Invocation`, and hands that to the executor. One code
/// path then serves the real process and the tests, and a command cannot
/// accidentally acquire its own I/O or store.

struct InfinMonkeyCommand: ParsableCommand {
  static let configuration = CommandConfiguration(
    commandName: "infinmonkey",
    abstract: "Inspect and manage the InfinMonkey library.",
    version: CoreConstants.storeVersionString,
    subcommands: [Version.self, Status.self, List.self, Export.self, ImportEntry.self])
}

struct Version: ParsableCommand {
  static let configuration = CommandConfiguration(
    abstract: "Protocol and store versions this build speaks.")
}

struct Status: ParsableCommand {
  static let configuration = CommandConfiguration(
    abstract: "Store location, revision, and entry counts.")
}

struct List: ParsableCommand {
  static let configuration = CommandConfiguration(
    abstract: "Entries with id, kind, name, and enabled state, as JSON.")
}

struct Export: ParsableCommand {
  static let configuration = CommandConfiguration(
    abstract: "The export bundle, written to stdout.")
}

struct ImportEntry: ParsableCommand {
  static let configuration = CommandConfiguration(
    commandName: "import",
    abstract: "Read a bundle or one entry from stdin.",
    discussion: """
      The name says what stdin carries, because a pipe has no path to read it \
      from: a bundle (any name ending in .json, which is also the default) or a \
      single entry (.user.js / .user.css). Passing a path is not supported — the \
      app is sandboxed and cannot open arbitrary files — but a shell redirect \
      works, since the descriptor is opened by the shell rather than by us.
      """)

  @Argument(help: "Name describing what stdin carries; defaults to a bundle.")
  var fileName: String?

  @Flag(name: .long, help: "Replace the library instead of merging into it.")
  var replace = false
}

/// What the arguments asked for, independent of how they were spelled.
///
/// The executor switches on this, so argument parsing and argument *meaning* stay
/// separable: a test can build an `Invocation` directly, and a new flag changes
/// only this file plus its command.
enum Invocation: Sendable, Equatable {
  case version
  case status
  case list
  case export
  case importPayload(fileName: String?, replace: Bool)

  /// Maps a parsed command, or nil when the parse produced something this build
  /// does not execute (the root itself, or the generated `help` command).
  init?(_ command: ParsableCommand) {
    switch command {
    case is Version: self = .version
    case is Status: self = .status
    case is List: self = .list
    case is Export: self = .export
    case let command as ImportEntry:
      self = .importPayload(fileName: command.fileName, replace: command.replace)
    default: return nil
    }
  }
}
