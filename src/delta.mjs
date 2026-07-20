// Deterministic context-delta extraction. No LLM summarization calls in v0.1:
// conversation truth comes from native session files, work truth from git.
import fs from "node:fs";
import { tryExec, oneLine, truncateMiddle } from "./util.mjs";

const MAX_DELTA_BYTES = 8 * 1024;
const MAX_MESSAGES = 14;

/** Claude transcript records (user/assistant text) newer than sinceIso. */
export function claudeMessagesSince(transcriptPath, sinceIso) {
  const out = [];
  for (const r of readJsonl(transcriptPath)) {
    if (!r.timestamp || (sinceIso && r.timestamp <= sinceIso)) continue;
    if (r.isSidechain) continue;
    if (r.type === "user") {
      const text = extractClaudeText(r.message?.content);
      if (text && !looksLikeCommandNoise(text)) out.push({ role: "user", text, at: r.timestamp });
    } else if (r.type === "assistant") {
      const text = extractClaudeText(r.message?.content);
      if (text) out.push({ role: "assistant", text, at: r.timestamp });
    }
  }
  return out;
}

/** Codex rollout activity newer than sinceIso. */
export function codexActivitySince(rolloutPath, sinceIso) {
  const messages = [];
  const patchedFiles = new Set();
  let turnsCompleted = 0;
  for (const r of readJsonl(rolloutPath)) {
    if (!r.timestamp || (sinceIso && r.timestamp <= sinceIso)) continue;
    const p = r.payload || {};
    if (r.type === "event_msg") {
      if (p.type === "user_message" && p.message) {
        if (!looksLikeCommandNoise(p.message)) messages.push({ role: "user", text: String(p.message), at: r.timestamp });
      } else if (p.type === "agent_message" && p.message) {
        messages.push({ role: "assistant", text: String(p.message), at: r.timestamp });
      } else if (p.type === "task_complete") {
        turnsCompleted++;
        if (p.last_agent_message) {
          const last = messages[messages.length - 1];
          if (!last || last.text !== String(p.last_agent_message)) {
            messages.push({ role: "assistant", text: String(p.last_agent_message), at: r.timestamp });
          }
        }
      } else if (p.type === "patch_apply_end") {
        for (const f of extractPatchFiles(p)) patchedFiles.add(f);
      }
    }
  }
  return { messages, patchedFiles: [...patchedFiles], turnsCompleted };
}

/** True when the rollout contains a task_complete event after sinceIso (idle signal). */
export function rolloutIdleAfter(rolloutPath, sinceIso) {
  try {
    for (const r of readJsonl(rolloutPath)) {
      if (r.timestamp > sinceIso && r.type === "event_msg" && r.payload?.type === "task_complete") return true;
    }
  } catch {}
  return false;
}

/** Git work truth for the project. */
export function gitDelta(projectDir, sinceSha) {
  const opts = { cwd: projectDir };
  const inRepo = tryExec("git", ["rev-parse", "--is-inside-work-tree"], opts) === "true";
  if (!inRepo) return { inRepo: false, lines: [] };
  const lines = [];
  const status = tryExec("git", ["status", "--porcelain"], opts);
  if (status) {
    for (const l of status.split("\n").slice(0, 20)) lines.push(`uncommitted: ${l.trim()}`);
  }
  if (sinceSha) {
    const log = tryExec("git", ["log", "--oneline", `${sinceSha}..HEAD`], opts);
    if (log) for (const l of log.split("\n").slice(0, 15)) lines.push(`commit: ${l.trim()}`);
    const stat = tryExec("git", ["diff", "--stat", `${sinceSha}..HEAD`], opts);
    if (stat) {
      const tail = stat.trim().split("\n").pop();
      if (tail) lines.push(`diff: ${tail.trim()}`);
    }
  }
  return { inRepo: true, lines };
}

export function currentGitSha(projectDir) {
  return tryExec("git", ["rev-parse", "HEAD"], { cwd: projectDir });
}

/**
 * Compose the bounded 4-section bridge delta.
 * sections: {fromAgent, conversation: [{role,text}], decisions: [], work: [], next: []}
 */
export function composeDelta({ fromAgent, conversation, sources, decisions, work, next }) {
  const streams = normaliseSources({ fromAgent, conversation, sources });
  const sec = (title, items, empty) =>
    `${title}\n${items.length ? items.map((i) => (i.startsWith("-") ? i : `- ${i}`)).join("\n") : `- ${empty}`}`;

  // One source needs no attribution; several do, or a chain arrives as an
  // unattributed pile and the reader cannot tell who decided what.
  const blocks = streams.filter((st) => st.messages.length);
  const conversationBlock =
    streams.length > 1
      ? blocks.length
        ? blocks
            .map((st) => `From ${st.label}\n${st.messages.slice(-MAX_MESSAGES).map((m) => line(m, st.label)).join("\n")}`)
            .join("\n\n")
        : "- No conversation activity since last sync."
      : streams[0].messages.length
        ? streams[0].messages.slice(-MAX_MESSAGES).map((m) => line(m, streams[0].label)).join("\n")
        : "- No conversation activity since last sync.";

  const who = streams.map((st) => st.label).join(", ");
  let out = [
    "[Bridge Context Update]",
    "",
    `While you were away, work continued in ${who}.`,
    "",
    `Conversation\n${conversationBlock}`,
    "",
    sec("Decisions", decisions, "No explicit decisions were recorded."),
    "",
    sec("Work", work, "No file or git changes detected."),
    "",
    sec("Next", next, "Nothing was flagged as unresolved."),
  ].join("\n");
  // Cap conservatively; never truncate Decisions/Next (they are short by construction),
  // so trim the middle (conversation-heavy) region.
  out = truncateMiddle(out, MAX_DELTA_BYTES);
  return out;
}

function line(m, label) {
  return `- ${m.role === "user" ? "User" : label}: ${oneLine(m.text, 220)}`;
}

/** Accepts either the single-source shape or a labelled multi-source list. */
function normaliseSources({ fromAgent, conversation, sources }) {
  if (Array.isArray(sources) && sources.length) {
    return sources.map((st) => ({ label: st.label ?? cap(st.id ?? "agent"), messages: st.messages ?? [] }));
  }
  return [{ label: cap(fromAgent ?? "agent"), messages: conversation ?? [] }];
}

export function composeFullContext({ fromAgent, conversation, sources, decisions, work, next }) {
  const streams = normaliseSources({ fromAgent, conversation, sources });
  const list = (items, empty) => (items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`);
  const blocks = streams
    .filter((st) => st.messages.length)
    .map((st) => {
      const body = st.messages
        .map((m) => `### ${m.role === "user" ? "User" : st.label}${m.at ? ` — ${m.at}` : ""}\n\n${m.text}`)
        .join("\n\n");
      return streams.length > 1 ? `## From ${st.label}\n\n${body}` : body;
    });
  const who = streams.map((st) => st.label).join(", ");
  return [
    `# Bridge full context — from ${who}`,
    "",
    "Un-truncated companion to the bounded bridge delta. Nothing here is clipped.",
    "",
    "## Conversation",
    "",
    blocks.length ? blocks.join("\n\n") : "_No conversation activity since last sync._",
    "",
    "## Decisions",
    "",
    list(decisions, "No explicit decisions were recorded."),
    "",
    "## Work",
    "",
    list(work, "No file or git changes detected."),
    "",
    "## Next",
    "",
    list(next, "Nothing was flagged as unresolved."),
    "",
  ].join("\n");
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function* readJsonl(p) {
  let content;
  try {
    content = fs.readFileSync(p, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

function extractClaudeText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
  }
  return null;
}

function extractPatchFiles(payload) {
  const files = [];
  const changes = payload.changes || payload.files || null;
  if (changes && typeof changes === "object") {
    for (const k of Object.keys(changes)) files.push(k);
  } else if (payload.path) {
    files.push(String(payload.path));
  }
  return files;
}

function looksLikeCommandNoise(text) {
  const t = String(text);
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<local-command") ||
    t.includes("<command-message>") ||
    t.startsWith("Caveat:") ||
    t.startsWith("[Bridge Context Update]")
  );
}
