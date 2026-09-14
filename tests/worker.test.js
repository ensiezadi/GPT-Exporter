import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAP,
  revision,
  keyFor,
} from "../chrome-extension/sync/model.js";
const clone = (x) => (x === undefined ? undefined : structuredClone(x)),
  db = {},
  listeners = [],
  alarms = {},
  ticks = [];
const sourceIds = {
  projects: "11111111-1111-1111-1111-111111111111",
  conversations: "22222222-2222-2222-2222-222222222222",
  runs: "33333333-3333-3333-3333-333333333333",
};
const e = {
  id: "conv",
  title: "Hello",
  create_time: 10,
  update_time: 20,
  projectId: "project",
  projectTitle: "Project",
  is_archived: false,
};
let details = 0,
  notionCalls = 0,
  failDetail = false;
const checkpoints = [];
// Minimal async IDB transaction fixture; real origin isolation is browser-tested.
global.indexedDB = {
  open: () => {
    const request = {};
    setImmediate(() => {
      request.result = {
        createObjectStore: () => {},
        transaction: () => {
          const tx = {
            objectStore: () => ({
              get: (key) => {
                const r = {};
                setImmediate(() => {
                  r.result = clone(db[key]);
                  r.onsuccess();
                });
                return r;
              },
              put: (value, key) => {
                db[key] = clone(value);
                if (
                  key === "syncState" &&
                  value.job?.phase === "content" &&
                  value.job.current.part === 1
                )
                  checkpoints.push(clone(value));
                setImmediate(() => tx.oncomplete());
              },
              delete: (key) => {
                delete db[key];
                setImmediate(() => tx.oncomplete());
              },
            }),
          };
          return tx;
        },
      };
      request.onsuccess();
    });
    return request;
  },
};
const event = (target) => ({ addListener: (f) => target.push(f) });
global.chrome = {
  storage: {
    local: {
      setAccessLevel: async () => {},
      get: async (k) => ({ [k]: clone(db[k]) }),
      set: async (v) => {
        Object.assign(db, clone(v));
        if (
          v.syncState?.job?.phase === "content" &&
          v.syncState.job.current.part === 1
        )
          checkpoints.push(clone(v.syncState));
      },
      remove: async (k) => {
        delete db[k];
      },
    },
  },
  runtime: {
    id: "ext",
    getURL: (p) => "chrome-extension://ext/" + p,
    onMessage: event(listeners),
    onStartup: event([]),
    openOptionsPage: async () => {},
  },
  alarms: {
    create: async (n, v) => {
      alarms[n] = v;
    },
    clear: async (n) => {
      delete alarms[n];
    },
    onAlarm: event(ticks),
  },
  tabs: {
    query: async () => [{ id: 1, active: true }],
    sendMessage: async (id, m) => {
      if (m.action === "scan")
        return {
          ok: true,
          value: {
            entries: [e],
            projects: [{ id: "project", title: "Project" }],
            cacheSize: 2,
          },
        };
      details++;
      if (failDetail) return { ok: false, error: "detail failure" };
      return {
        ok: true,
        value: { id: e.id, markdown: "hello ".repeat(2500), cacheHit: false },
      };
    },
  },
};
const pages = new Map(),
  blocks = new Map();
let serial = 0;
global.fetch = async (url, opt) => {
  notionCalls++;
  const path = url.replace("https://api.notion.com/v1/", ""),
    body = opt.body ? JSON.parse(opt.body) : null;
  let result;
  if (path.endsWith("/query")) {
    const key = path.split("/")[1] + ":" + body.filter.rich_text.equals;
    result = {
      results: pages.has(key) ? [pages.get(key)] : [],
      has_more: false,
    };
  } else if (path === "pages") {
    const property =
      Object.values(body.properties).find(
        (v) =>
          v.rich_text?.[0]?.text?.content &&
          ["conv", "project"].includes(v.rich_text[0].text.content),
      ) || Object.entries(body.properties).find(([k]) => k === "Run ID")?.[1];
    const idValue = property.rich_text[0].text.content;
    result = { id: "page-" + ++serial };
    pages.set(body.parent.data_source_id + ":" + idValue, result);
  } else if (path.startsWith("pages/")) result = { id: path.split("/")[1] };
  else if (path.startsWith("blocks/")) {
    const key = path.split("/")[1];
    if (opt.method === "PATCH") {
      const added = body.children.map((b) => ({
        ...b,
        id: "block-" + ++serial,
      }));
      blocks.set(key, [...(blocks.get(key) || []), ...added]);
      result = { results: added };
    } else result = { results: blocks.get(key) || [], has_more: false };
  } else throw new Error("Unexpected " + path);
  return { ok: true, json: async () => result };
};
await import("../chrome-extension/sync/worker.js");
const sender = {
  id: "ext",
  url: "chrome-extension://ext/pages/options.html",
  tab: { id: 99 },
};
async function command(action, extra = {}, from = sender) {
  return new Promise((resolve) => {
    for (const l of listeners) {
      const v = l(
        { type: "GPT_SYNC_CONTROL", action, ...extra },
        from,
        resolve,
      );
      if (v === true) return;
    }
  });
}
async function until(predicate) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) {
      await new Promise((r) => setImmediate(r));
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timeout waiting for worker: " + db.syncState?.job?.phase);
}
test("worker security, review gate, successful sync, no-change scan and durable failure retry", async () => {
  const denied = await command(
    "status",
    {},
    { id: "ext", tab: { id: 1 }, url: "https://chatgpt.com/" },
  );
  assert.equal(denied.ok, false);
  const config = {
    workspace: "w",
    token: "SECRET",
    sources: sourceIds,
    mapping: DEFAULT_MAP,
    autoSync: false,
    interval: 60,
  };
  assert.equal((await command("save", { config })).ok, true);
  const status = await command("status");
  assert.ok(!JSON.stringify(status).includes("SECRET"));
  assert.equal((await command("scan")).ok, true);
  await until(() => db.syncState.job.phase === "review");
  assert.equal(notionCalls, 0);
  assert.equal(details, 0);
  assert.equal((await command("resume")).ok, true);
  await until(() => db.syncState.job.phase === "complete");
  assert.equal(
    db.syncState.records[keyFor("w", e.id)].syncedRevision,
    revision(e),
  );
  assert.equal(details, 1);
  assert.ok(db.syncState.lastSync);
  await command("scan");
  await until(() => db.syncState.job.phase === "review");
  assert.equal(db.syncState.summary.unchanged, 1);
  assert.equal(db.syncState.job.queue.length, 0);
  // A timer must respect autoSync=false, not silently write into Notion.
  const before = notionCalls,
    oldJob = db.syncState.job.id;
  await ticks[0]({ name: "gpt-sync-auto" });
  await until(
    () => db.syncState.job.id !== oldJob && db.syncState.job.phase === "review",
  );
  assert.equal(notionCalls, before);
  // Inject failure; an unsynced record must not advance the revision.
  e.update_time = 21;
  failDetail = true;
  await command("scan");
  await until(() => db.syncState.job.phase === "review");
  await command("resume");
  await until(() => db.syncState.job.phase === "partial");
  assert.equal(db.syncState.job.failures.length, 1);
  assert.notEqual(
    db.syncState.records[keyFor("w", e.id)].syncedRevision,
    revision(e),
  );
  failDetail = false;
  await command("resume");
  await until(() => db.syncState.job.phase === "complete");
  assert.equal(
    db.syncState.records[keyFor("w", e.id)].syncedRevision,
    revision(e),
  );
  // Restore a persisted halfway checkpoint into a fresh service-worker module.
  const blockCount = () =>
    [...blocks.values()].reduce((n, list) => n + list.length, 0);
  const beforeRestart = blockCount();
  db.syncState = clone(checkpoints.at(-1));
  await import("../chrome-extension/sync/worker.js?restart=1");
  ticks.at(-1)({ name: "gpt-sync-resume" });
  await until(() => db.syncState.job.phase === "complete");
  assert.equal(blockCount(), beforeRestart);
});
