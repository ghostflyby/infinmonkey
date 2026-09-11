import browser from "webextension-polyfill";

// ---- Menu-command/notification tab targeting (best effort). ----
// Some kernels report an empty tabs.query() inside the background event page,
// so a log maintained from tabs.onUpdated events is the reliable source there.
const tabUrlLog = new Map<number, string[]>();

browser.tabs.onUpdated.addListener(
  (tabId: number, changeInfo: { url?: string }, tab: { url?: string }) => {
    const url = changeInfo.url ?? tab.url;
    if (!url) return;
    const list = tabUrlLog.get(tabId) ?? [];
    if (list[list.length - 1] !== url) {
      list.push(url);
      if (list.length > 8) list.shift();
    }
    tabUrlLog.set(tabId, list);
  },
);

browser.tabs.onRemoved.addListener((tabId: number) => {
  tabUrlLog.delete(tabId);
});

export async function findTabIdByUrl(url: string): Promise<number | null> {
  const bare = url.split("#")[0];
  let best: { tabId: number; at: number } | null = null;
  for (const [tabId, urls] of tabUrlLog) {
    const idx = urls.findIndex((u) => u.split("#")[0] === bare);
    if (idx >= 0 && (!best || idx > 0)) best = { tabId, at: idx };
  }
  if (best) return best.tabId;
  // Log miss: try the tabs API directly (may be empty in some kernels)
  try {
    const tabs = await browser.tabs.query({ url: url.split("#")[0] });
    if (tabs.length === 1 && tabs[0].id != null) return tabs[0].id;
  } catch {
    // ignore
  }
  return null;
}
