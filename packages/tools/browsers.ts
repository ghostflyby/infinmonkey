/**
 * 浏览器目标解析：允许开发者用本地配置指向不同浏览器（Firefox 系）。
 *
 * 解析优先级：CLI --browser <名> > 环境变量 INFIN_BROWSER >
 * .browsers.local.json 的 default > 内置默认 "zen"。
 *
 * 本地配置（.browsers.local.json，已 gitignore）示例：
 * {
 *   "default": "nightly",
 *   "browsers": {
 *     "nightly": {
 *       "binary": "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
 *       "profile": ".webext/nightly-profile",
 *       "args": ["--devtools"]
 *     }
 *   }
 * }
 */
import { dirname, fromFileUrl, join } from "@std/path";

export const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..");

export type BrowserKind = "firefox" | "chromium";

export interface BrowserConfig {
  /** firefox → web-ext/geckodriver；chromium → --load-extension/chromedriver */
  kind?: BrowserKind;
  /** 可执行文件路径 */
  binary: string;
  /** 运行用 profile 目录（相对仓库根或绝对路径），缺省 .webext/<名字>-profile */
  profile?: string;
  /** 传给浏览器的附加启动参数（web-ext run 经 -- 透传） */
  args?: string[];
}

interface LocalConfig {
  default?: string;
  browsers?: Record<string, BrowserConfig>;
}

const BUILTIN: Record<string, BrowserConfig> = {
  zen: { binary: "/Applications/Zen.app/Contents/MacOS/zen" },
  edge: {
    kind: "chromium",
    binary: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  },
  chrome: {
    kind: "chromium",
    binary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  },
  chromium: { kind: "chromium", binary: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
};

const FIREFOX_NAMES = /firefox|zen|librewolf|waterfox|floorp|gecko/i;
const CHROMIUM_NAMES = /chrome|chromium|edge|brave|arc|opera|vivaldi|dia/i;

/** 从可执行文件路径推断内核类型；显式声明的 kind 优先。 */
export function inferKind(binary: string, explicit?: BrowserKind): BrowserKind {
  if (explicit) return explicit;
  const base = binary.toLowerCase();
  if (FIREFOX_NAMES.test(base)) return "firefox";
  if (CHROMIUM_NAMES.test(base)) return "chromium";
  return "firefox"; // 缺省按 Firefox 处理（历史行为）
}

async function readLocal(): Promise<LocalConfig> {
  try {
    return JSON.parse(await Deno.readTextFile(join(ROOT, ".browsers.local.json"))) as LocalConfig;
  } catch {
    return {}; // 无本地配置属正常
  }
}

/** 从调用参数取 --browser <名>（不存在则忽略）。 */
export function cliBrowserName(argv: string[] = Deno.args): string | undefined {
  const i = argv.indexOf("--browser");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

export async function resolveBrowser(
  nameArg?: string,
): Promise<{ name: string; kind: BrowserKind; cfg: BrowserConfig; profileAbs: string }> {
  const local = await readLocal();
  const browsers = { ...BUILTIN, ...local.browsers };
  const name = nameArg ?? Deno.env.get("INFIN_BROWSER") ?? local.default ?? "zen";
  const cfg = browsers[name];
  if (!cfg) {
    console.error(
      `[browsers] 未配置浏览器 "${name}"。可用：${Object.keys(browsers).join(", ")}；` +
        `或在本项目 .browsers.local.json 中新增（已 gitignore）。`,
    );
    Deno.exit(1);
  }
  try {
    await Deno.stat(cfg.binary);
  } catch {
    console.error(
      `[browsers] "${name}" 的可执行文件不存在：${cfg.binary}（请检查 .browsers.local.json）`,
    );
    Deno.exit(1);
  }
  const profileRel = cfg.profile ?? `.webext/${name}-profile`;
  return {
    name,
    kind: inferKind(cfg.binary, cfg.kind),
    cfg,
    profileAbs: profileRel.startsWith("/") ? profileRel : join(ROOT, profileRel),
  };
}

// 作为 CLI 运行时打印解析结果（调试用）
if (import.meta.main) {
  const { name, kind, cfg, profileAbs } = await resolveBrowser(cliBrowserName());
  console.log(
    JSON.stringify(
      { name, kind, binary: cfg.binary, profile: profileAbs, args: cfg.args ?? [] },
      null,
      2,
    ),
  );
}
