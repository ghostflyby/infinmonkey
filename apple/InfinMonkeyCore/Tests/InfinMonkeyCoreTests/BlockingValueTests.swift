import Foundation
import Testing

@testable import InfinMonkeyCore

/// The synchronous bridge the command-line entry point needs.
///
/// `main.swift` must not be `async` (the GUI branch hands the thread to
/// SwiftUI), so the command modes run their async work to completion before
/// returning. This is the primitive that does it, and it is easy to get subtly
/// wrong — a value that arrives after the wait, or a body that never completes —
/// so both the value and the completion are asserted here rather than inferred
/// from the fact that the CLI produces output.
@Suite("Blocking value")
struct BlockingValueTests {

  @Test("the body's value is returned")
  func returnsValue() {
    #expect(blockingValue { 42 } == 42)
  }

  @Test("a body that suspends still completes before returning")
  func waitsForAsyncWork() {
    // A semaphore ordering bug shows up as a lost write, not as a hang, when the
    // body only signals without waiting.
    let result = blockingValue {
      try? await Task.sleep(nanoseconds: 20_000_000)
      return "after-suspension"
    }
    #expect(result == "after-suspension")
  }

  @Test("work started in the body is finished when the call returns")
  func bodyEffectsAreVisible() {
    let box = MutexBox()
    let observed = blockingValue {
      for index in 0..<100 { box.append(index) }
      return box.count
    }
    #expect(observed == 100)
    #expect(box.count == 100)
  }

  @Test("a throw is carried through as an optional result")
  func failureIsRepresentable() {
    let failure = blockingValue { () -> String? in
      try? await failingWork()
    }
    #expect(failure == nil)
  }

  private func failingWork() async throws -> String {
    throw CancellationError()
  }

  /// A mutable box the body can write to, so the test observes the bridge's
  /// ordering rather than a value it computed itself.
  private final class MutexBox: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Int] = []

    func append(_ value: Int) {
      lock.lock()
      values.append(value)
      lock.unlock()
    }

    var count: Int {
      lock.lock()
      defer { lock.unlock() }
      return values.count
    }
  }
}
