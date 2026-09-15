/**
 * Detects .user.js / .user.css text pages (or plain text pages with a script/style header)
 * and shows the "Install to InfinMonkey" banner.
 */
import browser from "webextension-polyfill";
import { isStoredEntry } from "@infinmonkey/shared/guards";
import { detectKind, parseMeta } from "@infinmonkey/shared/meta";
import type { AnyEntry, Settings } from "@infinmonkey/shared/types";

interface Found {
  kind: "script" | "style";
  text: string;
}

function detect(): Found | null {
  const ct = (document as unknown as { contentType?: string }).contentType ?? "";
  // Browsers never execute top-level navigated JS files; they render them as text. Sites like greasyfork serve text/plain.
  // text/html is only allowed when the path itself is .user.js/.user.css (the dev server's ?as=html wrapper view,
  // used to automate the official Firefox with WebDriver, which refuses execute on text/plain documents).
  const wrapView = ct.startsWith("text/html") && /\.user\.(js|css)$/.test(location.pathname);
  const okType = ct.startsWith("text/plain") || ct.includes("javascript") || wrapView;
  if (ct && !okType) return null;
  if (window.top !== window) return null;
  const text = document.body?.innerText ?? document.body?.textContent ?? "";
  if (!text || text.length > 4_000_000) return null;
  const head = text.slice(0, 4000);
  if (head.includes("==UserScript==") || head.includes("==UserStyle==")) {
    return { kind: detectKind(text), text };
  }
  if (/\.user\.js$/.test(location.pathname)) return { kind: "script", text };
  if (/\.user\.css$/.test(location.pathname)) return { kind: "style", text };
  return null;
}

const found = detect();
if (found) {
  const w = window as unknown as { __infinInstallerShown?: boolean };
  if (!w.__infinInstallerShown) {
    w.__infinInstallerShown = true;
    showBanner(found);
  }
}

function showBanner(found: Found): void {
  const meta = parseMeta(found.text, decodeURIComponent(location.pathname.split("/").pop() ?? ""));
  const label = found.kind === "script" ? "用户脚本" : "用户样式";

  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647";
  // open mode: eases automated testing and userscript debugging (content is just the install banner, no sensitive data)
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .card {
      font: 13px/1.5 system-ui, -apple-system, sans-serif;
      color: #e8e8ea; background: #232329;
      border: 1px solid #3a3a42; border-radius: 10px;
      padding: 14px 16px; width: 320px;
      box-shadow: 0 8px 30px rgba(0,0,0,.4);
    }
    .title { font-weight: 600; font-size: 14px; margin-bottom: 2px; }
    .sub { color: #9a9aa5; margin-bottom: 10px; }
    .name { color: #f1f1f4; }
    .ver { color: #9a9aa5; font-size: 12px; }
    .btns { display: flex; gap: 8px; }
    button {
      all: unset; cursor: pointer; text-align: center;
      padding: 6px 14px; border-radius: 6px; font-size: 13px;
    }
    .install { background: #e91e63; color: #fff; font-weight: 600; flex: 1; }
    .install:hover { background: #f04580; }
    .dismiss { background: #33333c; color: #b9b9c3; width: 34px; }
    .dismiss:hover { background: #3d3d47; }
    .done { color: #7bd88f; }
  `;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <div class="title">检测到${label}</div>
    <div class="sub"><span class="name"></span> <span class="ver"></span></div>
    <div class="btns"><button class="install">安装到 InfinMonkey</button><button class="dismiss">✕</button></div>
  `;
  (card.querySelector(".name") as HTMLElement).textContent = meta.name;
  (card.querySelector(".ver") as HTMLElement).textContent = meta.version ? `v${meta.version}` : "";

  shadow.append(style, card);
  (document.documentElement || document.body).appendChild(host);

  const installBtn = shadow.querySelector(".install") as HTMLButtonElement;
  installBtn.addEventListener("click", async () => {
    installBtn.textContent = "正在安装…";
    installBtn.style.pointerEvents = "none";
    try {
      // The content script completes pending → entry directly via storage (no bg message channel needed)
      const st = (await browser.storage.local.get(["scripts", "styles", "settings"])) as {
        scripts?: unknown;
        styles?: unknown;
        settings?: Partial<Settings>;
      };
      // Entries come back untyped; the same shape rule as the background's own
      // read applies, so a malformed store cannot break the install page.
      const rawScripts = Array.isArray(st.scripts) ? st.scripts : [];
      const rawStyles = Array.isArray(st.styles) ? st.styles : [];
      const all: AnyEntry[] = [...rawScripts, ...rawStyles].filter(isStoredEntry);
      const kind = detectKind(found.text);
      const dev = location.href.startsWith("http://127.0.0.1:17321") ||
        location.href.startsWith("http://localhost:17321");
      const dup = all.find((e) =>
        e.kind === kind &&
        ((e.source.type === "dev" && e.source.url === location.href) || e.code === found.text)
      );
      if (dup) {
        // Update the existing entry
        dup.code = found.text;
        dup.updatedAt = Date.now();
      } else {
        const now = Date.now();
        const common = {
          id: crypto.randomUUID(),
          enabled: true,
          code: found.text,
          meta: parseMeta(found.text, meta.name),
          position: 1,
          source: dev
            ? { type: "dev" as const, url: location.href, autoReload: true }
            : { type: "inline" as const },
          installedAt: now,
          updatedAt: now,
        };
        if (kind === "script") {
          const arr = rawScripts.filter(isStoredEntry);
          arr.push({
            ...common,
            kind: "script",
            connectGrants: [],
            values: {},
            devCode: dev ? found.text : undefined,
          });
          await browser.storage.local.set({ scripts: arr });
        } else {
          const arr = rawStyles.filter(isStoredEntry);
          arr.push({ ...common, kind: "style" });
          await browser.storage.local.set({ styles: arr });
        }
      }
      // Language-neutral marker for automation (E2E asserts on this, never on visible text).
      card.dataset.infinDone = "installed";
      card.innerHTML = `<div class="done">✓ 已安装</div>`;
    } catch (e) {
      card.dataset.infinDone = "error";
      card.innerHTML = `<div class="done">安装失败：${String((e as Error).message ?? e)}</div>`;
    }
    setTimeout(() => host.remove(), 3000);
  });
  (shadow.querySelector(".dismiss") as HTMLButtonElement).addEventListener(
    "click",
    () => host.remove(),
  );
}
