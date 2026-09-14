(() => {
  if (window.__gptSyncBridge) return;
  window.__gptSyncBridge = true;
  const pending = new Map();
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.type !== "GPT_SYNC_REPLY"
    )
      return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    clearTimeout(request.timer);
    request.respond(event.data.result);
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (
      sender.id !== chrome.runtime.id ||
      message?.type !== "GPT_SYNC_READ" ||
      !["scan", "detail", "cache"].includes(message.action)
    )
      return false;
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      respond({
        ok: false,
        error: "页面读取超时，请保持 ChatGPT 标签页打开后重试",
      });
    }, 240000);
    pending.set(id, { respond, timer });
    window.postMessage(
      {
        type: "GPT_SYNC_READ",
        id,
        action: message.action,
        workspace: message.workspace,
        entry: message.entry,
        checkpoint: message.checkpoint,
      },
      location.origin,
    );
    return true;
  });
})();
// Read-only public status; no configuration or token is returned to MAIN world.
async function refreshPublicSync() {
  try {
    const s = await chrome.runtime.sendMessage({ type: "GPT_SYNC_PUBLIC" });
    document.documentElement.setAttribute(
      "data-gpt-sync-summary",
      `Sync: ${s.phase} · 失败 ${s.failed} · 上次成功 ${s.lastSync || "—"}`,
    );
  } catch (_) {}
}
refreshPublicSync();
setInterval(refreshPublicSync, 60000);
// Opening the extension UI conveys no authority to initiate a sync or change credentials.
document.addEventListener("GPT_OPEN_SYNC_UI", () => {
  void chrome.runtime.sendMessage({ type: "GPT_SYNC_OPEN" });
});
