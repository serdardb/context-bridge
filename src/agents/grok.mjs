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
import { isDeepStrictEqual } from "node:util";
import { isBridgeProtocolNoise } from "../delta.mjs";
import { probeJsonl, probeWithActivity } from "../probe.mjs";
import {
  grokHome,
  fileExists,
  readJson,
  tryExec,
  REPO_ROOT,
  sharedSkillPath,
  installedCopyStatus,
  BridgeError,
  transcriptStamp,
  readRegularFile,
  recordPrefixHash,
} from "../util.mjs";
import { skillLabel } from "./codex.mjs";

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
  // The cwd match is exact, so a single candidate is a certainty; several mean the
  // newest is only a guess and the caller must confirm.
  return { ...found[0], deterministic: found.length === 1 };
}

/** Rebuild the full ref (both streams) from a stored session id. */
export function hydrate(projectDir, slot) {
  return slot?.id ? refById(projectDir, slot.id) : null;
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
 * Each stream has its own parsed-prefix mark. Timestamp progress remains for
 * legacy marks, not as a substitute for detecting buffered or revised records.
 */
export function currentMark(ref) {
  const chat = [...readJsonl(ref.transcriptPath, true)];
  const events = [...readJsonl(ref.eventsPath, true)];
  const readStatus = { malformed: 0 };
  const hunks = [...readJsonl(hunkPath(ref), false, readStatus)];
  if (readStatus.malformed || readStatus.unreadable) throw new BridgeError("Grok file-change evidence could not be read completely.", { code: "BRIDGE_TRANSCRIPT_UNREADABLE" });
  let ts = null;
  for (const e of events) {
    if (e.ts && (!ts || e.ts > ts)) ts = e.ts;
  }
  return { rows: chat.length, ts, chatPrefixHash: recordPrefixHash(chat),
    events: prefixMark(events), hunks: prefixMark(hunks) };
}

function hunkPath(ref) {
  return path.join(path.dirname(String(ref?.transcriptPath ?? "")), "hunk_records.jsonl");
}

function prefixMark(rows) { return { rows: rows.length, prefixHash: recordPrefixHash(rows) }; }

function streamSelection(rows, mark, since, timeField) {
  const attested = Number.isSafeInteger(mark?.rows) && mark.rows >= 0 && typeof mark.prefixHash === "string";
  const rewritten = attested && (rows.length < mark.rows || recordPrefixHash(rows.slice(0, mark.rows)) !== mark.prefixHash);
  return { rewritten, selected: (row, index) => attested ? rewritten || index >= mark.rows
    : !since || !row[timeField] || row[timeField] > since };
}

/** Accepts the compound mark, a bare row count, or nothing. */
function normaliseMark(mark) {
  if (mark && typeof mark === "object") {
    return { rows: Number.isInteger(mark.rows) ? mark.rows : 0, ts: mark.ts ?? null };
  }
  return { rows: Number.isInteger(mark) && mark > 0 ? mark : 0, ts: null };
}

export function activitySince(ref, mark) {
  const readStatus = { malformed: 0 };
  const { rows: previous, ts: since } = normaliseMark(mark);
  const chat = [...readJsonl(ref.transcriptPath, true, readStatus)];
  // A count cannot detect compaction or editing between two handoffs. Legacy
  // marks still work, but only newly captured marks attest the earlier prefix.
  const events = [...readJsonl(ref.eventsPath, true, readStatus)];
  const eventSelection = streamSelection(events, mark?.events, since, "ts");
  const hunks = [...readJsonl(hunkPath(ref), false, readStatus)];
  const sourceRewritten = chat.length < previous || (typeof mark?.chatPrefixHash === "string" &&
    recordPrefixHash(chat.slice(0, previous)) !== mark.chatPrefixHash) ||
    eventSelection.rewritten || streamSelection(hunks, mark?.hunks, since, "timestamp").rewritten;
  const from = sourceRewritten ? 0 : previous;
  const messages = [];
  let index = 0;
  for (const r of chat) {
    const i = index++;
    if (i < from) continue;
    const role = r.type === "user" ? "user" : r.type === "assistant" ? "assistant" : null;
    if (!role) continue; // system, reasoning and tool_result never reach the delta
    const text = extractText(r.content);
    // Two different kinds of noise, and only one of them is about who wrote it.
    // What Grok wraps around the conversation is never conversation, whichever
    // role it lands on: a `[Bridge Context Update]` echoed back from an assistant
    // row is our own previous delta being fed into the next one. The handoff
    // skill's instructions are different: they arrive as a user turn, and an
    // assistant quoting them is discussing the protocol, which is real content.
    if (!text || isNoise(text) || (role === "user" && isBridgeProtocolNoise(text))) continue;
    messages.push({ role, text, at: null });
  }
  const patchedFiles = new Set();
  let turnsCompleted = 0;
  for (const [index, e] of events.entries()) {
    if (!eventSelection.selected(e, index)) continue;
    if (e.type === "turn_ended") turnsCompleted++;
    if (e.type === "tool_completed" && e.outcome === "success") {
      for (const f of filesFromToolEvent(e)) patchedFiles.add(f);
    }
  }
  return { messages, patchedFiles: [...patchedFiles], turnsCompleted, sourceRewritten,
    sourceComplete: readStatus.malformed === 0 && !readStatus.unreadable };
}

/**
 * Grok stores sessions under a per-project directory, so discovery health is
 * answerable directly: session folders exist, and each should yield an id from
 * its summary. Folders we cannot read a single id from mean the format moved.
 */
export function discoveryProbe(projectDir) {
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot(projectDir), { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { status: "none", examined: 0, recognised: 0 };
  }
  if (!entries.length) return { status: "none", examined: 0, recognised: 0 };
  let recognised = 0;
  for (const e of entries) {
    if (readJson(path.join(sessionsRoot(projectDir), e.name, "summary.json"))?.info?.id) recognised++;
  }
  return { status: recognised > 0 ? "readable" : "blind", examined: entries.length, recognised };
}

/**
 * Grok publishes a live registry of open sessions, which makes this the one
 * agent besides Codex where "the session we just started" is a fact rather than
 * a guess: ~/.grok/active_sessions.json holds {session_id, pid, cwd, opened_at}
 * per running session. Matching our own child's pid identifies it exactly.
 *
 * Returns every plausible candidate and picks no winner. Choosing between two is
 * the caller's refusal to make, because a user with a second Grok open in another
 * terminal must never have that session stolen into this project's state.
 */
export function adoptStartedSession(projectDir, { startedAt, childPid } = {}) {
  const want = path.resolve(projectDir);
  let entries = [];
  try {
    entries = JSON.parse(readRegularFile(path.join(grokHome(), "active_sessions.json")));
  } catch {
    entries = [];
  }
  const inProject = (Array.isArray(entries) ? entries : []).filter(
    (e) => e?.session_id && e.cwd && path.resolve(e.cwd) === want && (!startedAt || !e.opened_at || e.opened_at >= startedAt)
  );
  // Our own child is unambiguous; fall back to project+time only when the pid
  // does not appear (a Grok that re-execs, or an older CLI with no registry).
  const mine = childPid ? inProject.filter((e) => e.pid === childPid) : [];
  const pool = mine.length ? mine : inProject;
  if (pool.length) return pool.map((e) => refById(projectDir, e.session_id)).filter(Boolean);

  // The registry is LIVE: a session's entry disappears the moment it closes. So
  // it identifies our child perfectly while it runs and tells us nothing once it
  // has exited, which is exactly why linking happens in both phases. After exit
  // the evidence left on disk is the session directory's own start time.
  return sessionsStartedSince(projectDir, startedAt);
}

/** Session directories for this project whose recorded start is at or after `startedAt`. */
function sessionsStartedSince(projectDir, startedAt) {
  const root = sessionsRoot(projectDir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const summary = readJson(path.join(dir, "summary.json"));
    if (!summary?.info?.id) continue;
    if (summary.info.cwd && path.resolve(summary.info.cwd) !== path.resolve(projectDir)) continue;
    const started = summary.created_at ?? summary.info?.created_at ?? null;
    if (startedAt && started && started < startedAt) continue;
    if (startedAt && !started) {
      // No recorded start: fall back to when the directory itself appeared.
      let birth = 0;
      try {
        const st = fs.statSync(dir);
        birth = (st.birthtimeMs || st.ctimeMs) ?? 0;
      } catch {}
      if (birth && birth < Date.parse(startedAt)) continue;
    }
    out.push(refFor(dir, summary.info.id));
  }
  return out;
}

/**
 * Grok is the one agent with two files, and they fail independently: chat rows
 * carry the conversation, events carry the turn boundaries the mark rides on.
 * A readable history with an unreadable event stream still breaks idle detection,
 * so both are probed and the worse of the two is reported.
 */
export function parseProbe(ref) {
  const chat = { ...probeJsonl(ref?.transcriptPath, (r) => typeof r.type === "string" && "content" in r), detail: "chat_history.jsonl" };
  const events = { ...probeJsonl(ref?.eventsPath, (r) => typeof r.type === "string"), detail: "events.jsonl" };
  const worse = rank(events.status) > rank(chat.status) ? events : chat;
  return probeWithActivity({ activitySince }, ref, worse);
}

const SEVERITY = { readable: 0, partial: 1, missing: 2, mismatch: 3, unreadable: 4 };
const rank = (status) => SEVERITY[status] ?? 0;

/** A turn_ended event after the handoff request means the agent is idle. */
export function idleAfter(ref, sinceIso) {
  for (const e of readJsonl(ref.eventsPath)) {
    if (e.type !== "turn_ended") continue;
    if (!sinceIso || (e.ts && e.ts > sinceIso)) return true;
  }
  return false;
}

function* readJsonl(p, required = false, readStatus = null) {
  let content;
  let before;
  try {
    if (readStatus) before = transcriptStamp({ transcriptPath: p });
    content = readRegularFile(p);
    if (readStatus && !isDeepStrictEqual(before, transcriptStamp({ transcriptPath: p }))) readStatus.unreadable = true;
  } catch (cause) {
    if (required) throw new BridgeError("The source transcript could not be read. Check permissions and storage availability before retrying.", {
      code: "BRIDGE_TRANSCRIPT_UNREADABLE", cause,
    });
    if (readStatus && (before !== undefined || cause.code !== "ENOENT")) readStatus.unreadable = true;
    return;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch { if (readStatus) readStatus.malformed++; }
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

/** A brand new session seeded by an initial prompt: `grok [OPTIONS] [PROMPT]`. */
export function startCommand(extraArgs = []) {
  return { cmd: "grok", args: [...extraArgs] };
}

export function health() {
  const version = tryExec("grok", ["--version"]);
  // Existence only: the file holds credentials and is never read.
  const authed = fileExists(path.join(grokHome(), "auth.json"));
  const skill = installedCopyStatus(sharedSkillPath(), path.join(REPO_ROOT, "codex", "SKILL.md"));
  return {
    version,
    auth: { ok: authed, via: "grok login", account: null },
    extras: [{ ok: skill === "current", label: skillLabel(skill), fix: "bridge doctor --fix" }],
    ready: !!(version && authed && skill !== "missing"),
    installHint: "see https://grok.com for the Grok CLI installer",
  };
}

export function smokeCommand() {
  return { cmd: "grok", args: ["-p", "Reply with exactly: bridge-ok"] };
}

/**
 * `GROK_HOOK_EVENT` is injected per hook process rather than exported into the
 * session, so it does not inherit and it is not evidence of a host either: it
 * proves a hook is running, not that a Grok session is. No host marker, so null.
 */
export function detectHost() {
  return null;
}

/**
 * Measured from a real session's `events.jsonl`, and it is the most lopsided of
 * the four: richest where nobody expected and blind where everyone assumed.
 *
 * `commandArgs` is false, and this is the finding that broke the first manifest
 * design. A `tool_started` row carries exactly three fields, `ts`, `type` and
 * `tool_name`, so Grok can say that a terminal command ran and failed but never
 * which command it was. That was proposed as a required field for all four
 * agents until this was measured; it was assumed rather than checked, because
 * Grok's quota had run out and nobody thought to read the files it had already
 * written.
 *
 * Against that, `duration` is true where Codex has to parse it out of prose and
 * Claude has none, since `tool_completed` carries `duration_ms` as a real field.
 * And `hunk_records.jsonl` is the best file-change record of any agent here: per
 * line, with `authorType` separating what the agent wrote from what the human
 * did.
 *
 * `pairing` is positional because neither tool row carries an id, so a start is
 * matched to a completion by order alone. That holds for a single stream and is
 * the first thing to distrust if Grok ever runs tools concurrently.
 */
export const capabilities = {
  commands: true,
  commandArgs: false,
  outcome: true,
  exitCode: false,
  duration: true,
  filesRead: false,
  filesChanged: true,
  toolOutput: false,
  reasoning: false,
  tokenUsage: false,
  pairing: "positional",
};

/**
 * What this session actually proves about Grok, as opposed to what we declare.
 * `null` means the session was silent on the point, which is not the same as no,
 * and the distinction is the whole reason this returns three values.
 */
export function observeAudit(ref) {
  let sawTool = false;
  let args = false;
  let duration = false;
  for (const e of readJsonl(ref?.eventsPath ?? ref?.transcriptPath)) {
    if (e?.type !== "tool_started" && e?.type !== "tool_completed") continue;
    sawTool = true;
    if (e.args || e.arguments || e.command) args = true;
    if (typeof e.duration_ms === "number") duration = true;
  }
  if (!sawTool) return { commandArgs: null, duration: null };
  return { commandArgs: args, duration };
}

/**
 * What Grok actually ran since the mark, within the limits it declares.
 *
 * Pairing is positional because neither tool row carries an id, so a start is
 * matched to the next completion. `args` is always null and that is not an
 * omission: `tool_started` records the tool name and nothing else, which is the
 * finding that broke the first manifest design when somebody assumed otherwise.
 *
 * Against that, Grok is the only agent giving a real duration, and its
 * `hunk_records.jsonl` is the best file-change record here, with `authorType`
 * separating the agent's edits from the human's.
 */
export function auditSince(ref, mark) {
  // Retain earlier starts for pairing with a newly persisted completion.
  const { ts: since } = normaliseMark(mark);
  const commands = [];
  let pending = null;
  let dropped = 0;
  const readStatus = { malformed: 0 };
  const events = [...readJsonl(ref?.eventsPath ?? ref?.transcriptPath, true, readStatus)];
  const eventSelection = streamSelection(events, mark?.events, since, "ts");
  for (const [index, e] of events.entries()) {
    const selected = eventSelection.selected(e, index);
    if (e?.type === "tool_started") {
      pending = { tool: e.tool_name ?? null, args: null, at: e.ts ?? null, ok: null, exitCode: null, durationMs: null };
    } else if (e?.type === "tool_completed") {
      const row = pending ?? { tool: e.tool_name ?? null, args: null, at: e.ts ?? null, exitCode: null };
      row.ok = e.outcome === "success";
      row.durationMs = typeof e.duration_ms === "number" ? e.duration_ms : null;
      pending = null;
      if (selected) commands.push(row);
    }
  }
  const filesChanged = new Set();
  const hunks = [...readJsonl(hunkPath(ref), false, readStatus)];
  const hunkSelection = streamSelection(hunks, mark?.hunks, since, "timestamp");
  for (const [index, h] of hunks.entries()) {
    if (!hunkSelection.selected(h, index)) continue;
    if (h?.filePath && h?.authorType === "agent") filesChanged.add(h.filePath);
  }
  return { commands, filesRead: [], filesChanged: [...filesChanged], dropped,
    sourceComplete: readStatus.malformed === 0 && !readStatus.unreadable };
}
