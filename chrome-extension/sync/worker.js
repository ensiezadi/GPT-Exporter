import {
  DEFAULT_MAP,
  keyFor,
  revision,
  planScan,
  digest,
  validateEntry,
  chunks,
} from "./model.js";
import { createAdapter } from "./notion.js";
import { read as get, write, remove } from "./store.js";
const TICK = "gpt-sync-resume",
  AUTO = "gpt-sync-auto";
const ready = Promise.resolve();
let busy = false,
  commandBusy = false;
const notify = () => chrome.storage.local.set({ syncRevision: Date.now() });
const save = async (state) => {
  await write("syncState", state);
  await notify();
};
const initial = () => ({
  records: {},
  projects: [],
  job: null,
  lastScan: null,
  lastSync: null,
  cacheSize: null,
});
const terminal = (phase) =>
  ["review", "complete", "partial", "error"].includes(phase);
function validateConfig(input, old = {}) {
  const c = {
    workspace: String(input.workspace || "").trim(),
    token: input.token || old.token || "",
    sources: input.sources,
    mapping: input.mapping || DEFAULT_MAP,
    autoSync: !!input.autoSync,
    interval: Number(input.interval) || 0,
  };
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(c.workspace))
    throw new Error("请填写当前 ChatGPT Workspace ID");
  for (const k of ["projects", "conversations", "runs"]) {
    if (!/^[a-fA-F0-9-]{32,36}$/.test(c.sources?.[k] || ""))
      throw new Error(`${k}: 请填写 Notion data source ID`);
    for (const field of Object.keys(DEFAULT_MAP[k]))
      if (
        typeof c.mapping?.[k]?.[field] !== "string" ||
        !c.mapping[k][field].trim()
      )
        throw new Error(`${k}.${field}: 缺少字段映射`);
  }
  if (c.interval && c.interval < 60)
    throw new Error("自动扫描间隔至少 60 分钟");
  return c;
}
async function readPage(job, action, entry) {
  const result = await chrome.tabs.sendMessage(job.tabId, {
    type: "GPT_SYNC_READ",
    action,
    workspace: job.workspace,
    entry,
    checkpoint: action === "scan" ? job.scanCheckpoint : undefined,
  });
  if (!result?.ok) {
    const error = new Error(
      result?.error || "无法连接 ChatGPT 页面，请刷新页面",
    );
    error.retryable = !!result?.retryable;
    error.retryAfter = result?.retryAfter;
    throw error;
  }
  return result.value;
}
async function chooseTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  });
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) throw new Error("请先打开并登录 ChatGPT，再重试");
  return tab.id;
}
async function start(auto = false) {
  const config = await get("syncConfig");
  if (!config) throw new Error("请先保存连接配置");
  const state = (await get("syncState")) || initial();
  if (state.job && !terminal(state.job.phase))
    throw new Error("已有任务正在进行");
  const tabId = await chooseTab();
  state.job = {
    id: crypto.randomUUID(),
    tabId,
    workspace: config.workspace,
    phase: "scan",
    started: new Date().toISOString(),
    auto: config.autoSync,
    queue: [],
    index: 0,
    projectIndex: 0,
    projectPages: {},
    completed: 0,
    failures: [],
    hits: 0,
    fetched: 0,
  };
  await remove("syncScheduleError");
  await save(state);
  await chrome.alarms.create(TICK, { periodInMinutes: 1 });
  void pump();
}
async function pump() {
  if (busy) return;
  busy = true;
  try {
    await ready;
    const state = await get("syncState"),
      config = await get("syncConfig");
    const j = state?.job;
    if (!j || terminal(j.phase)) return;
    if (j.retryAt > Date.now()) return;
    const adapter = createAdapter(config),
      deadline = Date.now() + 18000;
    while (Date.now() < deadline && !terminal(j.phase)) {
      try {
        if (j.phase === "scan") {
          const result = await readPage(j, "scan");
          if (
            !Array.isArray(result.entries) ||
            result.entries.length > 100000 ||
            !Array.isArray(result.projects)
          )
            throw new Error("扫描结果格式无效");
          j.scanEntries ||= {};
          j.scanProjects ||= {};
          for (const raw of result.entries) {
            const entry = validateEntry(raw);
            const previous = j.scanEntries[entry.id];
            j.scanEntries[entry.id] = {
              ...previous,
              ...entry,
              projectId: entry.projectId || previous?.projectId || null,
              projectTitle:
                entry.projectTitle || previous?.projectTitle || null,
            };
          }
          for (const p of result.projects)
            j.scanProjects[validateEntry(p).id] = {
              id: String(p.id),
              title: String(p.title || p.id),
            };
          j.scanCheckpoint = result.next || null;
          if (result.next) {
            await save(state);
            continue;
          }
          for (const e of Object.values(j.scanEntries))
            if (j.scanProjects[e.projectId])
              e.projectTitle = j.scanProjects[e.projectId].title;
          const plan = planScan(
            Object.values(j.scanEntries),
            state.records,
            j.workspace,
          );
          state.projects = Object.values(j.scanProjects);
          delete j.scanEntries;
          delete j.scanProjects;
          delete j.scanCheckpoint;
          state.summary = {
            added: plan.added,
            updated: plan.updated,
            unchanged: plan.unchanged,
            retry: plan.retry,
            total: plan.entries.length,
          };
          state.lastScan = new Date().toISOString();
          state.cacheSize = result.cacheSize;
          j.queue = plan.queue;
          j.projects = state.projects;
          j.phase = j.auto ? "projects" : "review";
          if (j.auto && !config.token) throw new Error("尚未配置 Notion token");
        } else if (j.phase === "projects") {
          if (!config.token) throw new Error("请连接 Notion 后继续");
          if (!j.runPage) {
            j.runPage = (await adapter.run(j)).id;
          }
          if (j.projectIndex < j.projects.length) {
            const p = j.projects[j.projectIndex];
            j.projectPages[p.id] = (await adapter.project(p, j.workspace)).id;
            j.projectIndex++;
          } else j.phase = "detail";
        } else if (j.phase === "detail") {
          if (j.index >= j.queue.length) {
            j.phase = "finish";
            continue;
          }
          const e = j.queue[j.index],
            data = await readPage(j, "detail", e);
          if (
            data.id !== e.id ||
            typeof data.markdown !== "string" ||
            data.markdown.length > 12000000
          )
            throw new Error("对话正文无效或超过 12 MB 限制");
          if (data.cacheHit) j.hits++;
          else j.fetched++;
          const hash = await digest(data.markdown);
          j.current = { markdown: data.markdown, hash, part: 0 };
          j.phase = "page";
        } else if (j.phase === "page") {
          const e = j.queue[j.index];
          if (e.projectId && !j.projectPages[e.projectId])
            j.projectPages[e.projectId] = (
              await adapter.project(
                { id: e.projectId, title: e.projectTitle },
                j.workspace,
              )
            ).id;
          j.current.pageId = (
            await adapter.conversation(
              e,
              j.workspace,
              j.projectPages[e.projectId],
            )
          ).id;
          j.phase = "revision";
        } else if (j.phase === "revision") {
          j.current.revisionId = await adapter.ensureRevision(
            j.current.pageId,
            j.current.hash,
          );
          j.phase = "content";
        } else if (j.phase === "content") {
          const c = j.current;
          const parts = chunks(c.markdown, 12000);
          if (c.part < parts.length) {
            await adapter.appendPart(c.revisionId, c.part, parts[c.part]);
            c.part++;
          } else {
            const e = j.queue[j.index];
            state.records[keyFor(j.workspace, e.id)] = {
              ...e,
              syncedRevision: revision(e),
              pageId: c.pageId,
              syncedAt: new Date().toISOString(),
            };
            j.index++;
            j.completed++;
            delete j.current;
            j.phase = "detail";
          }
        } else if (j.phase === "finish") {
          j.finished = new Date().toISOString();
          j.phase = j.failures.length ? "partial" : "complete";
          await adapter.run(j);
          if (!j.failures.length) state.lastSync = j.finished;
        }
        j.attempts = 0;
        j.retryAt = 0;
        j.error = null;
        await save(state);
      } catch (error) {
        const message = String(error.message).slice(0, 500);
        if (
          (error.retryable ||
            error.name === "TimeoutError" ||
            error instanceof TypeError) &&
          (j.attempts || 0) < 4
        ) {
          j.attempts = (j.attempts || 0) + 1;
          j.retryAt =
            Date.now() +
            Math.max(error.retryAfter || 10, 2 ** j.attempts) * 1000;
          j.error = message;
          await save(state);
          return;
        }
        if (["detail", "page", "revision", "content"].includes(j.phase)) {
          const e = j.queue[j.index];
          j.failures.push({ entry: e, error: message });
          const k = keyFor(j.workspace, e.id);
          state.records[k] = { ...e, ...state.records[k], error: message };
          j.index++;
          delete j.current;
          j.phase = "detail";
          j.attempts = 0;
          await save(state);
        } else {
          j.resumePhase =
            j.phase === "complete" || j.phase === "partial"
              ? "finish"
              : j.phase;
          j.phase = "error";
          j.error = message;
          await save(state);
          return;
        }
      }
    }
    if (terminal(j.phase)) await chrome.alarms.clear(TICK);
  } finally {
    busy = false;
  }
}
async function command(message) {
  await ready;
  if (message.action === "status") {
    const state = (await get("syncState")) || initial(),
      config = await get("syncConfig");
    const { token, ...safe } = config || {};
    const scheduleError = await get("syncScheduleError");
    const j = state.job;
    return {
      state: {
        ...state,
        records: Object.values(state.records),
        job: j
          ? {
              ...j,
              current: undefined,
              queue: undefined,
              projectPages: undefined,
              scanEntries: undefined,
              scanProjects: undefined,
              scanCheckpoint: undefined,
            }
          : null,
      },
      scheduleError,
      config: { ...safe, connected: !!token },
      defaultMap: DEFAULT_MAP,
    };
  }
  if (commandBusy) throw new Error("操作正在保存，请稍后重试");
  commandBusy = true;
  try {
    if (busy) throw new Error("后台正在处理，请稍后重试");
    if (message.action === "save") {
      const state = await get("syncState");
      if (state?.job && !terminal(state.job.phase))
        throw new Error("同步进行中，不能修改连接");
      const config = validateConfig(message.config, await get("syncConfig"));
      const old = await get("syncConfig");
      const changed =
        old &&
        JSON.stringify([old.workspace, old.sources, old.mapping]) !==
          JSON.stringify([config.workspace, config.sources, config.mapping]);
      if (
        changed &&
        state?.job &&
        ["review", "partial", "error"].includes(state.job.phase)
      )
        throw new Error(
          "存在未完成队列，不能更换目标或字段映射；请先完成当前任务",
        );
      if (changed) await save(initial());
      await write("syncConfig", config);
      await notify();
      await chrome.alarms.clear(AUTO);
      if (config.interval)
        await chrome.alarms.create(AUTO, { periodInMinutes: config.interval });
    } else if (message.action === "test") {
      await createAdapter(await get("syncConfig")).test();
    } else if (message.action === "disconnect") {
      const state = await get("syncState");
      if (state?.job && !terminal(state.job.phase))
        throw new Error("请等待当前任务结束");
      const config = await get("syncConfig");
      if (config) {
        config.token = "";
        config.autoSync = false;
        config.interval = 0;
        await write("syncConfig", config);
        await notify();
      }
      await chrome.alarms.clear(AUTO);
    } else if (message.action === "scan") await start();
    else if (message.action === "resume") {
      const state = await get("syncState"),
        j = state?.job;
      if (!j) throw new Error("请先扫描");
      j.tabId = await chooseTab();
      if (j.phase === "review") j.phase = "projects";
      else if (j.phase === "partial") {
        j.queue = j.failures.map((f) => f.entry);
        j.failures = [];
        j.index = 0;
        j.phase = "detail";
        delete j.finished;
      } else if (j.phase === "error") {
        j.phase = j.resumePhase || "scan";
        j.error = null;
        j.attempts = 0;
      } else if (j.phase === "complete")
        throw new Error("当前任务已完成，可扫描新增与更新");
      await save(state);
      await chrome.alarms.create(TICK, { periodInMinutes: 1 });
      void pump();
    } else throw new Error("未知操作");
    return { ok: true };
  } finally {
    commandBusy = false;
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // All privileged commands must originate from extension-owned UI, never content scripts.
  if (["GPT_SYNC_PUBLIC", "GPT_SYNC_OPEN"].includes(message?.type)) {
    if (
      sender.id !== chrome.runtime.id ||
      !sender.tab ||
      !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url || "")
    )
      return false;
    if (message.type === "GPT_SYNC_OPEN") {
      void chrome.runtime.openOptionsPage();
      respond({ ok: true });
      return false;
    }
    ready
      .then(() => get("syncState"))
      .then((s) =>
        respond({
          phase: s?.job?.phase || "idle",
          lastSync: s?.lastSync || null,
          failed: s?.job?.failures?.length || 0,
        }),
      );
    return true;
  }
  if (message?.type !== "GPT_SYNC_CONTROL") return false;
  if (
    sender.id !== chrome.runtime.id ||
    ![
      chrome.runtime.getURL("pages/options.html"),
      chrome.runtime.getURL("pages/popup.html"),
    ].includes(sender.url?.split("?")[0].split("#")[0])
  ) {
    respond({ ok: false, error: "Unauthorized sender" });
    return false;
  }
  command(message).then(
    (value) => respond({ ok: true, ...value }),
    (error) =>
      respond({ ok: false, error: String(error.message).slice(0, 500) }),
  );
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK) void pump();
  if (alarm.name === AUTO)
    void start(true).catch(async (error) => {
      await write("syncScheduleError", String(error.message).slice(0, 500));
      await notify();
    });
});
chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(TICK, { periodInMinutes: 1 });
  void pump();
});
