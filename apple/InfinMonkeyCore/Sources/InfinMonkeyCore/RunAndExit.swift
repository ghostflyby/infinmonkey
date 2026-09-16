import Foundation

/// Runs an async operation to completion and terminates the process with its
/// exit code. Called from the entry points, which cannot `await` themselves.
///
/// `main.swift` must reach SwiftUI's `main()` synchronously for the GUI branch,
/// so the command modes cannot simply be `await`ed from the entry point. They
/// also must not be driven by blocking the entry thread: parking a thread in
/// `wait()` while the work needs a task to run deadlocks once the number of
/// concurrent callers reaches the size of the task pool, and Swift Testing —
/// which runs each suite as a task on that pool — hits exactly that on a machine
/// with few cores.
///
/// So nothing blocks. The work is handed to a task and the calling thread joins
/// the dispatch main queue, which keeps the process alive without occupying a
/// pool thread. `dispatchMain()` never returns, hence `Never`: the process ends
/// via `exit`, which is what a command line tool does regardless.
public func runToCompletionAndExit(_ work: @escaping @Sendable () async -> Int32) -> Never {
  Task {
    let code = await work()
    // stdout is block-buffered when it is a pipe, so a buffered line would be
    // lost when `exit` skips the normal teardown.
    fflush(stdout)
    exit(code)
  }
  dispatchMain()
}
