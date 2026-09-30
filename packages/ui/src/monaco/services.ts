// Monaco with the language services layered on: all editor contributions
// (context menu, find, folding, multicursor, ...) plus the TypeScript/JS and
// CSS language services (completion, hover, diagnostics, go-to-definition)
// served by the worker bundles in monaco/*-worker.ts. The options editor uses
// this variant; the install preview ships the light editor instead.
import { editor, KeyCode, KeyMod } from "monaco-editor/editor/editor.api";
// javascriptDefaults is exported by the contribution itself — monaco 0.57 has
// no runtime languages.typescript namespace (verified in the esm tree).
import * as tsRegister from "monaco-editor/languages/features/typescript/register";
const { javascriptDefaults } = tsRegister as unknown as {
  javascriptDefaults: {
    addExtraLib(lib: string, fileName?: string): void;
    setDiagnosticsOptions(o: { noSemanticValidation: boolean; noSyntaxValidation: boolean }): void;
    setEagerModelSync(on: boolean): void;
    getCompilerOptions(): Record<string, unknown>;
    setCompilerOptions(o: Record<string, unknown>): void;
  };
};
import "monaco-editor/features/register.all";
import "monaco-editor/languages/features/css/register";
import { type CodeEditorHandle, type CodeEditorOptions, createCodeEditor } from "./editor.ts";

export type { CodeEditorHandle, CodeEditorOptions };

/** Ambient declarations injected into the TS/JS language service so
 * userscript globals (GM_*, unsafeWindow) complete and pass semantic
 * validation; the editor validates syntax and these symbols only — real
 * mistakes in user code still surface as diagnostics. */
const GM_DECLARATIONS = [
  "declare const GM_info: { version: string; script: { name: string; version?: string } };",
  "declare function GM_getValue(key: string, defaultValue?: unknown): unknown;",
  "declare function GM_setValue(key: string, value: unknown): void;",
  "declare function GM_deleteValue(key: string): void;",
  "declare function GM_listValues(): string[];",
  "declare function GM_addValueChangeListener(key: string, listener: (key: string, oldValue: unknown, newValue: unknown, remote: boolean) => void): number;",
  "declare function GM_removeValueChangeListener(listenerId: number): void;",
  "declare function GM_getResourceText(name: string): string | undefined;",
  "declare function GM_getResourceURL(name: string): string | undefined;",
  "declare function GM_addStyle(css: string): void;",
  "declare function GM_registerMenuCommand(title: string, fn: () => void): number;",
  "declare function GM_unregisterMenuCommand(id: number): void;",
  "declare function GM_setClipboard(text: string, type?: string): void;",
  "declare function GM_notification(details: { title?: string; text?: string; image?: string } | string, on_click?: () => void): void;",
  "declare function GM_openInTab(url: string, opts?: { active?: boolean; pinned?: boolean }): { tabId: number; close(): void };",
  "declare function GM_getTab(cb: (tab: unknown) => void): void;",
  "declare function GM_saveTab(obj: unknown): void;",
  "declare function GM_getTabs(cb: (tabs: Record<string, unknown>) => void): void;",
  "declare function GM_download(url: string | { url: string; name?: string; saveAs?: boolean }, name?: string): void;",
  "declare function GM_xmlhttpRequest(details: { method?: string; url: string; headers?: Record<string, string>; data?: unknown; timeout?: number; anonymous?: boolean; responseType?: string; onload?: (response: unknown) => void; onerror?: (response: unknown) => void; onabort?: (response: unknown) => void; onprogress?: (response: unknown) => void }): { abort(): void };",
  "declare const unsafeWindow: Window & typeof globalThis;",
  "declare namespace GM {",
  "  function getValue(key: string, defaultValue?: unknown): Promise<unknown>;",
  "  function setValue(key: string, value: unknown): Promise<void>;",
  "  function deleteValue(key: string): Promise<void>;",
  "  function listValues(): Promise<string[]>;",
  "  function setClipboard(text: string, type?: string): Promise<void>;",
  "  const info: { version: string; script: { name: string; version?: string } };",
  "}",
].join("\n");

let servicesConfigured = false;

/** One-time language service configuration: GM ambient lib + validation. */
function configureLanguageServices(): void {
  if (servicesConfigured) return;
  servicesConfigured = true;
  // languages.typescript is added at runtime by the contribution above and is
  // absent from the static typings.
  javascriptDefaults.addExtraLib(GM_DECLARATIONS, "infinmonkey/gm.d.ts");
  javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  javascriptDefaults.setEagerModelSync(true);
}

export function createCodeEditorWithServices(
  mount: HTMLElement,
  opts: CodeEditorOptions,
): CodeEditorHandle {
  configureLanguageServices();
  return createCodeEditor(mount, opts);
}

/**
 * Automation self-check for the #e2e hash (options page): mounts an
 * offscreen editor with a semantically invalid statement and resolves once
 * the TS language worker reports the semantic error marker — proving the
 * whole chain end to end (module worker boot, RPC handshake, mirror-model
 * sync, default-lib fetch, getSemanticDiagnostics). The caller reports the
 * verdict through the location hash: the only channel WebDriver can read on
 * privileged extension pages.
 */
export async function runTsWorkerSelfCheck(
  timeoutMs = 30_000,
): Promise<string> {
  // Diagnostics collected for the timeout verdict (reported through the
  // hash): page errors, unhandled rejections, worker lifecycle notes.
  const notes: string[] = [];
  window.addEventListener("error", (e) => notes.push("err:" + e.message.slice(0, 60)));
  window.addEventListener("unhandledrejection", (e) => {
    notes.push("rej:" + String(e.reason).slice(0, 60));
  });
  const env = (self as unknown as {
    MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker };
  }).MonacoEnvironment;
  const origGetWorker = env?.getWorker?.bind(env);
  if (env && origGetWorker) {
    env.getWorker = (id: string, label: string) => {
      const w = origGetWorker(id, label);
      notes.push("worker:" + label);
      w.onerror = (ev) => notes.push("workerErr:" + String(ev.message).slice(0, 80));
      return w;
    };
  }
  // JS models only get semantic diagnostics with checkJs; the product
  // default leaves it off (syntax + GM symbols only), so enable it for the
  // check and restore afterwards.
  const savedOptions = javascriptDefaults.getCompilerOptions();
  javascriptDefaults.setCompilerOptions({ ...savedOptions, checkJs: true });
  try {
    return await runCheck(timeoutMs, notes);
  } finally {
    javascriptDefaults.setCompilerOptions(savedOptions);
  }
}

async function runCheck(timeoutMs: number, notes: string[]): Promise<string> {
  const host = document.createElement("div");
  // Offscreen but rendered (not display:none) so the editor measures.
  host.style.cssText = "position:fixed;left:-2000px;top:0;width:600px;height:200px";
  document.body.append(host);
  createCodeEditorWithServices(host, {
    // Duplicate let declarations: TS2451 is a checker diagnostic that IS
    // reported for .js files (many candidates like not-callable are
    // suppressed in JS), so reaching it proves the full chain including the
    // default-lib program. Type annotations would only yield TS8010, the
    // grammar-level "no annotations in .js" rejection.
    value: "let selfCheckVar = 1; let selfCheckVar = 2;",
    language: "javascript",
  });
  const deadline = Date.now() + timeoutMs;
  // MarkerSeverity.Error === 8; TS2451 is the expected semantic diagnostic.
  while (Date.now() < deadline) {
    if (editor.getModelMarkers({}).some((m) => m.severity === 8 && String(m.code) === "2451")) {
      host.remove();
      return "pass";
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const markers = editor.getModelMarkers({});
  const verdict = "timeout notes=" + notes.slice(0, 5).join(" | ") + " markers=" +
    markers.map((m) => m.severity + ":" + m.code).slice(0, 5).join(",");
  host.remove();
  return verdict;
}

export { KeyCode, KeyMod };
