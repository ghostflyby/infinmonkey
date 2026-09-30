// Monaco editor integration.
//
// The monaco code never goes through `deno bundle` as an npm asset tree —
// the JS is inlined into the page bundles from the pinned npm: imports below,
// the worker ships as its own IIFE target (monaco/editor.worker.js), and the
// companion CSS file emitted next to each page bundle is linked from the page
// HTML. Workers are created from a same-origin extension URL via
// runtime.getURL, which the default MV3 CSP (script-src 'self') allows
// without blob:.
import browser from "webextension-polyfill";
import type * as monaco from "monaco-editor";
// Values come from the standalone editor entry (all editor features, typed);
// basic-languages contributes the JS/CSS Monarch grammars. The main package
// entry is type-only here: it pulls the language-service worker chain whose
// font/asset imports the bundler cannot emit.
import { editor, KeyCode, KeyMod } from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";

// The editor worker lives next to the page bundles in dist; same-origin,
// so no web_accessible_resources are needed (only our own pages load it).
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new Worker(browser.runtime.getURL("monaco/editor.worker.js")),
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
