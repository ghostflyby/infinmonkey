import Foundation

/// Runs an async operation to completion on the calling thread.
///
/// The entry point (`main.swift`) must stay synchronous until the GUI branch:
/// SwiftUI's `main()` installs the application run loop, and entering that from
/// an async context is a risk this entry point has no reason to take. The
/// command modes are short-lived processes that exit anyway, so blocking the
/// entry thread while a detached task does the work costs nothing and is what a
/// command line tool does regardless.
///
/// The body runs on the global executor, so nothing in it may require the main
/// actor — the store and the router are actors of their own, which satisfies
/// this.
func blockingValue<T: Sendable>(_ body: @escaping @Sendable () async -> T) -> T {
  let box = ValueBox<T>()
  let done = DispatchSemaphore(value: 0)
  Task.detached {
    box.store(await body())
    done.signal()
  }
  done.wait()
  return box.take()
}

/// Carries one value from the detached task back to the waiting thread.
///
/// The semaphore is what orders the two accesses (the wait cannot return before
/// `store` has run), so the handoff is safe; the lock exists only because the
/// compiler cannot see that edge, and `@unchecked` states it rather than
/// pretending the class is generally safe to share.
private final class ValueBox<T: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: T?

  func store(_ newValue: T) {
    lock.lock()
    value = newValue
    lock.unlock()
  }

  func take() -> T {
    lock.lock()
    defer { lock.unlock() }
    guard let value else { preconditionFailure("blocking run produced no value") }
    return value
  }
}
