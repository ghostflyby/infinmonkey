import type { EntrySource, PopupData, PreparedScript, ScriptEntry, Settings } from "./types.ts";

/** All requests sent to the background. Senders: bridge content script / options / popup / install / prompt pages. */
export type BgRequest =
  // Content script injection pipeline
  | { type: "GetScriptsForFrame"; url: string; top: boolean }
  // GM privileged ops (forwarded by the bridge from the MAIN world runner)
  | { type: "gmCall"; scriptId: string; reqId: number; op: string; args: Record<string, unknown> }
  // popup
  | { type: "GetPopupData"; tabId: number }
  | { type: "DispatchCommand"; commandId: number }
  // Management pages
  | { type: "ListEntries" }
  | { type: "GetEntry"; id: string }
  | { type: "SaveCode"; id: string; code: string }
  | { type: "SetEnabled"; id: string; enabled: boolean }
  | { type: "CreateEntry"; kind: "script" | "style"; code?: string; token?: string }
  | { type: "DeleteEntry"; id: string }
  | { type: "SetSource"; id: string; source: EntrySource }
  | { type: "GetConnectGrants"; id: string }
  | { type: "RevokeConnectGrant"; id: string; domain: string }
  | { type: "PingDevServer"; origin?: string }
  | { type: "CheckUpdate"; id: string }
  | { type: "ExportAll" }
  | { type: "ImportAll"; data: unknown; mode: "merge" | "replace" }
  | { type: "GetSettings" }
  | { type: "SetSettings"; patch: Partial<Settings> }
  // Install flow
  | { type: "StartInstallFromText"; code: string; url?: string }
  | { type: "StartInstallFromUrl"; url: string }
  | { type: "OpenOptions" }
  | { type: "GetPendingInstall"; pendingId: string }
  | { type: "ConfirmInstall"; pendingId: string; decision: "install" | "cancel" }
  // @connect authorization prompt
  | {
    type: "ConfirmConnectAuth";
    scriptId: string;
    domain: string;
    scope: "once" | "always" | "deny";
  };

/** Events pushed by the background. */

export interface FrameScripts {
  frameKey: string;
  scripts: PreparedScript[];
  /** Styles that should apply on this page (synced by the runner via <style>). */
  styles: { id: string; css: string }[];
}

export interface ListEntriesResult {
  scripts: ScriptEntry[];
  styles: import("./types.ts").StyleEntry[];
}

export type { PopupData };
