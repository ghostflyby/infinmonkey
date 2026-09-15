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

- Core must not import SwiftUI or AppKit/UIKit, and must not know how the store is
  *located*: it is given a root and manages the layout inside it. App group containers, bundle
  identity, and entitlement resolution are platform knowledge and live in `Shared (App)` as
  `StoreLocation` (admitted to the extension targets too, so all processes agree on one container
  rather than each resolving its own).
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

2. **Semantics-free payload → `JSONBody`.** GM values are a `Record<string, unknown>` on the
   extension side and mean nothing to the storage layer, so the native side must not model,
   validate, interpret, or reorder them. `JSONBody` carries them as a JSON graph and is the **only**
   place `Any` may live. Never thread `[String: Any]` through the implementation to avoid writing a
   type, and never put these values in a `Data` field of a `Codable` type — `Data` encodes as
   base64, so the extension would receive `"eyJrIjoxfQ=="` instead of an object.

## The JSON conversion path

Three rules, and no other conversions anywhere:

| Layer | Mechanism | Why |
|---|---|---|
| **Envelope** (`v`, `id`, `type`, `payload`) | read from the object graph, or parsed from text by `JSONBody(data:requiringValidJSON:)` | the payload's type depends on `type`, so the envelope cannot be decoded before it is known |
| **Payload and result** | `Codable`, compiler-written, fail-fast | a required member is required; a wrongly typed one is an error, never a default |
| **Opaque members** | `JSONBody` | Codable has no raw-JSON-fragment support, and `Data` means base64 |

A message is a `JSONBody` in both directions, which is what lets one entry point serve every
transport: Safari hands over a parsed graph, stdio hands over JSON text, and neither is
re-serialized to fit the router. `JSONBody` is `@unchecked Sendable` because it freezes whatever
graph it is given, so the value cannot change after construction.

`[String: Any]` is banned outside `JSONBody`. The one unavoidable exception is
`NSExtensionItem.userInfo`, which is Objective-C typed — wrap it in a `JSONBody` at that boundary and
nothing past it sees a dictionary.

## Discriminated unions are internally tagged

Where a value can be one of several shapes, the discriminator is a **sibling** of the payload, not a
wrapper around it:

```json
{"type": "inline"}                              // not {"inline": {}}
{"type": "dev", "url": "u", "autoReload": true} // not {"dev": {"url": "u"}}
```

The frame envelope already works this way (`v`/`id`/`type` side by side), and it is the only form
that is idiomatic in every implementation:

- **Swift** synthesis emits the *external* form for enums with associated values (`{"dev":{…}}`, and
  a redundant `{"inline":{}}`), so the tagged form is hand-written — see `EntrySource`.
- **TypeScript** narrows on `source.type === "dev"`.
- **System.Text.Json** (the planned Windows side) supports internal tagging as a first-class feature
  (`[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]` + `[JsonDerivedType]`) and **rejects**
  an untagged payload with `NotSupportedException`.

Keep payload members on a `Codable` struct so synthesis writes them; only the tag itself needs code.
Two rules when hand-writing it: the payload must not declare a member named after the discriminator
(writing both to one encoder merges them, and a later write silently overwrites an earlier one), and
an unrecognized tag must fail rather than fall back.

`meta` falls under rule 1: the app shows name, version, and description, so it needs the structure.
It is `ScriptMeta?`, and **the absence of the value is what means "not parsed yet"** — no flag inside
it, no placeholder name, and no sentinel spelling. On the wire that is `null` (the member stays
present, because the TypeScript type is non-optional); `null` and a missing member are the same
statement. The invariant "no metadata implies still-needs-parsing" is enforced in the store when a
document is loaded, not inferred at each use.

Do not reintroduce an empty-object spelling. It was tried and removed: `{}` decodes as a
fully-defaulted `ScriptMeta`, which is a *parsed* value, so a consumer that treats it as unparsed
had to special-case it — and the TypeScript side never did, which let an entry with no `matches`
reach the URL matcher and throw. The extension re-parses at the bridge (`native.ts`), which is where
parsing belongs.

Consequently the contract types `meta` concretely (`ScriptMeta | null`) rather than `unknown`: the
shape is modeled on both sides, so leaving it unknown only hid the missing-member case behind an
unchecked assertion.

Model types are immutable (`let`) — a parse result is a snapshot, not a mutable bag — so an edit is
expressed as a derivation that names exactly what changes (`ScriptMeta.withSummary`). A hand-written
summary does not clear the needs-parsing signal, because it says nothing about `@match` rules; only
parser output does (`updateMeta(fromParsing:)`).

Display copy never lives in this package: it is English-only and language-agnostic by policy, while
UI strings are Chinese. `EntrySummary.name` is therefore optional and the views choose what to show
for "no name yet".

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

Resolution is single-tier and fails hard: a missing passthrough key, a key whose container the
runtime does not grant (unsigned developer builds, where `CODE_SIGNING_ALLOWED=NO` embeds no
entitlements at all), and targets built without `APP_GROUP` all throw `StoreLocationError`. There is
no fallback directory on purpose — writing into one would split the library across processes. The
app reports the reason through its `unavailable` service, and the extension answers every request
with an error frame carrying it.

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
  type and logic checking, and it is why locating the store fails rather than falls back: an unsigned
  build has no container to share, so there is nothing to fall back to.
- A manual `codesign` does not expand `$(VAR)` in entitlements, while `xcodebuild` does. Hand-signing
  a probe means expanding the values yourself first.
- Info.plist expansion applies to values only; dictionary keys stay literal.

## Tests

Unit tests live in `apple/InfinMonkeyCore/Tests` and run with `swift test --disable-sandbox`. Test
names and messages are English; do not assert on user-visible Chinese copy. Fixtures shared with the
TypeScript side live under `packages/tests/fixtures/` — contract tests read them from the package so
one source of truth pins both implementations.
