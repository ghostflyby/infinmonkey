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
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const host = document.createElement("div");
  // Offscreen but rendered (not display:none) so the editor measures.
  host.style.cssText = "position:fixed;left:-2000px;top:0;width:600px;height:200px";
  document.body.append(host);
  // Mirror the real options-editor path: GM ambient lib + eager model sync
  // are configured by createCodeEditorWithServices; do the same here before
  // driving the raw editor API (which the check needs for actions/selection).
  configureLanguageServices();
  const SAMPLE =
    'let selfCheckVar = 1;\nlet consumer = selfCheckVar;\nconst v = GM_getValue("k");\nlet selfCheckVar = 2;\ndocument.title = "t";';
  const ed = editor.create(host, {
    value: SAMPLE,
    language: "javascript",
    theme: "vs-dark",
    automaticLayout: true,
    minimap: { enabled: false },
  });

  const results: Record<string, string> = {};
  const deadline = Date.now() + timeoutMs;

  // 1) diagnostics: TS2451 for the duplicate-style sample; here any Error
  //    marker proves the semantic RPC path.
  results.diag = "pending";
  // 2) colorization: distinct monaco token classes in the rendered lines.
  results.color = "pending";
  while (Date.now() < deadline && (results.diag === "pending" || results.color === "pending")) {
    if (results.diag === "pending") {
      const errs = editor.getModelMarkers({}).filter((m) => m.severity === 8);
      if (errs.length > 0) {
        results.diag = "ok(" + errs.map((m) => m.code).join(",").slice(0, 20) + ")";
      } else if (Date.now() > deadline - 1000) {
        results.diag = "fail(no-error-markers)";
      }
    }
    if (results.color === "pending") {
      const classes = new Set(
        [...host.querySelectorAll('[class*="mtk"]')].map((el) => el.className),
      );
      if (classes.size >= 2) results.color = "ok(" + classes.size + ")";
    }
    await sleep(300);
  }

  // 3+4) hover: GM quick info via the ambient extraLib, and `document`
  //    quick info whose type resolves inside the fetched lib.dom
  //    declarations (fails if the worker cannot serve libs). Each hover is
  //    driven from a clean state and polls for the expected substring.
  const hoverOnce = async (
    key: string,
    line: number,
    col: number,
    expect: string,
  ) => {
    ed.setPosition({ lineNumber: line, column: col });
    ed.focus();
    ed.trigger("api", "editor.action.hideHover", null);
    await sleep(150);
    const t0 = Date.now();
    ed.trigger("api", "editor.action.showHover", null);
    let seen = "";
    while (Date.now() - t0 < 30000) {
      const widget = document.querySelector(".monaco-hover-content, .hover-contents");
      seen = (widget?.textContent ?? "").slice(0, 40);
      if (seen.includes(expect)) {
        results[key] = "ok(" + seen.slice(0, 24) + "," + (Date.now() - t0) + "ms)";
        return;
      }
      await sleep(300);
    }
    results[key] = "fail(saw=" + JSON.stringify(seen) + ")";
  };
  await hoverOnce("hover", 3, 11, "GM_getValue");
  await hoverOnce("lib", 5, 5, "Document");

  // 5) go-to-definition from the usage on line 2 to the declaration on line 1:
  //    a same-file reveal moves the selection to line 1.
  results.goto = "pending";
  ed.setPosition({ lineNumber: 2, column: 16 });
  ed.focus();
  ed.trigger("api", "editor.action.revealDefinition", null);
  const gotoDeadline = Date.now() + 20000;
  while (Date.now() < gotoDeadline && results.goto === "pending") {
    const sel = ed.getSelection();
    if (sel && sel.startLineNumber === 1) {
      results.goto = "ok";
      break;
    }
    await sleep(300);
  }
  if (results.goto === "pending") {
    results.goto = "fail(sel=" + JSON.stringify(ed.getSelection()) + ")";
  }

  ed.dispose();
  host.remove();
  const flat = Object.entries(results).map(([k, v]) => k + "=" + v).join(" ");
  if (Object.values(results).every((v) => v.startsWith("ok"))) return "pass " + flat;
  return "fail " + flat + (notes.length ? " notes=" + notes.slice(0, 3).join("|") : "");
}

export { KeyCode, KeyMod };
