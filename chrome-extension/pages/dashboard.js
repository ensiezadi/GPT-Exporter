const $ = (id) => document.getElementById(id);
const call = async (action, extra = {}) => {
  const r = await chrome.runtime.sendMessage({
    type: "GPT_SYNC_CONTROL",
    action,
    ...extra,
  });
  if (!r?.ok) throw new Error(r?.error || "后台无响应");
  return r;
};
const put = (id, text) => {
  if ($(id)) $(id).textContent = text;
};
const date = (s) => (s ? new Date(s).toLocaleString() : "—");
const labels = {
  scan: "扫描中",
  review: "扫描完成，等待同步",
  projects: "同步项目",
  detail: "读取对话正文",
  page: "更新对话信息",
  revision: "检查正文版本",
  content: "写入正文",
  finish: "记录同步结果",
  complete: "全部同步成功",
  partial: "部分失败，可重试",
  error: "已暂停，需要处理",
};
let snapshot;
function rows(id, data) {
  if (!$(id)) return;
  $(id).replaceChildren(
    ...data.map((cells) => {
      const tr = document.createElement("tr");
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text ?? "—";
        tr.append(td);
      }
      return tr;
    }),
  );
}
function render(state, config) {
  snapshot = state;
  const j = state.job;
  put("connection", config.connected ? "已保存连接" : "未连接 Notion");
  put("projects-count", state.projects.length);
  put("conversations-count", state.summary?.total ?? "—");
  put(
    "pending-count",
    state.summary
      ? Math.max(
          0,
          state.summary.added +
            state.summary.updated +
            state.summary.retry -
            (j?.index || 0),
        )
      : "—",
  );
  put("cache-count", state.cacheSize ?? "—");
  put(
    "sync-status",
    j
      ? `${labels[j.phase] || j.phase} · 成功 ${j.completed || 0} · 失败 ${j.failures?.length || 0} · 缓存命中 ${j.hits || 0} / 新拉取 ${j.fetched || 0}`
      : "尚未扫描",
  );
  put(
    "last-times",
    `上次扫描：${date(state.lastScan)} · 上次全部同步成功：${date(state.lastSync)}`,
  );
  const s = state.summary;
  put(
    "summary",
    s
      ? `新增 ${s.added} · 更新 ${s.updated} · 未变化 ${s.unchanged} · 重试 ${s.retry}`
      : "",
  );
  if ($("progress")) {
    $("progress").max = Math.max(
      1,
      (s?.added || 0) + (s?.updated || 0) + (s?.retry || 0),
    );
    $("progress").value = j?.index || 0;
  }
  if ($("job-error")) {
    $("job-error").classList.toggle("hidden", !j?.error);
    put("job-error", j?.error || "");
  }
  const active =
    j && !["review", "complete", "partial", "error"].includes(j.phase);
  if ($("scan")) $("scan").disabled = !!active;
  if ($("resume"))
    $("resume").disabled = !j || !!active || j.phase === "complete";
  rows(
    "projects",
    state.projects.map((p) => [p.title, p.id]),
  );
  renderConversations();
  if ($("failures")) {
    $("failures").replaceChildren();
    for (const f of j?.failures || []) {
      const p = document.createElement("p");
      p.className = "notice error";
      p.textContent = `${f.entry.title} (${f.entry.id})：${f.error}`;
      $("failures").append(p);
    }
    if (!j?.failures?.length) put("failures", "暂无失败记录。");
  }
}
function renderConversations() {
  const q = $("search")?.value.toLowerCase() || "";
  rows(
    "conversations",
    (snapshot?.records || [])
      .filter((e) => `${e.title} ${e.id}`.toLowerCase().includes(q))
      .slice(0, 500)
      .map((e) => [
        e.title || e.id,
        e.projectTitle || "项目外",
        date(e.syncedAt),
        e.error || "已同步",
      ]),
  );
}
async function refresh(fill = false) {
  const r = await call("status");
  render(r.state, r.config);
  if (r.scheduleError) {
    put("job-error", r.scheduleError);
    $("job-error")?.classList.remove("hidden");
  }
  if (fill && $("config-form")) {
    const c = r.config;
    put("mapping", JSON.stringify(c.mapping || r.defaultMap, null, 2));
    $("mapping").value = JSON.stringify(c.mapping || r.defaultMap, null, 2);
    $("workspace").value = c.workspace || "";
    for (const k of ["projects", "conversations", "runs"])
      $("source-" + k).value = c.sources?.[k] || "";
    $("interval").value = String(c.interval || 0);
    $("auto-sync").checked = !!c.autoSync;
  }
}
async function action(fn) {
  put("feedback", "正在处理…");
  try {
    await fn();
    put("feedback", "操作完成");
    await refresh();
  } catch (e) {
    put("feedback", e.message);
  }
}
$("center")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
for (const id of ["scan", "resume", "test", "disconnect"])
  $(id)?.addEventListener("click", () => action(() => call(id)));
$("search")?.addEventListener("input", renderConversations);
$("config-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void action(async () => {
    await call("save", {
      config: {
        workspace: $("workspace").value,
        token: $("token").value.trim(),
        sources: Object.fromEntries(
          ["projects", "conversations", "runs"].map((k) => [
            k,
            $("source-" + k).value.trim(),
          ]),
        ),
        mapping: JSON.parse($("mapping").value),
        interval: Number($("interval").value),
        autoSync: $("auto-sync").checked,
      },
    });
    $("token").value = "";
  });
});
$("export")?.addEventListener("click", () =>
  action(async () => {
    const tabs = await chrome.tabs.query({
      url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
    });
    const tab = tabs.find((t) => t.active) || tabs[0];
    if (!tab) {
      await chrome.tabs.create({ url: "https://chatgpt.com" });
      return;
    }
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.tabs.sendMessage(tab.id, { type: "OPEN_EXPORT_DIALOG" });
  }),
);
refresh(true).catch((e) => put("feedback", e.message));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.syncRevision) refresh().catch(() => {});
});
