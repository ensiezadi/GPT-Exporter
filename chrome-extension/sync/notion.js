import { rich, chunks } from "./model.js";
// Only this adapter sends secrets. No URL or method is accepted from page messages.
export class NotionAdapter {
  constructor(config, request = fetch) {
    this.config = config;
    this.request = request;
  }
  async api(path, method = "GET", body) {
    const delay = (this.nextRequestAt || 0) - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    this.nextRequestAt = Date.now() + 350;
    const response = await this.request(`https://api.notion.com/v1/${path}`, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const error = new Error(
        `Notion HTTP ${response.status} (${path.split("/")[0]})`,
      );
      error.retryAfter = Math.max(
        1,
        Math.min(3600, Number(response.headers.get("retry-after")) || 10),
      );
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    return response.json();
  }
  async test() {
    const expected = {
      projects: { title: "title", key: "rich_text", workspace: "rich_text" },
      conversations: {
        title: "title",
        key: "rich_text",
        workspace: "rich_text",
        project: "relation",
        created: "date",
        updated: "date",
        archived: "checkbox",
      },
      runs: {
        title: "title",
        key: "rich_text",
        status: "rich_text",
        started: "date",
        finished: "date",
        error: "rich_text",
        completed: "number",
        failed: "number",
      },
    };
    for (const kind of Object.keys(expected)) {
      const source = await this.api(
        `data_sources/${this.config.sources[kind]}`,
      );
      for (const [field, type] of Object.entries(expected[kind])) {
        const name = this.config.mapping[kind][field];
        if (source.properties?.[name]?.type !== type)
          throw new Error(`${kind}: 字段 ${name} 必须为 ${type}`);
      }
      if (kind === "conversations") {
        const relation =
          source.properties[this.config.mapping.conversations.project].relation;
        if (
          relation.data_source_id &&
          relation.data_source_id.replaceAll("-", "") !==
            this.config.sources.projects.replaceAll("-", "")
        )
          throw new Error("Project relation 指向了不同的数据源");
      }
    }
    return { ok: true };
  }
  async upsert(kind, id, properties) {
    const key = this.config.mapping[kind].key;
    const result = await this.api(
      `data_sources/${this.config.sources[kind]}/query`,
      "POST",
      { filter: { property: key, rich_text: { equals: id } }, page_size: 2 },
    );
    if (result.results.length > 1 || result.has_more)
      throw new Error(`${kind}: canonical ID 存在重复，请先合并重复记录`);
    properties[key] = { rich_text: rich(id) };
    if (result.results.length)
      return this.api(`pages/${result.results[0].id}`, "PATCH", { properties });
    // After a lost response, the next attempt queries the canonical key before creating again.
    return this.api("pages", "POST", {
      parent: {
        type: "data_source_id",
        data_source_id: this.config.sources[kind],
      },
      properties,
    });
  }
  project(entry, workspace) {
    const m = this.config.mapping.projects;
    return this.upsert("projects", entry.id, {
      [m.title]: { title: rich(entry.title || entry.id) },
      [m.workspace]: { rich_text: rich(workspace) },
    });
  }
  conversation(e, workspace, projectPage) {
    const m = this.config.mapping.conversations,
      date = (v) => ({
        date: v ? { start: new Date(v * 1000).toISOString() } : null,
      });
    return this.upsert("conversations", e.id, {
      [m.title]: { title: rich(e.title) },
      [m.workspace]: { rich_text: rich(workspace) },
      [m.project]: { relation: projectPage ? [{ id: projectPage }] : [] },
      [m.created]: date(e.create_time),
      [m.updated]: date(e.update_time),
      [m.archived]: { checkbox: e.is_archived },
    });
  }
  run(job) {
    const m = this.config.mapping.runs;
    return this.upsert("runs", job.id, {
      [m.title]: { title: rich(`ChatGPT Sync ${job.started}`) },
      [m.status]: { rich_text: rich(job.phase) },
      [m.started]: { date: { start: job.started } },
      [m.finished]: { date: job.finished ? { start: job.finished } : null },
      [m.error]: { rich_text: rich(job.error || "") },
      [m.completed]: { number: job.completed || 0 },
      [m.failed]: { number: job.failures?.length || 0 },
    });
  }
  async childBlocks(parent) {
    const out = [];
    let cursor;
    do {
      const r = await this.api(
        `blocks/${parent}/children?page_size=100${cursor ? "&start_cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      out.push(...r.results);
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    return out;
  }
  async ensureRevision(pageId, hash) {
    const label = `GPT-Exporter revision ${hash}`;
    const blocks = await this.childBlocks(pageId);
    const existing = blocks.find(
      (b) =>
        b.type === "toggle" &&
        b.toggle.rich_text
          .map((t) => t.plain_text ?? t.text?.content ?? "")
          .join("") === label,
    );
    if (existing) return existing.id;
    const r = await this.api(`blocks/${pageId}/children`, "PATCH", {
      children: [
        { object: "block", type: "toggle", toggle: { rich_text: rich(label) } },
      ],
    });
    return r.results[0].id;
  }
  async appendPart(revisionId, index, text) {
    const label = `Part ${index + 1}`;
    const existing = await this.childBlocks(revisionId);
    if (
      existing.some(
        (b) =>
          b.type === "toggle" &&
          b.toggle.rich_text
            .map((t) => t.plain_text ?? t.text?.content ?? "")
            .join("") === label,
      )
    )
      return;
    // One request creates both marker and content; a replay checks the marker first.
    await this.api(`blocks/${revisionId}/children`, "PATCH", {
      children: [
        {
          object: "block",
          type: "toggle",
          toggle: {
            rich_text: rich(label),
            children: chunks(text).map((s) => ({
              object: "block",
              type: "paragraph",
              paragraph: { rich_text: rich(s) },
            })),
          },
        },
      ],
    });
  }
}
// A remote endpoint can implement this same interface; no arbitrary proxy is exposed.
export const createAdapter = (config) => new NotionAdapter(config);
