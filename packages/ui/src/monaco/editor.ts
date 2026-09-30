// Monaco editor integration.
//
// The monaco JS is inlined into the page bundles from the pinned imports
// below (resolved through the css-stripped .monaco-esm shadow), the editor
// styles load as the aggregated monaco/editor.main.css static asset, and
// workers ship as standalone IIFE targets (monaco/*.worker.js) created from
// same-origin extension URLs via runtime.getURL — allowed by the default MV3
// CSP (script-src 'self') without blob:.
import browser from "webextension-polyfill";
import type * as monaco from "monaco-editor";
import * as editorApi from "../../../../.monaco-esm/vs/editor/editor.api.js";
// The relative .js import carries no aggregate types; the package entry
// (type-only mapping) provides them.
const { editor, KeyCode, KeyMod } = editorApi as unknown as typeof import("monaco-editor");
// The standalone editor entry (typed API, all editor features). The two
// definitions registers pull in the JS/TS and CSS/SCSS/LESS Monarch
// tokenizers (a few hundred KB); the aggregated basic-languages contribution
// would bundle all ~90 languages (~3.2MB). The main package entry stays
// type-only: its language-service chain imports font assets the bundler
// cannot emit. Language services (completion/diagnostics/go-to-definition)
// are layered on top by monaco/services.ts; this light variant ships
// without them.
import "../../../../.monaco-esm/vs/languages/definitions/javascript/register.js";
import "../../../../.monaco-esm/vs/languages/definitions/css/register.js";

// Workers live next to the page bundles in dist; same-origin, so no
// web_accessible_resources are needed (only our own pages load them). The
// label picks the language service: TS/JS and CSS have dedicated workers,
// everything else falls back to the base editor worker.
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: (_workerId: string, label: string): Worker => {
    const module = label === "typescript" || label === "javascript"
      ? "monaco/ts.worker.js"
      : label === "css" || label === "scss" || label === "less"
      ? "monaco/css.worker.js"
      : "monaco/editor.worker.js";
    return new Worker(browser.runtime.getURL(module));
  },
};

export type EditorLanguage = "javascript" | "css";

export interface CodeEditorHandle {
  getValue(): string;
  setValue(value: string): void;
  /** Switches the syntax language in place (model language change). */
  setLanguage(language: EditorLanguage): void;
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
  };
}
