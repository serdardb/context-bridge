// Antigravity CLI adapter (`agy`).
//
// Storage, all under ~/.gemini/antigravity-cli/:
//   history.jsonl               every prompt with its workspace and, from the
//                               second prompt on, its conversationId
//   brain/<uuid>/.system_generated/logs/transcript.jsonl
//                               typed rows: step_index, source, type, status,
//                               created_at, content
//
// Everything below was verified by running commands against agy 1.1.5 on a real
// machine, and the agent itself was asked to argue against the design first. Two
// of its objections changed this file; one of its claims did not survive checking.
import fs from "node:fs";
import path from "node:path";
import { tryExec, fileExists, HOME } from "../util.mjs";
import { probeJsonl, probeWithActivity } from "../probe.mjs";

export const id = "antigravity";
export const displayName = "Antigravity";

// Its `--prompt-interactive` opens the TUI and auto-submits the prompt, the same
// shape as Codex's positional prompt. Antigravity itself argued this could not
// work and that delivery had to go through `--print`, because it hit
// `bubbletea: could not open TTY` when it tested. That was an artifact of testing
// headlessly: under a real terminal, which is exactly what the launcher hands its
// child, the prompt is accepted and lands in the transcript as step 0.
export const injection = "prompt";

// Worth knowing before the first switch to it: Antigravity asks for consent the
// first time it opens in a project, the same class of one-time dialog as Codex's
// folder trust. Until that is answered the seeded prompt is not processed. The
// bridge does not try to suppress another product's dialog; answer it once and
// every later switch is clean.

export const conflictFlags = [
  { flags: ["-c", "--continue"], value: "none", why: "the bridge resumes the linked conversation" },
  { flags: ["--conversation"], value: "required", why: "the bridge supplies the linked conversation itself" },
  { flags: ["-p", "--print", "--prompt"], value: "optional", why: "the launcher runs the interactive TUI" },
  { flags: ["-i", "--prompt-interactive"], value: "optional", why: "the bridge supplies the delta as the initial prompt" },
];

function cliHome() {
  return process.env.ANTIGRAVITY_HOME || path.join(HOME, ".gemini", "antigravity-cli");
}

/** The readable transcript for a conversation, beside the SQLite it is derived from. */
function transcriptFor(conversationId) {
  return path.join(cliHome(), "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}

/**
 * The project-to-conversation mapping, from a plain file.
 *
 * `history.jsonl` records every prompt with the `workspace` it was typed in and,
 * from the second prompt of a conversation onward, its `conversationId`. That is
 * the whole mapping, in the same shape the other three adapters use: the project
 * is written down, not inferred.
 *
 * There is also a `conversation_summaries.db` holding the same association in
 * SQLite, and the first version of this adapter shelled out to `sqlite3` to read
 * it. Serdar asked the obvious question: three agents needed no such thing, why
 * does this one. It does not. Reading a JSONL file we already know how to read
 * beats requiring a binary that may not be installed.
 */
function historyEntries() {
  const rows = [];
  for (const row of readJsonl(path.join(cliHome(), "history.jsonl"))) {
    if (row?.conversationId && row?.workspace) rows.push(row);
  }
  return rows;
}

/**
 * Conversations whose prompts were typed in this project, newest first.
 *
 * The workspace recorded is the directory Antigravity was opened in, which can
 * be a parent of the project. A conversation started in a parent is not this
 * project's conversation, so the match is exact.
 */
function conversationsForProject(projectDir) {
  const want = path.resolve(projectDir);
  const seen = new Map();
  for (const row of historyEntries()) {
    if (path.resolve(row.workspace) !== want) continue;
    const at = Number(row.timestamp) || 0;
    const prev = seen.get(row.conversationId) ?? 0;
    if (at >= prev) seen.set(row.conversationId, at);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([conversationId, lastSeenAt]) => ({ conversationId, lastSeenAt }));
}

function refFor(conversationId) {
  return { id: conversationId, transcriptPath: transcriptFor(conversationId) };
}

/**
 * Deterministic: the workspace is recorded in the conversation index, so unlike
 * Codex there is nothing to scan and nothing to compare by hand.
 */
export function discover(projectDir) {
  const [newest] = conversationsForProject(projectDir);
  return newest ? { ...refFor(newest.conversationId), deterministic: true } : null;
}

export function hydrate(_projectDir, slot) {
  return slot?.id ? refFor(slot.id) : null;
}

export function refById(_projectDir, conversationId) {
  return refFor(conversationId);
}

export function resumeCommand(ref, extraArgs = []) {
  return { cmd: "agy", args: [...extraArgs, "--conversation", ref.id] };
}

export function startCommand(extraArgs = []) {
  return { cmd: "agy", args: [...extraArgs] };
}

export function promptArgs(delta) {
  return ["--prompt-interactive", delta];
}

/**
 * Which transcript rows are conversation, and which are the machinery around it.
 *
 * This distinction is the whole reason the adapter is safe, and it came from
 * Antigravity's own objection: a transcript carries `SYSTEM/CHECKPOINT` and
 * `SYSTEM/CONVERSATION_HISTORY` rows holding internal memory-compaction text.
 * Taking everything past a watermark would forward that machinery to the next
 * agent as though the user had said it. Confirmed by reading a four-row
 * transcript in which two rows were internal.
 */
function isConversationRow(row) {
  if (row?.status && row.status !== "DONE") return false;
  return row?.type === "USER_INPUT" || row?.type === "PLANNER_RESPONSE";
}

function roleFor(row) {
  return row.type === "USER_INPUT" ? "user" : "assistant";
}

/**
 * What the user actually said, and nothing the harness wrapped around it.
 *
 * A `USER_INPUT` row is not the user's text. It carries the request inside
 * `<USER_REQUEST>` and then appends blocks of its own: the local time in
 * `<ADDITIONAL_METADATA>`, settings changes, and more. Stripping only the outer
 * tags leaves all of that in, and it would reach the next agent as though the
 * user had typed it. So the request is extracted rather than the framing removed.
 */
function textOf(row) {
  const raw = typeof row?.content === "string" ? row.content : "";
  let text = raw;
  if (row?.type === "USER_INPUT") {
    const m = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
    text = m ? m[1] : raw;
  }
  text = text.trim();
  return text && wasTruncated(row) ? `${text}\n\n[cut short by Antigravity's own transcript limit]` : text;
}

/**
 * Antigravity caps what it writes into the transcript at roughly 4KB per row and
 * says so in `truncated_fields`, which listed `content` on 14 of 55 rows in the
 * first real session. The cap is its business; forwarding the remains as though
 * they were the whole message is ours. Everything the bridge trims elsewhere is
 * announced and its full text left reachable, and text trimmed by somebody else
 * cannot be less honest than text we trimmed ourselves — there is no companion
 * file to point at here, because the rest was never written down.
 */
/** Antigravity wraps string args in an extra pair of quotes; strip them. */
function unquote(v) {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/^"|"$/g, "");
  return t || null;
}

function wasTruncated(row) {
  const t = row?.truncated_fields;
  const fields = Array.isArray(t) ? t : t && typeof t === "object" ? Object.keys(t) : [];
  return fields.includes("content");
}

/**
 * Its rows are numbered, not timestamped in a way we can trust across a resume,
 * so the watermark is the step index: a number this adapter defines and nobody
 * else interprets.
 */
export function currentMark(ref) {
  let last = -1;
  for (const row of readJsonl(ref.transcriptPath)) {
    if (typeof row.step_index === "number" && row.step_index > last) last = row.step_index;
  }
  return last < 0 ? null : last;
}

export function activitySince(ref, mark) {
  const from = typeof mark === "number" ? mark : -1;
  const messages = [];
  for (const row of readJsonl(ref.transcriptPath)) {
    if (typeof row.step_index !== "number" || row.step_index <= from) continue;
    if (!isConversationRow(row)) continue;
    const text = textOf(row);
    if (text) messages.push({ role: roleFor(row), text, at: row.created_at ?? null });
  }
  return { messages, patchedFiles: [], turnsCompleted: 0 };
}

/**
 * Has the turn ended?
 *
 * The conversation index carries `not_fully_idle`, which looks like the answer
 * and is not one on its own: Antigravity warned that SQLite WAL timing can hand
 * an outside reader a stale value, and that a process killed mid-turn leaves the
 * flag stuck at 1 until something collects it. That matches this project's own
 * rule about single signals, so both are required to agree: the index must say
 * idle AND the transcript must end on a completed model response.
 */
export function idleAfter(ref, _sinceIso) {
  let last = null;
  for (const r of readJsonl(ref.transcriptPath)) {
    if (isConversationRow(r)) last = r;
  }
  if (last?.type !== "PLANNER_RESPONSE" || last?.status !== "DONE") return false;
  // A response that issues a tool call is the START of work, not the end of a
  // turn, and it is written as DONE the moment it is emitted. The rows that
  // follow it are tool rows, which are not conversation and so never become
  // `last`. Without this check the transcript looks finished for the whole
  // duration of every tool call: replaying one real 64-row session, the turn
  // read as over at 25 separate moments, each one a chance for the launcher to
  // terminate the agent in the middle of its own work.
  return !(last.tool_calls?.length > 0);
}

/**
 * The launcher prints the conversation id when a session ends, but the index is
 * the better source: it records the workspace, so a conversation started in
 * another project can never be adopted into this one.
 */
export function adoptStartedSession(projectDir, { startedAt } = {}) {
  const since = startedAt ? Date.parse(startedAt) : 0;
  // A minute of slack: history rows are stamped when a prompt is submitted,
  // which is a moment after the launcher recorded that it spawned the child.
  const floor = Number.isFinite(since) && since ? since - 60_000 : 0;
  const named = conversationsForProject(projectDir)
    .filter((row) => row.lastSeenAt >= floor)
    .map((row) => refFor(row.conversationId));
  if (named.length) return named;

  // `history.jsonl` only records what the USER typed. A session the bridge
  // seeded with `--prompt-interactive` leaves no row there until the person
  // types something themselves, even a slash command, so a session closed
  // without a word would be invisible.
  //
  // Its conversation directory is created either way, verified by running it,
  // and the transcript opens with the seeded prompt. That directory carries no
  // workspace, so on its own it says only "a conversation began after we
  // spawned". Review asked whether that is enough, and it is, because of what
  // it is combined with: our own session always creates a directory, so a lone
  // candidate in the window is ours. Anything else appearing at the same moment
  // makes two, and the caller adopts nothing when candidates disagree. Every
  // candidate is returned here for exactly that reason; narrowing to one would
  // move a refusal into a guess.
  return conversationDirsSince(floor).map((conversationId) => refFor(conversationId));
}

/** Conversation directories created at or after a moment, newest first. */
function conversationDirsSince(floorMs) {
  const root = path.join(cliHome(), "brain");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let born = 0;
    try {
      const st = fs.statSync(path.join(root, e.name));
      born = st.birthtimeMs || st.ctimeMs || 0;
    } catch {
      continue;
    }
    if (!floorMs || born >= floorMs) found.push({ id: e.name, born });
  }
  return found.sort((a, b) => b.born - a.born).map((f) => f.id);
}

export function parseProbe(ref) {
  const shape = probeJsonl(ref?.transcriptPath, (r) => typeof r.step_index === "number" && typeof r.type === "string");
  return probeWithActivity({ activitySince }, ref, shape);
}

export function discoveryProbe(projectDir) {
  let examined = 0;
  for (const _ of readJsonl(path.join(cliHome(), "history.jsonl"))) examined++;
  if (!examined) return { status: "none", examined: 0, recognised: 0 };
  const recognised = historyEntries().length;
  if (!recognised) return { status: "blind", examined, recognised: 0 };
  return { status: "readable", examined, recognised, forThisProject: conversationsForProject(projectDir).length };
}

export function health() {
  const version = tryExec("agy", ["--version"]);
  const indexed = fileExists(path.join(cliHome(), "history.jsonl"));
  return {
    version,
    // agy answers only when it is signed in, so a working --version plus a
    // readable conversation index is as far as an existence check can go here.
    auth: { ok: !!version, via: "agy", account: null },
    extras: [
      {
        ok: indexed,
        info: true,
        label: indexed ? "Conversation history readable" : "No conversation history yet (written on first use)",
      },
    ],
    ready: !!version,
    installHint: "install Antigravity and sign in, then run: agy --version",
  };
}

export function smokeCommand() {
  return { cmd: "agy", args: ["--print", "Reply with exactly: bridge-ok"] };
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

/** No documented host marker, and one will not be invented. See the contract. */
export function detectHost() {
  return null;
}

/**
 * Measured on a real transcript, and its record is split across two row shapes,
 * which is why a first reading of it is misleading.
 *
 * The command text is NOT in the `RUN_COMMAND` row, whose content opens with
 * timestamps and then the output. It is in the `tool_calls` array on the
 * preceding `PLANNER_RESPONSE`, as a name and an args object. Read only the
 * RUN_COMMAND rows and Antigravity looks like Grok, unable to say what it ran.
 *
 * `outcome` and `duration` are parsed rather than structured: the content says
 * `The command completed successfully` in prose and carries `Created At` and
 * `Completed At` lines to subtract. Both work and both are one reword from
 * breaking.
 *
 * `toolOutput` is truncated rather than a pointer, and this one is not our
 * choice: Antigravity cuts row content at roughly 4KB and records the fact in
 * `truncated_fields`, so what it kept is all there will ever be. There is no
 * fuller copy to point at.
 *
 * `filesChanged` is true: Antigravity edits files using `replace_file_content`,
 * `multi_replace_file_content`, and `write_to_file`.
 */
export const capabilities = {
  commands: true,
  commandArgs: true,
  outcome: "parsed",
  exitCode: false,
  duration: "parsed",
  filesRead: true,
  filesChanged: true,
  toolOutput: "truncated",
  reasoning: true,
  tokenUsage: false,
  pairing: "keyed",
};

/** What this session proves about Antigravity. `null` means it was silent. */
export function observeAudit(ref) {
  let sawTool = false;
  let args = false;
  let read = false;
  let changed = false;
  for (const row of readJsonl(ref?.transcriptPath)) {
    if (row?.type === "VIEW_FILE" || row?.type === "LIST_DIRECTORY") read = true;
    if ((row?.tool_calls ?? []).length) {
      sawTool = true;
      if (row.tool_calls.some((c) => c?.args)) args = true;
      if (row.tool_calls.some((c) => ["replace_file_content", "multi_replace_file_content", "write_to_file"].includes(c?.name))) {
        changed = true;
      }
    }
    if (row?.type === "RUN_COMMAND") sawTool = true;
  }
  if (!sawTool) return { commandArgs: null, filesRead: null, filesChanged: null };
  return { commandArgs: args, filesRead: read, filesChanged: changed };
}

/**
 * What Antigravity actually ran since the mark.
 *
 * Its record is split, which is the trap: the command text is not in the
 * `RUN_COMMAND` row but in the `tool_calls` array on the `PLANNER_RESPONSE`
 * that issued it. Read only the RUN_COMMAND rows and Antigravity looks as blind
 * as Grok. Outcome and duration are recovered from prose in the row content,
 * which is what its capabilities call `parsed`.
 */
export function auditSince(ref, mark) {
  const from = typeof mark === "number" ? mark : -1;
  const commands = [];
  const filesRead = new Set();
  const filesChanged = new Set();
  let pendingArgs = null;
  let dropped = 0;

  for (const row of readJsonl(ref?.transcriptPath)) {
    if (typeof row.step_index !== "number" || row.step_index <= from) continue;
    if (row.type === "PLANNER_RESPONSE" && (row.tool_calls ?? []).length) {
      const call = row.tool_calls[0];
      pendingArgs = { tool: call?.name ?? null, args: call?.args ?? null };
      // Edits are named in tool_calls too, and the path arrives JSON-quoted.
      // Blocker found in review: the capability declared filesChanged true while
      // this always returned an empty list, so the manifest contradicted itself.
      for (const c of row.tool_calls) {
        if (c?.name === "view_file") {
          const f = unquote(c?.args?.AbsolutePath ?? c?.args?.TargetFile ?? c?.args?.FilePath);
          if (f) filesRead.add(f);
        }
        if (/replace_file_content|write_to_file|create_file/.test(c?.name ?? "")) {
          const f = unquote(c?.args?.TargetFile ?? c?.args?.AbsolutePath ?? c?.args?.FilePath);
          if (f) filesChanged.add(f);
        }
      }
    } else if (row.type === "VIEW_FILE") {
      const m = String(row.content ?? "").match(/File Path:\s*`?(?:file:\/\/)?([^`\n]+)/);
      if (m) filesRead.add(m[1].trim());
    } else if (row.type === "RUN_COMMAND") {
      const text = String(row.content ?? "");
      const start = text.match(/Created At:\s*(\S+)/);
      const end = text.match(/Completed At:\s*(\S+)/);
      const ms = start && end ? Date.parse(end[1]) - Date.parse(start[1]) : null;
      commands.push({
        tool: pendingArgs?.tool ?? "run_command",
        // The command line is inside args as a quoted string; surface it so the
        // manifest reads like a command rather than a JSON blob. The full args
        // object is not lost to anyone who wants it: it is in the transcript.
        args: unquote(pendingArgs?.args?.CommandLine) ?? pendingArgs?.args ?? null,
        at: row.created_at ?? null,
        ok: /completed successfully/i.test(text) ? true : /fail|error/i.test(text) ? false : null,
        exitCode: null,
        durationMs: Number.isFinite(ms) ? ms : null,
      });
      pendingArgs = null;
    }
  }
  return { commands, filesRead: [...filesRead], filesChanged: [...filesChanged], dropped };
}
