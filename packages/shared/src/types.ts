export type RunAt = "document-start" | "document-end" | "document-idle";

interface ResourceRef {
  name: string;
  url: string;
}

/** Parsed metadata, one structure shared by scripts and styles. */
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
  /** Raw @grant list, may contain "none". */
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
  /** Extra domains approved by the user beyond @connect (permanent grants). */
  connectGrants: string[];
  values: Record<string, unknown>;
  /** Code from the last successful fetch of a dev-mapped script; fallback when a fetch fails. */
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

/** Ready-to-run script handed by the background to the MAIN world runner. */
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
  /** Initial snapshot for the synchronous GM_*Value APIs. */
  values: Record<string, unknown>;
}

export interface Settings {
  devOrigin: string;
  /** "native": mirror the script library with the companion app via native messaging. */
  storageBackend: "local" | "native";
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
  /** Non-empty means a replacement install triggered by "check for updates". */
  replaceId?: string;
  createdAt: number;
}

export interface ExportBundle {
  infinmonkey: 1;
  exportedAt: number;
  scripts: ScriptEntry[];
  styles: StyleEntry[];
}
