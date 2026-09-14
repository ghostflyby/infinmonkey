# AGENTS.md — Apple native side

Guidance for agents working in `apple/` (the native app for macOS and iOS) and on
`InfinMonkey.xcodeproj` at the repository root. The root `AGENTS.md` still applies: English for all
non-localized content, Chinese for user-facing UI copy.

## Layout and ownership

```
InfinMonkey.xcodeproj/          project file at the repo root (so dist/ stays inside the container)
apple/
  InfinMonkeyCore/              local Swift package: all non-UI logic, unit-testable on its own
  Shared (App)/                 sources compiled into BOTH app targets
  Shared (Extension)/           sources compiled into BOTH extension targets
  iOS (App)/  iOS (Extension)/  per-platform sources + Info.plist + entitlements
  macOS (App)/  macOS (Extension)/
```

Every target-specific file (Info.plist, entitlements) lives in that target's own folder. Shared
folders hold only code that genuinely compiles for both platforms — platform differences are
`#if os(...)` blocks or per-platform files, never a diverging copy of the same file.

## Core versus UI

`apple/InfinMonkeyCore` holds everything that is not UI and not UI-adjacent: the store, the wire
protocol types, metadata modeling, and the library operations. The app targets hold only views,
view models, and platform glue.

- Core must not import SwiftUI or AppKit/UIKit.
- Anything worth asserting goes in Core, so it is covered by `swift test` rather than by driving the
  GUI. Fault-prone logic (merging, revision tracking, file reconciliation, protocol dispatch) lives
  behind protocols so tests can substitute a fake.
- The app's view model is a thin facade over Core: it holds observable state and calls Core methods.

## Data modeling

Two representations, picked by whether the native side must perceive structure:

1. **Native needs the structure → a concrete `Codable` type.** `ScriptMeta`, `EntrySource`, the
   entry record, protocol frames. Decode once at the boundary and fail loudly there: a field present
   with the wrong type is an error, not a silently substituted default. Never thread
   `[String: Any]` through the implementation to avoid writing a type.

2. **Semantics-free payload → keep it opaque.** GM values are a `Record<string, unknown>` on the
   extension side and mean nothing to the storage layer, so the native side must not model,
   validate, interpret, or reorder them. Carry them as raw JSON (`Data`, or a JSON string) and pass
   the bytes through unchanged; `JSONSerialization` is acceptable here purely as a transport
   encoding. Encoding an opaque payload through a typed model would drop fields a newer extension
   added.

The only place `Any` is unavoidable is the Safari app extension boundary
(`NSExtensionItem.userInfo` is `[AnyHashable: Any]`). Convert to concrete types immediately at that
entry point — that conversion is the single place where untyped data may exist.

`meta` is the boundary case that falls under rule 1: the app shows name, version, and description,
so it needs the structure. An empty `meta` object (`{}`) is the extension's marker for "not parsed
yet" — preserve it as such through reads and writes rather than filling in defaults.

Because `meta` is typed on both sides, a new parsed field is a schema change on both sides at once:
bump the protocol version and update both the Swift type and `packages/shared/src/types.ts` in the
same change. Unknown *header* directives are already preserved losslessly — the extension parks
unrecognized `@key` lines in `others` rather than dropping them.

## Concurrency

Shared mutable state is an `actor`, not a lock. The store is entered only through `await`, and file
locking stays a separate concern: the actor serializes access within one process, `flock` on the
store's lock file serializes it across processes (app, extension, host are separate processes).

Both the package and the app targets build in **Swift 6 language mode**, so strict concurrency is
enforced (a nonisolated mutable global is an error, not a warning). The difference is the default
isolation:

| | Language mode | Default isolation |
|---|---|---|
| `apple/InfinMonkeyCore` | 6 | **nonisolated** |
| app targets | 6 | `MainActor` |

That asymmetry is deliberate. Library code must not be pinned to the main actor by default — the
extension handler and a future stdio host call it off the main actor — so isolation in the package
is explicit (actors own state, value types are `Sendable`). App targets are UI, so MainActor-by-
default is right for them. Do not "fix" the difference by adding `-default-isolation=MainActor` to
the package.

Under Swift 6 with MainActor-by-default, `ObservableObject` cannot synthesize its conformance
(`objectWillChange` is required to be nonisolated). Use `@Observable` in SwiftUI instead — which is
why the app's deployment target is iOS 17 / macOS 14, and why the package declares the same floor.

A consequence worth internalizing: untyped data cannot cross into actor isolation. The protocol
router speaks `Data`, not `[String: Any]`, for exactly this reason.

## Identity tree

One literal, everything derived. `BASE_BUNDLE_ID` is the single source in the project's build
settings; target identifiers interpolate from it, and `APP_GROUP_ID` is
`$(TeamIdentifierPrefix)group.$(BASE_BUNDLE_ID)`.

Runtime code never hardcodes an identity. The app group ID reaches code through an Info.plist
passthrough key that is populated from the `APP_GROUP_ID` build setting; code reads that key and
treats a missing key as a build configuration error. This matters because
`$(TeamIdentifierPrefix)` is empty in unsigned builds but becomes the real team prefix once signed —
a literal compiled into the binary silently stops matching the entitlement at that point and the
processes end up in different containers.

Two-tier resolution is deliberate: a missing passthrough key is a hard failure, while a present key
whose container cannot be opened (unsigned developer builds, where `CODE_SIGNING_ALLOWED=NO` embeds
no entitlements at all) falls back to Application Support with a log line, so `swift test` and
unsigned builds keep working.

Entitlements are referenced from the target's build settings via `CODE_SIGN_ENTITLEMENTS`; the target
folders above own their files.

## Target membership is a whitelist

The app/extension source folders are Xcode 26 synchronized groups, and the per-target membership is
an **exception list**: a file in `Shared (App)` or `Shared (Extension)` compiles only if its name is
listed in that target's `PBXFileSystemSynchronizedBuildFileExceptionSet` in `project.pbxproj`. Adding
a Swift file there without updating the list produces "cannot find X in scope" at build time.

## Store layout on disk

Inside the app group container, under `Library/InfinMonkey`:

```
index.json             entries, rev, tombstones (structured → Codable)
entries/<id>.user.js   script code (plain file, editor-friendly)
entries/<id>.user.css  style code
values/<id>.json       GM values — opaque JSON, pass through unchanged
.lock                  flock target for cross-process exclusion
```

Writes are atomic (temp file + rename) so a reader never sees a torn file. Code files are the
source of truth for their entry: reconciliation adopts files with no index record and tombstones
records whose file vanished, and a content hash mismatch marks the entry as needing re-parsing.

## Build and verify

```bash
# Package logic (fast loop; --disable-sandbox is required inside the agent sandbox)
cd apple/InfinMonkeyCore && swift test --disable-sandbox

# macOS app + extension (resolves the package graph; -target does NOT)
xcodebuild -project InfinMonkey.xcodeproj -scheme "InfinMonkey (macOS)" \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build

# Formatting (default swift-format config, no .swift-format file)
deno task swift:fmt && deno task swift:lint
```

To confirm the language mode is really applied, check the flag rather than trusting a clean build:
`swift build --disable-sandbox -v | grep -o '\-swift-version [0-9]*'` must print `6`. A passing
build only means nothing was flagged — a mutable global is a reliable probe for whether strict
checking is on.

The iOS scheme has no usable destination on a machine without the iOS device platform installed.
Verify iOS-side sources by typechecking them against the simulator SDK with the same flags the target
uses. Build the package for the simulator triple first, or the module will be rejected for having
been built against the macOS SDK:

```bash
SDK=$(xcrun -sdk iphonesimulator -show-sdk-path)
cd apple/InfinMonkeyCore
swift build --disable-sandbox --triple arm64-apple-ios17.0-simulator -Xswiftc -sdk -Xswiftc "$SDK"
cd ../..
swiftc -typecheck -sdk "$SDK" -target arm64-apple-ios17.0-simulator \
  -swift-version 6 -default-isolation=MainActor -DAPP_GROUP \
  -I apple/InfinMonkeyCore/.build/arm64-apple-ios-simulator/debug/Modules \
  "apple/Shared (App)"/*.swift
```

`xcodebuild -target X -sdk ...` bypasses package resolution and fails with "unable to resolve module
dependency"; use a scheme, or resolve dependencies first.

## Signing and sandbox facts

Verified on this project, worth not re-discovering:

- A sandboxed executable with app group entitlements reaches the shared container even when launched
  by an unrelated parent process (browsers launch native messaging hosts this way).
- A **bare** sandboxed binary — one not inside an `.app` bundle — is killed with `SIGTRAP` on launch.
  Sandboxed code must live in a bundle; verify by putting a probe inside a `.app`.
- `CODE_SIGNING_ALLOWED=NO` builds embed no entitlements at all: no sandbox, no app group. Good for
  type and logic checking, and it is why the Application Support fallback must exist.
- A manual `codesign` does not expand `$(VAR)` in entitlements, while `xcodebuild` does. Hand-signing
  a probe means expanding the values yourself first.
- Info.plist expansion applies to values only; dictionary keys stay literal.

## Tests

Unit tests live in `apple/InfinMonkeyCore/Tests` and run with `swift test --disable-sandbox`. Test
names and messages are English; do not assert on user-visible Chinese copy. Fixtures shared with the
TypeScript side live under `packages/tests/fixtures/` — contract tests read them from the package so
one source of truth pins both implementations.
