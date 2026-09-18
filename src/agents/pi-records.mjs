import { readRegularFile, recordPrefixHash } from "../util.mjs";

const invalid = () => new Error("Unsupported or damaged Pi session; refusing to treat it as empty activity.");
const instant = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

// Pi v3 is an append-only tree, not a linear chat. Its persisted leaf is the
// last entry; following parentId is essential after /tree changes branches.
export function readPiSession(file) {
  const content = readRegularFile(file);
  const lines = content.split("\n");
  const records = [];
  let incompleteTail = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { records.push(JSON.parse(lines[i])); }
    catch {
      if (i === lines.length - 1 && !content.endsWith("\n")) incompleteTail = true;
      else throw invalid();
    }
  }
  const header = records.shift();
  if (header?.type !== "session" || header.version !== 3 || typeof header.id !== "string" || !header.id ||
      typeof header.cwd !== "string" || !header.cwd || !instant(header.timestamp)) throw invalid();
  const byId = new Map();
  for (const entry of records) {
    if (!entry || typeof entry.id !== "string" || !entry.id || byId.has(entry.id) ||
        !instant(entry.timestamp) || typeof entry.type !== "string" || entry.type === "session" ||
        (entry.parentId !== null && (typeof entry.parentId !== "string" || !byId.has(entry.parentId)))) throw invalid();
    byId.set(entry.id, entry);
  }
  const branch = [];
  let entry = records.at(-1);
  while (entry) {
    branch.push(entry);
    entry = byId.get(entry.parentId);
  }
  branch.reverse();
  return { header, records, branch, incompleteTail };
}

export function piMark(session) {
  return { version: 1, sessionId: session.header.id, entryId: session.records.at(-1)?.id ?? null,
    rows: session.records.length, prefixHash: recordPrefixHash(session.records) };
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw invalid();
  return content.filter((part) => part?.type === "text").map((part) => {
    if (typeof part.text !== "string") throw invalid();
    return part.text;
  }).join("\n");
}

function selection(session, mark) {
  if (mark !== null && (mark.version !== 1 || mark.sessionId !== session.header.id ||
      (mark.entryId !== null && typeof mark.entryId !== "string"))) throw invalid();
  if (mark && (Object.hasOwn(mark, "rows") || Object.hasOwn(mark, "prefixHash")) &&
      (!Number.isSafeInteger(mark.rows) || mark.rows < 0 ||
       typeof mark.prefixHash !== "string" || !/^[a-f0-9]{64}$/.test(mark.prefixHash))) throw invalid();
  const index = mark?.entryId ? session.branch.findIndex((entry) => entry.id === mark.entryId) : -1;
  const branchChanged = Boolean(mark?.entryId && index === -1);
  const sourceRewritten = branchChanged || Boolean(mark?.prefixHash &&
    (session.records.length < mark.rows || recordPrefixHash(session.records.slice(0, mark.rows)) !== mark.prefixHash));
  return { index: sourceRewritten ? -1 : index, branchChanged, sourceRewritten };
}

export function piActivity(session, mark = null) {
  const { index, branchChanged, sourceRewritten } = selection(session, mark);
  const entries = session.branch.slice(index + 1);
  const messages = [];
  let turnsCompleted = 0;
  for (const entry of entries) {
    if (entry.type === "branch_summary" || entry.type === "compaction") {
      if (typeof entry.summary !== "string") throw invalid();
      messages.push({ role: "assistant", text: `[Pi ${entry.type}]\n${entry.summary}`, at: entry.timestamp });
    } else if (entry.type === "message") {
      const message = entry.message;
      if (!message || typeof message.role !== "string") throw invalid();
      if (!["user", "assistant"].includes(message.role)) continue;
      const text = textContent(message.content);
      if (text) messages.push({ role: message.role, text, at: entry.timestamp });
      if (message.role === "assistant" && ["stop", "length"].includes(message.stopReason)) turnsCompleted++;
    }
  }
  return { messages, patchedFiles: [], turnsCompleted, branchChanged, sourceRewritten, incompleteTail: session.incompleteTail,
    sourceComplete: !session.incompleteTail };
}

export function piAudit(session, mark = null) {
  // Validate the opaque mark with the same branch-reset policy as conversation.
  piActivity(session, mark);
  const { index, sourceRewritten } = selection(session, mark);
  const calls = new Map();
  const changed = new Set();
  const filesRead = new Set(), filesChanged = new Set();
  // A result after the watermark may belong to a call before it. Pair against
  // the whole active branch, then return only calls or results new to this span.
  for (const [position, entry] of session.branch.entries()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content.filter((part) => part?.type === "toolCall")) {
        if (typeof block.id !== "string" || !block.id || calls.has(block.id) || typeof block.name !== "string") throw invalid();
        calls.set(block.id, { tool: block.name, args: block.arguments ?? null, at: entry.timestamp,
          ok: null, exitCode: null, durationMs: null });
        if (position > index) changed.add(block.id);
      }
    } else if (message?.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      if (typeof message.isError !== "boolean") throw invalid();
      call.ok = !message.isError;
      if (position > index) changed.add(message.toolCallId);
      if (position > index && call.ok && typeof call.args?.path === "string") {
        if (call.tool === "read") filesRead.add(call.args.path);
        if (["write", "edit"].includes(call.tool)) filesChanged.add(call.args.path);
      }
    }
  }
  return { commands: [...calls].filter(([id]) => changed.has(id)).map(([, call]) => call),
    filesRead: [...filesRead], filesChanged: [...filesChanged], dropped: 0, sourceRewritten, sourceComplete: !session.incompleteTail };
}
