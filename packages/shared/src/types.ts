export type RunAt = "document-start" | "document-end" | "document-idle";

interface ResourceRef {
  name: string;
  url: string;
}

/** 解析后的元数据，脚本与样式共用一套结构。 */
export interface ScriptMeta {
  name: string;
  namespace?: string;
  version?: string;
  description?: string;
  author?: string;
  homepageURL?: string;
  supportURL?: string;
  iconURL?: string;
  updateURL?: string;
  downloadURL?: string;
  license?: string;
  runAt: RunAt;
  noframes: boolean;
  matches: string[];
  includes: string[];
  excludes: string[];
  /** 原始 @grant 列表，可能含 "none"。 */
  grants: string[];
  connects: string[];
  requires: string[];
  resources: ResourceRef[];
  nameLocales: Record<string, string>;
  descriptionLocales: Record<string, string>;
  others: Record<string, string[]>;
  headerRaw: string;
  headerFound: boolean;
}

export type EntrySource =
  | { type: "inline" }
  | { type: "dev"; url: string; autoReload: boolean };

interface BaseEntry {
  id: string;
  kind: "script" | "style";
  enabled: boolean;
  position: number;
  code: string;
  meta: ScriptMeta;
  source: EntrySource;
  installedAt: number;
  updatedAt: number;
}

export interface ScriptEntry extends BaseEntry {
  kind: "script";
  /** @connect 之外由用户批准的额外域名（永久授权）。 */
  connectGrants: string[];
  values: Record<string, unknown>;
  /** dev 映射脚本最近一次成功拉取的代码，拉取失败时兜底。 */
  devCode?: string;
}

export interface StyleEntry extends BaseEntry {
  kind: "style";
}

export type AnyEntry = ScriptEntry | StyleEntry;

export interface ResourcePayload {
  name: string;
  url: string;
  mime: string;
  text: string;
}

/** background 交给 MAIN world runner 的就绪脚本。 */
export interface PreparedScript {
  id: string;
  name: string;
  namespace: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  runAt: RunAt;
  noframes: boolean;
  grants: string[];
  connects: string[];
  code: string;
  requires: { url: string; text: string }[];
  resources: ResourcePayload[];
  metaPlain: Record<string, unknown>;
  headerRaw: string;
  devUrl?: string;
  /** GM_*Value 同步 API 的初始快照。 */
  values: Record<string, unknown>;
}

export interface Settings {
  devOrigin: string;
}

export interface PopupScriptInfo {
  id: string;
  kind: "script" | "style";
  name: string;
  version: string;
  enabled: boolean;
}

interface PopupCommand {
  commandId: number;
  scriptId: string;
  title: string;
}

export interface PopupData {
  url: string;
  scripts: PopupScriptInfo[];
  commands: PopupCommand[];
  devConnected: boolean;
  devOrigin: string;
}

export interface PendingInstall {
  id: string;
  kind: "script" | "style";
  code: string;
  url?: string;
  /** 非空表示「检查更新」触发的替换安装。 */
  replaceId?: string;
  createdAt: number;
}

export interface ExportBundle {
  infinmonkey: 1;
  exportedAt: number;
  scripts: ScriptEntry[];
  styles: StyleEntry[];
}
