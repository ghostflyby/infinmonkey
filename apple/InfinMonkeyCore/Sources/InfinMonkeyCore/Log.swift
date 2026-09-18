import Foundation

/// Severity of a diagnostic, named after `os.Logger`'s levels.
public enum LogLevel: String, Sendable {
  case debug
  case info
  case notice
  case warning
  case error
  case fault
}

/// Where the stdio roles send diagnostics: the native messaging host session
/// and the management command line.
///
/// A sink rather than `os.Logger`, because of where the reader is: the browsers
/// forward a host's stderr to the extension console, which is where a host
/// failure is meant to be read, and a command line's diagnostics belong on the
/// terminal. The unified logging system `os.Logger` writes to surfaces in
/// neither place. It would also not serve the tests: its methods take
/// interpolated literals rather than runtime-built messages, and its output
/// cannot be captured in-process — which is why this seam is injected.
/// Process-resident components (the GUI app, the extension bridge) are read
/// through Console.app and use `os.Logger` directly.
///
/// The level is the structured part: the sink receives it separately from the
/// message, so a capturing test asserts on severity without parsing text.
public typealias LogSink = @Sendable (LogLevel, String) -> Void

/// A sink writing `label: level: message` lines to stderr.
///
/// `label` is the program name as the reader should see it (`infinmonkey host`,
/// `infinmonkey`), so call sites carry only what happened.
public func stderrLog(label: String) -> LogSink {
  { level, message in
    FileHandle.standardError.write(
      Data("\(label): \(level.rawValue): \(message)\n".utf8))
  }
}
