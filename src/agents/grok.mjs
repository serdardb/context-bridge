// Grok CLI adapter.
//
// Storage: ~/.grok/sessions/<percent-encoded absolute cwd>/<session-uuid>/
//   summary.json       {info:{id,cwd}, updated_at, num_chat_messages, current_model_id, …}
//   chat_history.jsonl typed rows: system | user | assistant | reasoning | tool_result
//   events.jsonl       turn_started / turn_ended{outcome} / tool_started / tool_completed
//
// Grok is the cleanest of the three to bridge: it resumes by session id, encodes the
// project path reversibly, and marks turn boundaries explicitly, so nothing here is
// heuristic. Verified live: `grok -p` and `grok --resume <id> -p` both work and write
// the files above.
import fs from "node:fs";
import path from "node:path";
import { grokHome, fileExists, readJson } from "../util.mjs";

export const id = "grok";
export const displayName = "Grok";
export const injection = "prompt";

export const conflictFlags = [
  { flags: ["-c", "--continue"], value: "none", why: "the bridge resumes the linked session" },
  { flags: ["-r", "--resume"], value: "optional", why: "the bridge supplies the linked session itself" },
  { flags: ["-s", "--session-id"], value: "required", why: "the bridge supplies the linked session itself" },
  { flags: ["--fork-session"], value: "none", why: "forking mints a new session id and breaks the link" },
  { flags: ["--cwd"], value: "required", why: "bridge state belongs to this project directory" },
  { flags: ["-p", "--single"], value: "optional", why: "the launcher runs the interactive TUI" },
  { flags: ["-w", "--worktree"], value: "optional", why: "a worktree session belongs to a different directory" },
];

/** Grok encodes the project directory as a percent-encoded absolute path. */
export function projectDirKey(projectDir) {
  return encodeURIComponent(path.resolve(projectDir));
}

function sessionsRoot(projectDir) {
  return path.join(grokHome(), "sessions", projectDirKey(projectDir));
}

/** Newest Grok session for this project, or null. Deterministic: no cwd guessing. */
export function discover(projectDir) {
  const root = sessionsRoot(projectDir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const summary = readJson(path.join(dir, "summary.json"));
    if (!summary?.info?.id) continue;
    // Trust the recorded cwd over the directory name.
    if (summary.info.cwd && path.resolve(summary.info.cwd) !== path.resolve(projectDir)) continue;
    found.push({ ...refFor(dir, summary.info.id), updatedAt: summary.updated_at ?? null });
  }
  if (!found.length) return null;
  found.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return found[0];
}

/** Rebuild a ref from a known session id without scanning. */
export function refById(projectDir, sessionId) {
  const dir = path.join(sessionsRoot(projectDir), sessionId);
  return fileExists(dir) ? refFor(dir, sessionId) : null;
}

function refFor(dir, sessionId) {
  return {
    id: sessionId,
    transcriptPath: path.join(dir, "chat_history.jsonl"),
    eventsPath: path.join(dir, "events.jsonl"),
  };
}

export function resumeCommand(ref, extraArgs = []) {
  const args = ["--resume", ref.id, ...extraArgs];
  return { cmd: "grok", args };
}

/** Where the auto-submitted delta goes in the command line. */
export function promptArgs(delta) {
  // `--` first so a trailing variadic user flag cannot swallow the prompt.
  return ["--", delta];
}

/**
 * Grok needs a COMPOUND watermark, and the opaque-mark contract is what allows it.
 * The two streams are marked differently because they are shaped differently:
 * chat rows carry no timestamps, so they are marked by row count; events do carry
 * `ts`, so they are marked by instant. Marking events by row count (or the chat by
 * time) would silently recount every turn and every touched file on every handoff.
 */
export function currentMark(ref) {
  let rows = 0;
  for (const _ of readJsonl(ref.transcriptPath)) rows++;
  let ts = null;
  for (const e of readJsonl(ref.eventsPath)) {
    if (e.ts && (!ts || e.ts > ts)) ts = e.ts;
  }
  return { rows, ts };
}

/** Accepts the compound mark, a bare row count, or nothing. */
function normaliseMark(mark) {
  if (mark && typeof mark === "object") {
    return { rows: Number.isInteger(mark.rows) ? mark.rows : 0, ts: mark.ts ?? null };
  }
  return { rows: Number.isInteger(mark) && mark > 0 ? mark : 0, ts: null };
}

export function activitySince(ref, mark) {
  const { rows: from, ts: since } = normaliseMark(mark);
  const messages = [];
  let index = 0;
  for (const r of readJsonl(ref.transcriptPath)) {
    const i = index++;
    if (i < from) continue;
    const role = r.type === "user" ? "user" : r.type === "assistant" ? "assistant" : null;
    if (!role) continue; // system, reasoning and tool_result never reach the delta
    const text = extractText(r.content);
    if (!text || isNoise(text)) continue;
    messages.push({ role, text, at: null });
  }
  const patchedFiles = new Set();
  let turnsCompleted = 0;
  for (const e of readJsonl(ref.eventsPath)) {
    if (since && e.ts && e.ts <= since) continue;
    if (e.type === "turn_ended") turnsCompleted++;
    if (e.type === "tool_completed" && e.outcome === "success") {
      for (const f of filesFromToolEvent(e)) patchedFiles.add(f);
    }
  }
  return { messages, patchedFiles: [...patchedFiles], turnsCompleted };
}

/** A turn_ended event after the handoff request means the agent is idle. */
export function idleAfter(ref, sinceIso) {
  for (const e of readJsonl(ref.eventsPath)) {
    if (e.type !== "turn_ended") continue;
    if (!sinceIso || (e.ts && e.ts > sinceIso)) return true;
  }
  return false;
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

function extractText(content) {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b && b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n")
        : null;
  if (raw == null) return null;
  // Real user input arrives wrapped; the tags are harness framing, not content.
  const unwrapped = raw.replace(/<\/?user_query>/g, "");
  return unwrapped.trim();
}

/** Everything Grok injects around the conversation is harness noise, not context. */
function isNoise(text) {
  return (
    text.startsWith("<system-reminder>") ||
    text.startsWith("<user_info>") ||
    text.startsWith("[Bridge Context Update]")
  );
}

function filesFromToolEvent(e) {
  const out = [];
  for (const key of ["path", "file_path", "file"]) {
    if (typeof e[key] === "string") out.push(e[key]);
  }
  if (Array.isArray(e.paths)) out.push(...e.paths.filter((p) => typeof p === "string"));
  return out;
}
