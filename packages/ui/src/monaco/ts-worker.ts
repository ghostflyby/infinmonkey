// Self-assembled TypeScript language service worker.
//
// This entry deliberately does NOT import monaco's
// languages/features/typescript/tsWorker.js: the compiler dependency, the
// LanguageServiceHost, and the RPC method surface are assembled here against
// the pinned npm:typescript package, decoupled from monaco's bundled
// compiler version. Reused from monaco is only the worker-side RPC
// bootstrap (internal/common/initialize): handshake, createData delivery,
// and the mirror-model context.
//
// Contract sources — keep in sync when upgrading:
// - RPC method surface: monaco's languages/features/typescript/
//   languageFeatures.js (the page side invokes these by name over the worker
//   proxy) plus updateExtraLibs from workerManager.js.
// - Compiler options arriving in createData: monaco's register.js defaults
//   (javascriptDefaults ships target 99 / ESNext).
//
// The default-lib d.ts closure is NOT bundled: build.ts copies the
// typescript package's lib.*.d.ts files to dist/<browser>/monaco/libs/ and
// this worker fetches the transitive closure (following
// /// <reference lib="..."> directives) at init, before the language
// service answers its first request.
import * as ts from "typescript";
import { initialize } from "monaco-editor/internal/common/initialize";

interface MirrorModel {
  uri: { toString(skipEncoding?: boolean): string; path?: string };
  getValue(): string;
  version: number;
}

interface CreateData {
  compilerOptions: ts.CompilerOptions;
  extraLibs: Record<string, { content: string; version: number }>;
  inlayHintsOptions?: Record<string, unknown>;
  customWorkerPath?: string;
}

const LIB_REF_RE = /\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/g;

/** Fetches the default-lib closure (root + transitive reference-lib
 * directives) from the copied assets next to this worker. */
async function fetchLibClosure(rootName: string): Promise<Map<string, string>> {
  const libs = new Map<string, string>();
  const queue = [rootName];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || libs.has(name)) continue;
    const res = await fetch(new URL(`libs/${name}`, self.location.href));
    if (!res.ok) {
      throw new Error(`ts worker: lib file missing: ${name} (${res.status})`);
    }
    const text = await res.text();
    libs.set(name, text);
    for (const ref of text.matchAll(LIB_REF_RE)) {
      queue.push(`lib.${ref[1]}.d.ts`);
    }
  }
  return libs;
}

class InfinTSWorker implements ts.LanguageServiceHost {
  private readonly ctx: { getMirrorModels(): MirrorModel[] };
  private readonly compilerOptions: ts.CompilerOptions;
  private extraLibs: CreateData["extraLibs"];
  private readonly inlayHintsOptions: CreateData["inlayHintsOptions"];
  private readonly ls: ts.LanguageService;
  private libs = new Map<string, string>();
  /** Resolves once the default-lib closure has been fetched. */
  private readonly ready: Promise<void>;

  constructor(
    ctx: { getMirrorModels(): MirrorModel[] },
    createData: CreateData,
  ) {
    this.ctx = ctx;
    this.compilerOptions = createData.compilerOptions;
    this.extraLibs = createData.extraLibs;
    this.inlayHintsOptions = createData.inlayHintsOptions;
    this.ls = ts.createLanguageService(this);
    this.ready = fetchLibClosure(
      this.getDefaultLibFileName(this.compilerOptions),
    ).then((libs) => {
      this.libs = libs;
    });
  }

  // ---- LanguageServiceHost (mirror models + fetched libs + extraLibs) ----

  getCompilationSettings(): ts.CompilerOptions {
    return this.compilerOptions;
  }

  getScriptFileNames(): string[] {
    const models = this.ctx.getMirrorModels()
      .map((m) => m.uri)
      .filter((uri) => !this.fileNameIsLib(uri.toString()))
      .map((uri) => uri.toString());
    return models.concat(Object.keys(this.extraLibs));
  }

  getScriptVersion(fileName: string): string {
    const model = this.getModel(fileName);
    if (model) return model.version.toString();
    if (this.fileNameIsLib(fileName)) return "1";
    if (fileName in this.extraLibs) {
      return String(this.extraLibs[fileName].version);
    }
    return "";
  }

  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    const text = this.getScriptText(fileName);
    if (text === undefined) return undefined;
    return {
      getText: (start, end) => text.substring(start, end),
      getLength: () => text.length,
      getChangeRange: () => undefined,
    };
  }

  getScriptKind(fileName: string): ts.ScriptKind {
    switch (fileName.substr(fileName.lastIndexOf(".") + 1)) {
      case "ts":
        return ts.ScriptKind.TS;
      case "tsx":
        return ts.ScriptKind.TSX;
      case "js":
        return ts.ScriptKind.JS;
      case "jsx":
        return ts.ScriptKind.JSX;
      default:
        return this.compilerOptions.allowJs ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    }
  }

  getCurrentDirectory(): string {
    return "";
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string {
    // Monaco's javascriptDefaults ship target 99 (ESNext/Latest); the .full
    // variants pull the DOM + host environment libs, which is what
    // userscript editing needs.
    switch (options.target) {
      case ts.ScriptTarget.ESNext:
        return "lib.esnext.full.d.ts";
      case ts.ScriptTarget.ES5:
      case ts.ScriptTarget.ES2015:
      case ts.ScriptTarget.ES2016:
      case ts.ScriptTarget.ES2017:
      case ts.ScriptTarget.ES2018:
      case ts.ScriptTarget.ES2019:
      case ts.ScriptTarget.ES2020:
        return `lib.es${2013 + (options.target ?? 99)}.full.d.ts`;
      default:
        return "lib.esnext.full.d.ts";
    }
  }

  isDefaultLibFileName(fileName: string): boolean {
    return fileName === this.getDefaultLibFileName(this.compilerOptions);
  }

  readFile(path: string): string | undefined {
    return this.getScriptText(path);
  }

  fileExists(path: string): boolean {
    return this.getScriptText(path) !== undefined;
  }

  // ---- script resolution ----

  private getModel(fileName: string): MirrorModel | null {
    const models = this.ctx.getMirrorModels();
    for (const model of models) {
      const uri = model.uri;
      if (uri.toString() === fileName || uri.toString(true) === fileName) {
        return model;
      }
    }
    return null;
  }

  private fileNameIsLib(fileName: string): boolean {
    if (/^file:\/\/\//.test(fileName)) {
      return this.libs.has(fileName.substr(8));
    }
    if (fileName.startsWith("/lib.")) {
      return this.libs.has(fileName.slice(1));
    }
    return this.libs.has(fileName);
  }

  private getScriptText(fileName: string): string | undefined {
    const model = this.getModel(fileName);
    if (model) return model.getValue();
    const libized = `lib.${fileName}.d.ts`;
    if (fileName in this.libs) return this.libs.get(fileName);
    if (libized in this.libs) return this.libs.get(libized);
    if (fileName in this.extraLibs) return this.extraLibs[fileName].content;
    return undefined;
  }

  // ---- diagnostics sanitization (TS file objects are not RPC-marshalable) ----

  private static clearFiles(diags: readonly ts.Diagnostic[]): ts.Diagnostic[] {
    const out: ts.Diagnostic[] = [];
    for (const diag of diags) {
      const clean: ts.Diagnostic = { ...diag };
      clean.file = diag.file ? { fileName: diag.file.fileName } as ts.SourceFile : undefined;
      if (diag.relatedInformation) {
        clean.relatedInformation = diag.relatedInformation.map((info) => ({
          ...info,
          file: info.file ? { fileName: info.file.fileName } as ts.SourceFile : undefined,
        }));
      }
      out.push(clean);
    }
    return out;
  }

  private async sync(): Promise<void> {
    await this.ready;
  }

  // ---- RPC surface (called by name from monaco's languageFeatures.js) ----

  async getSyntacticDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return [];
    return InfinTSWorker.clearFiles(this.ls.getSyntacticDiagnostics(fileName));
  }

  async getSemanticDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return [];
    return InfinTSWorker.clearFiles(this.ls.getSemanticDiagnostics(fileName));
  }

  async getSuggestionDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return [];
    return InfinTSWorker.clearFiles(this.ls.getSuggestionDiagnostics(fileName));
  }

  async getCompilerOptionsDiagnostics(): Promise<ts.Diagnostic[]> {
    await this.sync();
    return InfinTSWorker.clearFiles(this.ls.getCompilerOptionsDiagnostics());
  }

  async getCompletionsAtPosition(
    fileName: string,
    position: number,
  ): Promise<ts.CompletionInfo | undefined> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return undefined;
    return this.ls.getCompletionsAtPosition(fileName, position, undefined);
  }

  async getCompletionEntryDetails(
    fileName: string,
    position: number,
    entry: string,
  ): Promise<ts.CompletionEntryDetails | undefined> {
    await this.sync();
    return this.ls.getCompletionEntryDetails(
      fileName,
      position,
      entry,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  }

  async getSignatureHelpItems(
    fileName: string,
    position: number,
    options: ts.SignatureHelpItemsOptions | undefined,
  ): Promise<ts.SignatureHelpItems | undefined> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return undefined;
    return this.ls.getSignatureHelpItems(fileName, position, options);
  }

  async getQuickInfoAtPosition(
    fileName: string,
    position: number,
  ): Promise<ts.QuickInfo | undefined> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return undefined;
    return this.ls.getQuickInfoAtPosition(fileName, position);
  }

  async getDocumentHighlights(
    fileName: string,
    position: number,
    filesToSearch: string[],
  ): Promise<ts.DocumentHighlights[] | undefined> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return undefined;
    return this.ls.getDocumentHighlights(fileName, position, filesToSearch);
  }

  async getDefinitionAtPosition(
    fileName: string,
    position: number,
  ): Promise<readonly ts.DefinitionInfo[] | undefined> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return undefined;
    return this.ls.getDefinitionAtPosition(fileName, position);
  }

  async getReferencesAtPosition(
    fileName: string,
    position: number,
  ): Promise<ts.ReferenceEntry[] | undefined> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return undefined;
    return this.ls.getReferencesAtPosition(fileName, position);
  }

  async getNavigationTree(fileName: string): Promise<ts.NavigationTree | undefined> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return undefined;
    return this.ls.getNavigationTree(fileName);
  }

  async getFormattingEditsForDocument(
    fileName: string,
    options: ts.FormatCodeSettings,
  ): Promise<ts.TextChange[]> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return [];
    return this.ls.getFormattingEditsForDocument(fileName, options);
  }

  async getFormattingEditsForRange(
    fileName: string,
    start: number,
    end: number,
    options: ts.FormatCodeSettings,
  ): Promise<ts.TextChange[]> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return [];
    return this.ls.getFormattingEditsForRange(fileName, start, end, options);
  }

  async getFormattingEditsAfterKeystroke(
    fileName: string,
    position: number,
    ch: string,
    options: ts.FormatCodeSettings,
  ): Promise<ts.TextChange[]> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return [];
    return this.ls.getFormattingEditsAfterKeystroke(fileName, position, ch, options);
  }

  async findRenameLocations(
    fileName: string,
    position: number,
    findInStrings: boolean,
    findInComments: boolean,
    providePrefixAndSuffixTextForRename: boolean,
  ): Promise<readonly ts.RenameLocation[] | undefined> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return undefined;
    return this.ls.findRenameLocations(
      fileName,
      position,
      findInStrings,
      findInComments,
      providePrefixAndSuffixTextForRename,
    );
  }

  async getRenameInfo(
    fileName: string,
    position: number,
    options: ts.RenameInfoOptions | undefined,
  ): Promise<ts.RenameInfo> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) {
      return { canRename: false, localizedErrorMessage: "Cannot rename in lib file" };
    }
    return this.ls.getRenameInfo(fileName, position, options);
  }

  async getEmitOutput(
    fileName: string,
    emitOnlyDtsFiles?: boolean,
    forceDtsEmit?: boolean,
  ): Promise<ts.EmitOutput> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) {
      return { outputFiles: [], emitSkipped: true } as unknown as ts.EmitOutput;
    }
    const output = this.ls.getEmitOutput(fileName, emitOnlyDtsFiles, forceDtsEmit);
    return {
      ...output,
      diagnostics: output.diagnostics ? InfinTSWorker.clearFiles(output.diagnostics) : undefined,
    } as ts.EmitOutput;
  }

  async getCodeFixesAtPosition(
    fileName: string,
    start: number,
    end: number,
    errorCodes: number[],
    formatOptions: ts.FormatCodeSettings,
  ): Promise<readonly ts.CodeFixAction[]> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return [];
    try {
      return this.ls.getCodeFixesAtPosition(
        fileName,
        start,
        end,
        errorCodes,
        formatOptions,
        {},
      );
    } catch {
      return [];
    }
  }

  async provideInlayHints(
    fileName: string,
    start: number,
    end: number,
  ): Promise<ts.InlayHint[]> {
    await this.sync();
    if (this.fileNameIsLib(fileName)) return [];
    try {
      return this.ls.provideInlayHints(
        fileName,
        { start, length: end - start },
        (this.inlayHintsOptions ?? {}) as ts.UserPreferences,
      );
    } catch {
      return [];
    }
  }

  // Async to match the RPC surface (the proxy marshals return values as
  // promises); the lint rule is silenced because the body is synchronous.
  // deno-lint-ignore require-await
  async updateExtraLibs(extraLibs: CreateData["extraLibs"]): Promise<void> {
    this.extraLibs = extraLibs;
  }
}

// monaco ships no declarations for the worker bootstrap; shape mirrored
// from internal/common/initialize.js (callback: mirror-model ctx + createData).
const bootstrap = initialize as unknown as (
  create: (
    ctx: { host: unknown; getMirrorModels(): MirrorModel[] },
    createData: CreateData,
  ) => unknown,
) => void;

self.onmessage = () => {
  bootstrap((ctx, createData) => new InfinTSWorker(ctx, createData));
};
