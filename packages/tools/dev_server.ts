/**
 * InfinMonkey local dev-mapping server.
 *
 * Usage: deno task devserver [--dir ./examples] [--port 17321] [--host 127.0.0.1]
 *
 * - GET /<relative path>            serves file contents (no-store, fetched live by scripts)
 * - GET /__infin/health        health check (used by the extension's "test connection")
 * - GET /__infin/ws            WebSocket: pushes file changes {type:"changed", files:[...]}
 * - GET /                      file index page (mapping URLs can be copied)
 */
import { relative, resolve } from "@std/path";

const args = processArgs();
const ROOT = resolve(args.dir);
const PORT = args.port;
const HOST = args.host;

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".user.js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".user.css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const sockets = new Set<WebSocket>();

const requestStats = { count: 0, last: "" };
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
const dirty = new Set<string>();

function processArgs() {
  const get = (name: string, def: string) => {
    const i = Deno.args.indexOf(`--${name}`);
    return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : def;
  };
  return {
    dir: get("dir", "./examples"),
    port: Number(get("port", "17321")),
    host: get("host", "127.0.0.1"),
  };
}

function mimeOf(path: string): string {
  if (path.endsWith(".user.js")) return MIME[".user.js"];
  if (path.endsWith(".user.css")) return MIME[".user.css"];
  return MIME[path.slice(path.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
}

function safePath(urlPath: string): string | null {
  let p = decodeURIComponent(urlPath);
  if (p.includes("\0")) return null;
  p = p.replace(/^\/+/, "");
  if (p.includes("..")) return null;
  return p === "" ? null : p;
}

async function serveFile(path: string, asHtml = false): Promise<Response> {
  const full = resolve(ROOT, path);
  if (!full.startsWith(ROOT)) return new Response("Forbidden", { status: 403 });
  const stat = await Deno.stat(full).catch(() => null);
  if (!stat?.isFile) return new Response("Not Found", { status: 404 });
  // ?as=html: wraps the source text as text/html (for WebDriver automation on the official Firefox,
  // which refuses execute on text/plain documents; the installer recognizes this view by the .user.js/.css path)
  if (asHtml) {
    const text = await Deno.readTextFile(full);
    const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>${path}</title><pre style="white-space:pre-wrap">${escaped}</pre>`,
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  }
  const body = await Deno.readFile(full);
  return new Response(body, {
    headers: {
      "content-type": mimeOf(full),
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

async function indexPage(): Promise<Response> {
  const files: string[] = [];
  for await (const p of walkFiles(ROOT)) files.push(relative(ROOT, p).replaceAll("\\", "/"));
  files.sort();
  const rows = files.map((f) => {
    const url = `http://${HOST}:${PORT}/${f}`;
    const kind = f.endsWith(".user.js") ? "script" : f.endsWith(".user.css") ? "style" : "file";
    return `<tr><td>${kind}</td><td><code>/${f}</code></td><td class="acts">
      <button data-u="${url}">Copy URL</button>
      <a href="/${f}">Open</a></td></tr>`;
  }).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>InfinMonkey Dev Server</title>
<style>
  body{font:14px/1.6 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#e8e8ea;background:#17171b}
  h1{font-size:20px} code{background:#232329;padding:2px 6px;border-radius:4px}
  table{width:100%;border-collapse:collapse;margin-top:16px}
  td{padding:8px 6px;border-bottom:1px solid #2b2b33}
  button,a{color:#e91e63;background:none;border:none;cursor:pointer;font:inherit;text-decoration:none;margin-right:10px}
  .hint{color:#9a9aa5}
</style>
<h1>🐵 InfinMonkey Dev Server</h1>
<p class="hint">Root directory <code>${ROOT}</code>. Paste the URLs below into a script/style's "local mapping"; saved files are pushed to the extension automatically.</p>
<table><tr><td>Type</td><td>Path</td><td></td></tr>${rows}</table>
<script>
document.addEventListener('click', (e) => {
  const u = e.target?.dataset?.u;
  if (u) { navigator.clipboard.writeText(u); e.target.textContent = 'Copied'; setTimeout(() => e.target.textContent = 'Copy URL', 1200); }
});
</script>`;
  return new Response(html, {
    headers: { "content-type": MIME[".html"], "cache-control": "no-store" },
  });
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = resolve(dir, e.name);
    if (e.isDirectory) yield* walkFiles(p);
    else if (e.isFile) yield p;
  }
}

function broadcastChanged(files: string[]): void {
  const msg = JSON.stringify({ type: "changed", files });
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function handle(req: Request): Response | Promise<Response> {
  requestStats.count++;
  requestStats.last = new URL(req.url).pathname;
  const url = new URL(req.url);
  if (url.pathname === "/__infin/health") {
    return new Response(
      JSON.stringify({ ok: true, root: ROOT, requests: requestStats }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }
  if (url.pathname === "/__infin/ws") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => sockets.add(socket);
    socket.onclose = () => sockets.delete(socket);
    socket.onerror = () => sockets.delete(socket);
    return response;
  }
  if (url.pathname === "/") return indexPage();
  const rel = safePath(url.pathname);
  if (!rel) return new Response("Bad Request", { status: 400 });
  // Only real navigations (Accept: text/html) get the wrapped view; extension background fetches (Accept: */*) get the raw code
  const wantsHtml = url.searchParams.get("as") === "html" &&
    (req.headers.get("accept") ?? "").includes("text/html");
  return serveFile(rel, wantsHtml);
}

function startWatch(): void {
  try {
    const watcher = Deno.watchFs(ROOT, { recursive: true });
    void (async () => {
      for await (const ev of watcher) {
        if (
          ev.kind !== "modify" && ev.kind !== "create" && ev.kind !== "rename" && ev.kind !== "any"
        ) continue;
        for (const p of ev.paths) {
          const rel = relative(ROOT, p).replaceAll("\\", "/");
          if (rel.startsWith("..") || rel.startsWith(".")) continue;
          dirty.add(rel);
        }
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          const files = [...dirty];
          dirty.clear();
          if (files.length) {
            broadcastChanged(files);
            console.log(`[devserver] pushed changes: ${files.join(", ")}`);
          }
        }, 300);
      }
    })();
  } catch (e) {
    console.warn("[devserver] file watcher failed to start:", e);
  }
}

console.log(`[devserver] root: ${ROOT}`);
Deno.serve({ port: PORT, hostname: HOST }, handle);
startWatch();
