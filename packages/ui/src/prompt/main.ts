/** @connect 授权弹窗：用户选择后回传 background，等待中的请求随即放行或拒绝。 */
import { h, msg } from "../dom.ts";

const params = new URLSearchParams(location.search);
const scriptId = params.get("script") ?? "";
const domain = params.get("domain") ?? "";

void (async () => {
  if (scriptId) {
    const res = await msg<{ entry: { meta: { name: string } } | null }>({
      type: "GetEntry",
      id: scriptId,
    });
    const el = h("span", {}, res.entry?.meta.name ?? "（未知脚本）");
    document.getElementById("script-name")?.replaceChildren(el);
  }
  document.getElementById("domain")!.textContent = domain;
})();

async function answer(scope: "once" | "always" | "deny"): Promise<void> {
  await msg({ type: "ConfirmConnectAuth", scriptId, domain, scope });
  window.close();
}

document.getElementById("once")?.addEventListener("click", () => void answer("once"));
document.getElementById("always")?.addEventListener("click", () => void answer("always"));
document.getElementById("deny")?.addEventListener("click", () => void answer("deny"));
