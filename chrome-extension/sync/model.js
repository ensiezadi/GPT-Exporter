export const DEFAULT_MAP = {
  projects: { title: "Name", key: "Project ID", workspace: "Workspace ID" },
  conversations: {
    title: "Name",
    key: "Conversation ID",
    workspace: "Workspace ID",
    project: "Project",
    created: "Created At",
    updated: "Updated At",
    archived: "Archived",
  },
  runs: {
    title: "Name",
    key: "Run ID",
    status: "Status",
    started: "Started At",
    finished: "Finished At",
    error: "Error",
    completed: "Completed",
    failed: "Failed",
  },
};
export const keyFor = (workspace, id) => `${workspace}:${id}`;
export function validateEntry(e) {
  if (
    !e ||
    typeof e.id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,120}$/.test(e.id) ||
    ["__proto__", "constructor", "prototype"].includes(e.id)
  )
    throw new Error("Invalid conversation ID");
  return {
    id: e.id,
    title: String(e.title || "Untitled").slice(0, 2000),
    projectId: e.projectId ? String(e.projectId).slice(0, 120) : null,
    projectTitle: e.projectTitle ? String(e.projectTitle).slice(0, 2000) : null,
    create_time: Number(e.create_time) || 0,
    update_time: Number(e.update_time) || 0,
    is_archived: !!e.is_archived,
  };
}
export function revision(e) {
  return JSON.stringify([
    e.update_time,
    e.title,
    e.projectId,
    e.projectTitle,
    e.is_archived,
  ]);
}
export function planScan(entries, records, workspace) {
  const unique = new Map(
    entries.map((e) => {
      const v = validateEntry(e);
      return [v.id, v];
    }),
  );
  const plan = {
    added: 0,
    updated: 0,
    unchanged: 0,
    retry: 0,
    queue: [],
    entries: [...unique.values()],
  };
  for (const e of unique.values()) {
    const previous = records[keyFor(workspace, e.id)];
    const kind = !previous
      ? "added"
      : previous.syncedRevision !== revision(e) || !e.update_time
        ? "updated"
        : previous.error
          ? "retry"
          : "unchanged";
    plan[kind]++;
    if (kind !== "unchanged") plan.queue.push(e);
  }
  return plan;
}
export const rich = (text) => [
  { type: "text", text: { content: String(text || "").slice(0, 1900) } },
];
export function chunks(text, size = 1500) {
  const out = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(text.slice(start, end));
    start = end;
  }
  return out.length ? out : ["（没有可见文本）"];
}
export async function digest(text) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
