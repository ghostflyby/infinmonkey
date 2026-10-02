// Monaco editor integration.
//
// The JS is bundled by vite from the pinned package imports below, the
// styles are emitted by the bundler from monaco's own css imports and
// linked from the pages, and workers ship as standalone IIFE targets
// (monaco/*.worker.js) created from same-origin extension URLs via
// runtime.getURL — allowed by the default MV3 CSP (script-src 'self')
// without blob:.
import browser from "webextension-polyfill";
import type * as monaco from "monaco-editor";
import { editor, KeyCode, KeyMod } from "monaco-editor/editor/editor.api";
// The standalone editor entry (typed API, all editor features). The two
// definitions registers pull in the JS/TS and CSS/SCSS/LESS Monarch
// tokenizers (a few hundred KB); the aggregated basic-languages contribution
// would bundle all ~90 languages (~3.2MB). Language services
// (completion/diagnostics/go-to-definition) are layered on top by
// monaco/services.ts; this light variant ships without them.
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/css/register";

// Workers live next to the page bundles in dist; same-origin, so no
// web_accessible_resources are needed (only our own pages load them). The
// label picks the language service: TS/JS and CSS have dedicated workers,
// everything else falls back to the base editor worker. The TS worker is a
// self-assembled module-worker entry of the pages build (packages/ui/src/
// monaco/ts-worker.ts), so it must be created with { type: "module" }; the
// others are classic single-file IIFE targets.
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: (_workerId: string, label: string): Worker => {
    const isTs = label === "typescript" || label === "javascript";
    const module = isTs
      ? "monaco/ts.worker.js"
      : label === "css" || label === "scss" || label === "less"
      ? "monaco/css.worker.js"
      : "monaco/editor.worker.js";
    return new Worker(
      browser.runtime.getURL(module),
      isTs ? { type: "module" } : {},
    );
  },
};

export type EditorLanguage = "javascript" | "css";

export interface CodeEditorHandle {
  getValue(): string;
  setValue(value: string): void;
  /** Switches the syntax language in place (model language change). */
  setLanguage(language: EditorLanguage): void;
  /** Scrolls the 1-based line to the center of the viewport, places the
   * cursor at its first column and focuses the editor (error jump). */
  revealLine(line: number): void;
}

export interface CodeEditorOptions {
  value: string;
  language: EditorLanguage;
  readOnly?: boolean;
  /** Wired to Ctrl/Cmd-S inside the editor. */
  onSave?: () => void;
}

export function createCodeEditor(mount: HTMLElement, opts: CodeEditorOptions): CodeEditorHandle {
  const ed: monaco.editor.IStandaloneCodeEditor = editor.create(mount, {
    value: opts.value,
    language: opts.language,
    theme: "vs-dark",
    readOnly: opts.readOnly ?? false,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
  });
  if (opts.onSave) {
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => opts.onSave?.());
  }
  return {
    getValue: () => ed.getValue(),
    setValue: (value: string) => ed.setValue(value),
    setLanguage: (language: EditorLanguage) => {
      const model = ed.getModel();
      if (model) editor.setModelLanguage(model, language);
    },
    revealLine: (line: number) => {
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: 1 });
      ed.focus();
    },
  };
}
