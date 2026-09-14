// Runs in MAIN world, deliberately has no chrome API and no Notion credentials.
(() => {
  if (window.__gptSyncPage) return;
  window.__gptSyncPage = true;
  window.addEventListener("message", async (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.type !== "GPT_SYNC_READ"
    )
      return;
    const { id, action, workspace, entry, checkpoint } = event.data;
    let result;
    try {
      const api = window.ChatGPTExporter;
      if (!api) throw new Error("导出器未就绪，请刷新页面");
      const value =
        action === "scan"
          ? await api.scanPageForSync(workspace, checkpoint)
          : action === "detail"
            ? await api.detailForSync(entry, workspace)
            : action === "cache"
              ? { cacheSize: await api.cacheSize() }
              : null;
      result = { ok: true, value };
    } catch (error) {
      result = {
        ok: false,
        error: String(error.message).slice(0, 500),
        retryable: !!error.retryable || error.name === "TimeoutError",
        retryAfter: error.retryAfter,
      };
    }
    window.postMessage({ type: "GPT_SYNC_REPLY", id, result }, location.origin);
  });
})();
