[![CI](https://github.com/ghostflyby/infinmonkey/actions/workflows/ci.yml/badge.svg)](https://github.com/ghostflyby/infinmonkey/actions/workflows/ci.yml)

English | [简体中文](README.zh-CN.md)

# 🐵 InfinMonkey

A userscript and userstyle manager & runtime targeting **Manifest V3**, supporting Chrome / Firefox
(incl. Zen) / Safari, built on the **Deno** toolchain with `webextension-polyfill` providing a
unified API.

## Features

- **MV3 runtime**: the runner is declared directly in the manifest as a `world: "MAIN"` content
  script (Firefox 128+ / Chrome 111+). Userscripts run in the page context — `unsafeWindow` is the
  page `window`, unaffected by page CSP/Trusted Types (with a TT fallback strategy).
- **Full GM API** (injected per the `@grant` allowlist):
  - Storage: `GM_getValue / GM_setValue / GM_deleteValue / GM_listValues` (synchronous, TM/VM
    convention) + `GM_addValueChangeListener / GM_removeValueChangeListener` with cross-tab change
    broadcasting
  - Network: `GM_xmlhttpRequest` (cross-origin, timeout, abort, arraybuffer, strict `@connect`
    authorization)
  - Others: `GM_addStyle`, `GM_registerMenuCommand`, `GM_setClipboard`, `GM_notification`,
    `GM_openInTab`, `GM_download`, `GM_getTab / GM_saveTab / GM_getTabs`,
    `GM_getResourceText / GM_getResourceURL`
  - GM4 dotted aliases: `GM.getValue`, `GM.xmlHttpRequest`, `GM_info`, etc.
- **Userstyles**: Stylus-convention `/* ==UserStyle== */` header +
  `@-moz-document
  domain/url-prefix/url/regexp` scoping. Scopes are parsed in the background and
  injected per URL conditions — works on Chromium/Safari too; styles take effect **immediately after
  saving, no reload needed**.
- **Local file mapping for debugging** (core feature, pure web, no native messaging):
  - `deno task devserver` starts a local server (file watching + WebSocket push)
  - Scripts/styles can map to `http://127.0.0.1:<port>/xxx.user.js`; injection fetches the latest
    code in real time
  - Styles take effect on save without reload; scripts can auto-reload matching pages
  - native messaging can later replace the transport layer under the same protocol
- **Install flow**: visiting a `.user.js` / `.user.css` (or a plain-text page with a header) shows
  an install banner → metadata confirm page (grants / matching / source preview) → install. Supports
  installing from a URL, dedup on repeated installs, and manual update checks (`@updateURL` /
  `@downloadURL`)
- **Management UI**: options page (list / editor / import & export / dev mapping settings), popup
  (entries active on this page + menu commands), `@connect` authorization prompt (this once / always
  allow / deny, revocable in the editor)

## Lint plugin & unused export detection

- `deno lint` integrates a custom plugin (`lint.plugins` → `packages/tools/lint-plugin.ts`): the
  `no-leaf-exports` rule enforces zero exports in the `content/` and `inject/` leaf bundles (they
  are declared as standalone entries directly by the manifest — an export can only be a mistake or
  dead code);
- cross-file unused-export detection is beyond what a lint plugin can express (plugins report per
  file and lack a finalize hook that runs after all files are processed), so a dedicated task covers
  it: `deno task unused`.

## Quick start

```bash
# Build (firefox + chrome → dist/<browser>)
deno task build

# Start the local mapping server (default 127.0.0.1:17321, serving examples/)
deno task devserver --dir ./examples

# Build + load the extension temporarily in the configured browser (default zen)
deno task run
deno task run --browser nightly   # override for a single run
```

## Browser configuration (local file, gitignored)

Resolution priority: `--browser <name>` > the `INFIN_BROWSER` env var > `default` in
`.browsers.local.json` > built-in `zen`.

Create `.browsers.local.json` (never committed) to point at any Firefox-family browser:

```json
{
  "default": "nightly",
  "browsers": {
    "nightly": {
      "binary": "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
      "profile": ".webext/nightly-profile",
      "args": ["--devtools"]
    }
  }
}
```

- `profile` defaults to `.webext/<name>-profile`; `args` are forwarded to the browser via web-ext's
  `--`;
- `deno run -A packages/tools/browsers.ts` prints the resolved result;
- E2E follows the same config: `deno run -A packages/tools/e2e.ts --browser <name>`;
- missing paths produce a friendly error suggesting a check of the local config.

`run:zen` is equivalent to `run --browser zen`. web-ext runs via `deno run -A npm:web-ext@10.6.0`
(`deno x` cannot resolve its transitive dependencies under this project's config; `deno run` goes
through the regular module loader and works).

## Chromium-family support (experimental)

Built-in `edge` / `chrome` / `chromium` entries (kind inferred automatically; can also be declared
explicitly with `"kind": "chromium"`):

- **Loading** (`deno task run --browser <name>`): launches the browser directly with
  `--load-extension=<dist/chrome>` — a one-shot instance, no web-ext-style auto-reload;
- **E2E** (`deno run -A packages/tools/e2e.ts --browser <name>`): via chromedriver
  (`.webext/drivers/chromedriver` first, then PATH);
- **Limitations**: branded Chrome/Edge stable channels ignore `--load-extension` (official policy
  since 2025); Edge 152 was confirmed in testing not to load the extension. Real development/E2E on
  the Chromium family needs an unbranded build (Chromium or Chrome for Testing) plus a
  same-major-version chromedriver, matched exactly. This repo does not download browsers for you —
  place them yourself and point at them via `.browsers.local.json`.

## Verification

```bash
deno task test          # Unit tests (metadata parsing / matcher / mozdoc / version compare)
deno run -A packages/tools/e2e.ts  # E2E: geckodriver driving a headless Zen instance, 18 assertions
```

E2E coverage: temporary extension install → install banner → confirm page → MAIN world injection →
GM storage/addStyle/xmlhttpRequest/clipboard/@connect authorization prompt → dev mapping hot reload
→ userstyle scoped injection. Prerequisites: `deno task build:firefox`, `deno task devserver`,
`brew install geckodriver`.

## Repository layout (Deno workspace, members split by JS runtime context)

```
packages/
  shared/      @infinmonkey/shared    lib: esnext+webworker+dom — metadata parsing, matcher, mozdoc, protocol (reused across contexts)
  background/  event page/SW          lib: esnext+webworker      — storage, injection scheduling, @connect, GM_xhr, dev client
  content/     content script (isolated world) lib: esnext+dom   — bridge, install banner
  inject/      MAIN world runtime     lib: esnext+dom            — runner, GM API implementation
  ui/          extension pages        lib: esnext+dom            — options/popup/install/prompt
  tools/       Deno CLI tools         lib: esnext+deno.window    — build, dev_server, e2e
  tests/       unit tests             lib: esnext+deno.window    — shared-layer tests
```

Each member's `deno.json` declares its own `compilerOptions.lib`, so type checking rejects
out-of-context references (background referencing `document`, shared referencing `Deno` — both fail
type check; see each member's deno.json). Dependency versions are centralized in the root
`deno.json` `imports`; members reference shared via `workspace:*`.

**Dependencies**: `deno.json` sets `nodeModulesDir: "none"` — the project has **no node_modules and
no vendored dependencies**. Bundling uses `deno bundle` (oxc core, TS bundled directly); the npm
dependency (`webextension-polyfill`) resolves from Deno's global cache; esbuild has been removed
from the toolchain. Upgrading a dependency is just a version bump in `deno.json`.

## Safari

```bash
deno task safari:convert   # Generates an Xcode project via xcrun safari-web-extension-converter
```

Safari requires manual approval under Settings → Extensions. Note that Safari's support for
`scripting`'s `world: "MAIN"` and some permissions differs; it is not part of the first-phase
verification targets.

## Known limitations / engine quirks

Zen (Firefox-engine MV3 event page) has several defects observed in testing; workarounds are in
place:

1. Content-script messages' `sender` lacks `tab`/`frameId` → injection moved to a manifest-declared
   MAIN world runner, no longer relying on the background resolving the caller's location;
2. `tabs.query({})` returns empty inside the event page (works in extension page contexts) → menu
   command / notification tab targeting degrades to best-effort matching from a `tabs.onUpdated` URL
   log;
3. After the event page suspends, waking it via messages from extension pages is unreliable →
   content scripts keep it alive with a 20s heartbeat + page-side message timeouts with retry
   (`CreateEntry` carries an idempotency token to prevent duplicate creation on retries);
4. `webNavigation.onCommitted` is not delivered while the event page is suspended (styles now sync
   via a runner-side `<style>` and no longer depend on it).

Other limitations: `GM_xmlhttpRequest`'s `FormData` gets form-encoded; `@resource` binary resources
are unsupported; script auto-update is manual; menu commands registered in iframes are listed per
tab in the popup.

## Permissions

`storage` `unlimitedStorage` `scripting` `tabs` `webNavigation` `notifications` `downloads`
`clipboardWrite`

- `<all_urls>` host permission (needed for cross-origin requests and all-site injection; actual
  outbound requests are strictly gated by `@connect` authorization).

## License

This project is released under [MPL-2.0](LICENSE): file-level copyleft — the extension's own source
stays open and modifications remain traceable, while staying compatible with all distribution
channels (AMO / Chrome Web Store / iOS・macOS App Store).

The bundled third-party component `webextension-polyfill` is also MPL-2.0 (its license is included
in `LICENSE`). The build toolchain (Deno, @std/*, web-ext, chromedriver/geckodriver) is dev-only and
is not distributed with the extension. The example scripts under `examples/` share the project's
license.

## CI

`.github/workflows/ci.yml`, three jobs:

- **static**: fmt / lint / check / unit tests / unused export detection / build (dist as an
  artifact);
- **e2e-firefox**: ubuntu runner with preinstalled Firefox + geckodriver, `deno task
  devserver` in
  the background + full E2E;
- **e2e-chromium**: `browser-actions/setup-chrome` installs a pinned Chrome for Testing version
  (currently 153.0.8010.36, bumped deliberately; channel names resolve to branded Chrome, which
  ignores `--load-extension`) with a matched chromedriver, and runs the same E2E suite.

On failure, `.e2e/` screenshots and state are uploaded. Safari requires manually enabling the
extension in system settings and is not in CI for now (see the limitations above).
