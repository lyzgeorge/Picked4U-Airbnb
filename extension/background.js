// All backend calls go through here, so the Airbnb page's CSP/CORS never gets involved.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "recommend") return false;
  (async () => {
    const { backendUrl = "", apiToken = "" } = await chrome.storage.local.get(["backendUrl", "apiToken"]);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const r = await fetch(backendUrl.replace(/\/+$/, "") + "/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Token": apiToken },
        body: JSON.stringify(msg.payload),
        signal: ctrl.signal,
      });
      sendResponse(r.ok ? await r.json() : { status: "error", code: r.status });
    } catch (e) {
      sendResponse({ status: "error", error: String(e) });
    } finally {
      clearTimeout(timer);
    }
  })();
  return true; // keep the channel open for the async reply
});
