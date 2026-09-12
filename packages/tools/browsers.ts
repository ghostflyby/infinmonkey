/**
 * Browser target resolution: lets developers point at different browsers (Firefox family) via local config.
 *
 * Resolution priority: CLI --browser <name> > the INFIN_BROWSER env var >
 * the default in .browsers.local.json > the built-in default "zen".
 *
 * Local config (.browsers.local.json, gitignored) example:
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
  /** Executable path */
  binary: string;
  /** WebDriver executable path override (defaults inferred from kind) */
  driver?: string;
  /** Profile directory for runs (repo-relative or absolute); defaults to .webext/<name>-profile */
  profile?: string;
  /** Extra launch args passed to the browser (forwarded via web-ext run's --) */
  args?: string[];
}

interface LocalConfig {
  default?: string;
  browsers?: Record<string, BrowserConfig>;
}

const BUILTIN: Record<string, BrowserConfig> = {
  zen: { binary: "/Applications/Zen.app/Contents/MacOS/zen" },
  // Preinstalled Firefox on the CI Linux runner (on macOS, selecting it with a missing path yields a friendly error)
  firefox: { binary: "/usr/bin/firefox" },
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

/** Infers the engine kind from the executable path; an explicit kind declaration wins. */
export function inferKind(binary: string, explicit?: BrowserKind): BrowserKind {
  if (explicit) return explicit;
  const base = binary.toLowerCase();
  if (FIREFOX_NAMES.test(base)) return "firefox";
  if (CHROMIUM_NAMES.test(base)) return "chromium";
  return "firefox"; // default to Firefox (legacy behavior)
}

async function readLocal(): Promise<LocalConfig> {
  try {
    return JSON.parse(await Deno.readTextFile(join(ROOT, ".browsers.local.json"))) as LocalConfig;
  } catch {
    return {}; // no local config is normal
  }
}

/** Takes --browser <name> from the CLI args (ignored if absent). */
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
      `[browsers] browser "${name}" is not configured. Available: ${
        Object.keys(browsers).join(", ")
      };` +
        `or add an entry in this project's .browsers.local.json (gitignored).`,
    );
    Deno.exit(1);
  }
  try {
    await Deno.stat(cfg.binary);
  } catch {
    console.error(
      `[browsers] "${name}" executable does not exist: ${cfg.binary} (check .browsers.local.json)`,
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

// When run as a CLI, prints the resolved result (for debugging)
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
