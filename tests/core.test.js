import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  planScan,
  revision,
  keyFor,
  DEFAULT_MAP,
  chunks,
} from "../chrome-extension/sync/model.js";
import { NotionAdapter } from "../chrome-extension/sync/notion.js";
const source = fs.readFileSync(
  new URL("../chrome-extension/exporter.user.js", import.meta.url),
  "utf8",
);
const section = (start, end) =>
  source.slice(
    source.indexOf(start),
    source.indexOf(end, source.indexOf(start)),
  );
const entry = {
  id: "conv-1",
  title: "Test",
  update_time: 100,
  create_time: 50,
  is_archived: false,
  projectId: "g-p-1",
  projectTitle: "Project",
};
test("incremental plan: new, unchanged, edited, renamed, moved, archived, unknown timestamps and workspace isolation", () => {
  const records = {
    [keyFor("w", entry.id)]: { ...entry, syncedRevision: revision(entry) },
  };
  assert.equal(planScan([entry], {}, "w").added, 1);
  assert.equal(planScan([entry], records, "w").unchanged, 1);
  for (const patch of [
    { update_time: 101 },
    { title: "Rename" },
    { projectTitle: "Rename" },
    { projectId: null },
    { is_archived: true },
    { update_time: 0 },
  ])
    assert.equal(planScan([{ ...entry, ...patch }], records, "w").updated, 1);
  assert.equal(planScan([entry], records, "other").added, 1);
  assert.equal(planScan([entry, entry], {}, "w").queue.length, 1);
  records[keyFor("w", entry.id)].error = "retry";
  assert.equal(planScan([entry], records, "w").retry, 1);
  assert.throws(() => planScan([{ id: "../../oops" }], {}, "w"));
});
for (const file of ["chrome-extension/exporter.user.js", "Tampermonkey.js"])
  test(`${file}: current_node ancestry only, malformed trees fail closed`, () => {
    const src = fs.readFileSync(new URL("../" + file, import.meta.url), "utf8");
    const code = src.slice(
      src.indexOf("    function extractConversationMessages"),
      src.indexOf("    function convertConversationToMarkdown"),
    );
    const ctx = {
      cleanMessageContent: (s) => s,
      processContentReferences: (s) => ({ text: s, footnotes: [] }),
    };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    const msg = (role, text) => ({
      author: { role },
      content: { content_type: "text", parts: [text] },
    });
    const tree = {
      current_node: "b",
      mapping: {
        root: { parent: null, children: ["u"] },
        u: {
          parent: "root",
          message: msg("user", "question"),
          children: ["a", "b"],
        },
        a: { parent: "u", message: msg("assistant", "OLD") },
        b: { parent: "u", message: msg("assistant", "VISIBLE") },
      },
    };
    assert.deepEqual(
      Array.from(ctx.extractConversationMessages(tree), (m) => m.content),
      ["question", "VISIBLE"],
    );
    assert.throws(() =>
      ctx.extractConversationMessages({ ...tree, current_node: null }),
    );
    tree.mapping.u.parent = "b";
    assert.throws(() => ctx.extractConversationMessages(tree));
  });
test("cache requires known server timestamp, is workspace scoped, invalidates stale data and awaits writes", async () => {
  const cache = new Map([
    ["w:c", { __server_update_time: 100, title: "cached" }],
  ]);
  let requests = 0,
    puts = 0;
  const ctx = {
    ExportCache: {
      get: async (k) => cache.get(k),
      put: async (k, v) => {
        puts++;
        cache.set(k, v);
      },
    },
    resolveWorkspaceId: (w) => w,
    normalizeEpochSeconds: Number,
    getOaiDeviceId: () => "device",
    accessToken: "test",
    MAX_429_ATTEMPTS: 0,
    fetch: async () => {
      requests++;
      return { ok: true, json: async () => ({ title: "fresh" }) };
    },
    Date,
  };
  vm.createContext(ctx);
  vm.runInContext(
    section("    async function getConversation(", "    // --- UI 相关函数"),
    ctx,
  );
  assert.equal(
    (await ctx.getConversation("c", "w", { serverUpdateTime: 100 }))
      .__cache_hit,
    true,
  );
  assert.equal(requests, 0);
  assert.equal(
    (await ctx.getConversation("c", "w", { serverUpdateTime: 101 })).title,
    "fresh",
  );
  assert.equal(puts, 1);
  await ctx.getConversation("c", "other", { serverUpdateTime: 100 });
  await ctx.getConversation("c", "w", {});
  assert.equal(requests, 3);
});
test("manifest uses project IDs for collision-free paths and includes complete metadata", async () => {
  const files = {};
  class Zip {
    folder() {
      return this;
    }
    file(k, v) {
      files[k] = v;
    }
    async generateAsync() {
      return {};
    }
  }
  const ctx = {
    JSZip: Zip,
    getExportButton: () => ({}),
    ensureAccessToken: async () => true,
    COOLDOWN_EVERY: 0,
    resolveWorkspaceId: () => "w",
    EXPORTER_BUILD: "test",
    getConversation: async (id) => ({
      id,
      title: id,
      mapping: {},
      create_time: 1,
    }),
    convertConversationToMarkdown: () => "visible",
    sleep: async () => {},
    jitter: () => 0,
    downloadFile: () => {},
    showExportResult: () => {},
    setTimeout: () => {},
    console,
    alert: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(
    section(
      "    async function exportConversations(",
      "    async function collectFullExportEntries(",
    ),
    ctx,
  );
  await ctx.exportConversations({
    workspaceId: "w",
    conversationEntries: [
      { ...entry, projectId: "g-p-a", projectTitle: "A/B" },
      { ...entry, id: "conv-2", projectId: "g-p-b", projectTitle: "A\\B" },
    ],
  });
  const manifest = JSON.parse(files["EXPORT_MANIFEST.json"]);
  assert.equal(manifest.workspace_id, "w");
  assert.equal(manifest.conversations.length, 2);
  assert.equal(manifest.projects.length, 2);
  for (const e of manifest.conversations) {
    assert.ok(files[e.json_path]);
    assert.ok(files[e.md_path]);
    assert.equal(e.update_time, 100);
    assert.equal(e.is_archived, false);
  }
  assert.notEqual(
    manifest.conversations[0].json_path,
    manifest.conversations[1].json_path,
  );
});
test("global fallback does not assign unmarked or other-project rows and reads later pages", async () => {
  let request = 0;
  const map = new Map();
  const ctx = {
    URLSearchParams,
    PAGE_LIMIT: 2,
    responseItems: (d) => d.items,
    responseCursor: (d) => d.cursor,
    offsetHasMore: (d) => d.more,
    normalizeConversationListItem: (e) => e,
    upsertConversationEntry: (m, e, x) => m.set(e.id, { ...e, ...x }),
    sleep: async () => {},
    jitter: () => 0,
    fetch: async () => {
      const pages = [
        {
          items: [{ id: "u" }, { id: "other", projectId: "other" }],
          more: true,
        },
        { items: [{ id: "yes", projectId: "p" }], more: false },
        { items: [], more: false },
      ];
      return { ok: true, json: async () => pages[request++] };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    section(
      "    async function fetchProjectConversationEntriesViaGlobal(",
      "    function upsertConversationEntry(",
    ),
    ctx,
  );
  await ctx.fetchProjectConversationEntriesViaGlobal(
    { id: "p", title: "P" },
    {},
    map,
  );
  assert.deepEqual([...map.keys()], ["yes"]);
  assert.equal(request, 3);
});
test("Notion canonical upsert rejects duplicates; rate-limit errors expose retry delay without token", async () => {
  const c = {
    token: "DO_NOT_LEAK",
    mapping: DEFAULT_MAP,
    sources: { projects: "x" },
  };
  const adapter = new NotionAdapter(c, async () => ({
    ok: true,
    json: async () => ({ results: [{ id: "1" }, { id: "2" }] }),
  }));
  await assert.rejects(
    () => adapter.project({ id: "p", title: "P" }, "w"),
    /重复/,
  );
  const rate = new NotionAdapter(c, async () => ({
    ok: false,
    status: 429,
    headers: { get: () => "25" },
  }));
  await assert.rejects(
    () => rate.api("users/me"),
    (e) => e.retryAfter === 25 && e.retryable && !e.message.includes(c.token),
  );
});
test("Notion part retry after response loss does not append duplicate content", async () => {
  const blocks = [];
  let writes = 0,
    lose = true;
  const a = new NotionAdapter({});
  a.childBlocks = async () => blocks;
  a.api = async (path, method, body) => {
    writes++;
    blocks.push(...body.children);
    if (lose) {
      lose = false;
      throw new TypeError("lost response");
    }
    return { results: blocks };
  };
  await assert.rejects(() => a.appendPart("revision", 0, "hello"));
  await a.appendPart("revision", 0, "hello");
  assert.equal(writes, 1);
  assert.equal(
    blocks[0].toggle.children[0].paragraph.rich_text[0].text.content,
    "hello",
  );
});
test("paged scanner checkpoints root, archive and project listing; duplicate and incomplete pages fail closed", async () => {
  const replies = [
    { items: [{ id: "a" }], total: 2 },
    { items: [{ id: "b" }], total: 2 },
    { items: [], has_more: false },
    { items: [], has_more: false },
  ];
  let calls = 0;
  const ctx = {
    ensureAccessToken: async () => true,
    accessToken: "fixture",
    getOaiDeviceId: () => "d",
    AbortSignal,
    URLSearchParams,
    PAGE_LIMIT: 1,
    PROJECT_SIDEBAR_LIMIT: 50,
    ExportCache: { size: async () => 0 },
    responseItems: (r) => r.items,
    responseCursor: (r) => r.cursor,
    responseHasMore: (r) => r.has_more,
    offsetHasMore: (r, items, offset) =>
      r.total ? offset < r.total : !!r.has_more,
    normalizeConversationListItem: (e) => e,
    normalizeProjectSpaceItem: (e) => e,
    upsertConversationEntry: (map, e, extra) =>
      map.set(e.id, { ...e, ...extra }),
    fetch: async () => ({ ok: true, json: async () => replies[calls++] }),
  };
  vm.createContext(ctx);
  vm.runInContext(
    section(
      "    async function scanPageForSync(",
      "    async function scanForSync(",
    ),
    ctx,
  );
  const first = await ctx.scanPageForSync("w");
  assert.equal(first.next.offset, 1);
  assert.equal(first.next.stage, "root");
  const second = await ctx.scanPageForSync("w", first.next);
  assert.equal(second.next.archived, true);
  const third = await ctx.scanPageForSync("w", second.next);
  assert.equal(third.next.stage, "sidebar");
  assert.equal((await ctx.scanPageForSync("w", third.next)).next, null);
  calls = 0;
  replies[0] = { items: [{ id: "a" }], total: 2 };
  await assert.rejects(() => ctx.scanPageForSync("w", first.next), /重复分页/);
  replies[1] = { items: [], total: 2 };
  await assert.rejects(() => ctx.scanPageForSync("w", first.next), /空页/);
});

test("Unicode paragraphs preserve astral characters across all chunk boundaries", () => {
  const text = "a".repeat(1499) + "😀".repeat(4000) + "end";
  const parts = chunks(text, 12000).flatMap((t) => chunks(t, 1500));
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((t) => t.length <= 1500));
  for (const part of parts)
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part));
});

test('missing server update_time is never replaced with create_time', () => {
 const ctx = { firstNonEmpty: (...values) => values.find(v => v !== null && v !== undefined && v !== ''), normalizeEpochSeconds: Number };
 vm.createContext(ctx);
 vm.runInContext(section('    function normalizeConversationListItem(', '    function projectPreviewConversations('), ctx);
 vm.runInContext(section('    function upsertConversationEntry(', '    async function listConversations('), ctx);
 const raw = {id:'no-update', title:'Unknown version', create_time:100};
 assert.equal(ctx.normalizeConversationListItem(raw).update_time,0);
 const map = new Map();ctx.upsertConversationEntry(map,raw);
 assert.equal(map.get(raw.id).update_time,0);
});
