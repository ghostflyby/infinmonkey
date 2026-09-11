import type { EntrySource, PopupData, PreparedScript, ScriptEntry, Settings } from "./types.ts";

/** 所有发往 background 的请求。发起方：bridge 内容脚本 / options / popup / install / prompt 页。 */
export type BgRequest =
  // 内容脚本注入链路
  | { type: "GetScriptsForFrame"; url: string; top: boolean }
  // GM 特权操作（bridge 转发自 MAIN world runner）
  | { type: "gmCall"; scriptId: string; reqId: number; op: string; args: Record<string, unknown> }
  // popup
  | { type: "GetPopupData"; tabId: number }
  | { type: "DispatchCommand"; commandId: number }
  // 管理页
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
  // 安装流
  | { type: "StartInstallFromText"; code: string; url?: string }
  | { type: "StartInstallFromUrl"; url: string }
  | { type: "OpenOptions" }
  | { type: "GetPendingInstall"; pendingId: string }
  | { type: "ConfirmInstall"; pendingId: string; decision: "install" | "cancel" }
  // @connect 授权弹窗
  | {
    type: "ConfirmConnectAuth";
    scriptId: string;
    domain: string;
    scope: "once" | "always" | "deny";
  };

/** background 主动推送的事件。 */

export interface FrameScripts {
  frameKey: string;
  scripts: PreparedScript[];
  /** 本页应生效的样式（runner 以 <style> 同步）。 */
  styles: { id: string; css: string }[];
}

export interface ListEntriesResult {
  scripts: ScriptEntry[];
  styles: import("./types.ts").StyleEntry[];
}

export type { PopupData };
