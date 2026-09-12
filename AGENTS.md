# AGENTS.md

Guidance for AI coding agents working in this repository.

## Language policy

All non-localized content in this repository must be written in English:

- Code comments in every file type (TS/CSS/HTML/YAML).
- Commit messages (conventional-commit style, e.g. `fix(e2e): ...`).
- CLI and dev-tool output, diagnostics, and internal error messages.
- CI workflow/step names and comments.
- Test names and lint rule messages.

Localized (user-facing) content stays in Chinese: extension UI strings (options/popup/install/prompt
pages), the install banner, the new-script/style scaffolds in `templates.ts`, the demo scripts in
`examples/`, and error messages surfaced to users. `README.md` is English; `README.zh-CN.md` is its
Chinese counterpart — keep both in sync and cross-linked.

Tests must be language-agnostic: no real-language fixture data and no assertions on visible UI copy.
Locale-suffix parsing is exercised with a synthetic tag (`xx-XX`); display strings are asserted only
as non-empty; E2E asserts on DOM markers/attributes (e.g. `data-infin-done`), never on visible text.

## Toolchain rules (hard constraints)

1. **No `npx`.** Run npm CLIs with `deno run -A npm:<pkg>[@version]`.
2. **No vendored dependencies.** No `vendor/` or `node_modules/` directories
   (`nodeModulesDir: "none"`); dependency versions live in the root `deno.json`.
3. **Bundle with `deno bundle`**, not esbuild or other third-party bundlers.
4. **Never download browsers or other large binaries without asking first.** E2E browsers/drivers
   come from local config (`.browsers.local.json`, gitignored) or the CI setup script.

## Validation

Before finishing a change, run: `deno fmt --check`, `deno lint`, `deno task test`, and
`deno task unused`. For E2E: start `deno task devserver` in the background, then
`deno run -A packages/tools/e2e.ts --suite smoke`.
