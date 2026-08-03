// OpenCode adapter.
//
// Storage: ~/.local/share/opencode/opencode.db (SQLite, never read directly)
// Session list: opencode serve + HTTP API (GET /api/session)
// CLI export:   opencode export <sessionID>
// CLI resume:   opencode --session <sessionID>
// CLI start:    opencode  (TUI) or opencode run "prompt" (headless)
//
// OpenCode's CLI does not output to piped stdout (TTY detection).
// The SDK starts a temporary HTTP server; we do the same for session listing.
// No host-detection env var was found exported by OpenCode into child processes
// (verified live). detectHost returns null on purpose.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tryExec, readJson, fileExists, opencodeHome, HOME } from "../util.mjs";
import { probeJsonl, probeWithActivity } from "../probe.mjs";
import { isBridgeProtocolNoise } from "../delta.mjs";

export const id = "opencode";
export const displayName = "OpenCode";
export const injection = "prompt";

// Conflict flags
export const conflictFlags = [
  { flags: ["-c", "--continue"], value: "none", why: "the bridge resumes the linked session" },
  { flags: ["-s", "--session"], value: "required", why: "the bridge supplies the linked session itself" },
  { flags: ["--fork"], value: "none", why: "forking creates a new session and breaks the link" },
  { flags: ["-p", "--prompt"], value: "optional", why: "the launcher runs the interactive TUI" },
];

/**
 * Export a session to a temp file and read it back.
 *
 * `opencode export` behaves differently by output type, verified live: piped to
 * a buffer it truncates at 128KB and leaks a progress line; written to a real
 * file it produces the complete JSON (measured 606KB on a large session). So the
 * export must land in a file, not a captured pipe.
 *
 * The file is a fresh mkdtemp directory and OpenCode's stdout is pointed at it by
 * an fd Node opens, so there is no shell, no interpolation of the session id, and
 * no predictable /tmp path to race or hijack. Errors are not swallowed by a shell
 * redirect; a failed export throws and returns null through the catch.
 */
function exportSession(sessionId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-export-"));
  const tmpFile = path.join(dir, "session.json");
  let fd;
  try {
    fd = fs.openSync(tmpFile, "w");
    execFileSync("opencode", ["export", sessionId], {
      stdio: ["ignore", fd, "ignore"],
      timeout: 15000,
    });
    fs.closeSync(fd);
    fd = undefined;
    return fs.readFileSync(tmpFile, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * The sessions OpenCode knows about.
 *
 * OpenCode's own CLI reads the store directly and prints a flat JSON array, so
 * there is no server to start and — the reason this exists — none to leak. An
 * earlier version spawned `opencode serve` on every call and killed it after;
 * but a call that timed out left the disowned server running, several piled up
 * (five were found alive during one debugging session), and because OpenCode is
 * client/server the TUI could attach to one of those stale servers and show its
 * state instead of the real one — old messages simply vanished on resume. The
 * CLI has no such split brain. The server path stays only as a fallback, now
 * with a trap so even a timeout takes its server down with it.
 */
function listSessions() {
  const raw = tryExec("opencode", ["session", "list", "--format", "json"], { timeout: 10000 });
  if (raw) {
    const start = raw.indexOf("[");
    if (start >= 0) {
      try {
        const data = JSON.parse(raw.slice(start));
        if (Array.isArray(data)) return data;
      } catch {
        // Malformed output: fall through to the server rather than trust it.
      }
    }
  }
  return listSessionsViaServer();
}

/**
 * Fallback for a machine where the CLI's `session list` cannot run (a missing
 * log dir made it error outright on one). The trap is the difference from the
 * old code: `kill` used to sit only on the success and failure lines, so a
 * `timeout` that SIGTERM'd bash never reached them and orphaned the server. On
 * EXIT/INT/TERM the trap always fires.
 */
function listSessionsViaServer() {
  try {
    const port = 4096 + Math.floor(Math.random() * 1000);
    const script = [
      `opencode serve --hostname=127.0.0.1 --port=${port} &`,
      `SERVER_PID=$!`,
      `trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM`,
      `for i in $(seq 1 40); do`,
      `  sleep 0.2`,
      `  RESP=$(curl -sf http://127.0.0.1:${port}/api/session 2>/dev/null)`,
      `  if [ -n "$RESP" ]; then`,
      `    echo "$RESP" | grep '^{' || true`,
      `    exit 0`,
      `  fi`,
      `done`,
      `exit 1`,
    ].join("\n");
    const raw = execFileSync("/bin/bash", ["-c", script], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Server output mixes with curl output; extract the JSON line
    const jsonLine = raw.split("\n").find((l) => l.startsWith("{"));
    if (!jsonLine) return [];
    const data = JSON.parse(jsonLine);
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}

/**
 * Deterministic: OpenCode records the project directory in each session.
 * Returns the newest session whose directory matches, or null.
 */
export function discover(projectDir) {
  const want = path.resolve(projectDir);
  const sessions = listSessions()
    .filter((s) => {
      if (!s?.id) return false;
      const dir = s?.location?.directory ?? s?.directory;
      return dir && path.resolve(dir) === want;
    })
    .sort((a, b) => (b.time?.updated ?? b.updated ?? 0) - (a.time?.updated ?? a.updated ?? 0));
  if (!sessions.length) return null;
  const s = sessions[0];
  return {
    id: s.id,
    transcriptPath: null,
    updatedAt: s.time?.updated ?? s.updated ?? null,
    deterministic: sessions.length === 1,
  };
}

/**
 * Rebuild a ref from a stored session id.
 */
export function hydrate(_projectDir, slot) {
  return slot?.id ? { id: slot.id, transcriptPath: null } : null;
}

export function resumeCommand(ref, extraArgs = []) {
  return ref?.id
    ? { cmd: "opencode", args: ["--session", ref.id, ...extraArgs] }
    : { cmd: "opencode", args: [...extraArgs] };
}

// One single-quoted SQLite string literal. Doubling the quote is the whole of
// SQLite's literal escaping, so this is safe against the delta's content; it is
// not a general shell escape, and the value only ever reaches sqlite3 as one argv
// element, never a shell.
function sqlStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * The SQL that injects one bridge message into an OpenCode session, pure so it
 * can be tested against a throwaway database with the real schema.
 *
 * Two properties it must have, both learned the hard way in this project.
 * It is one transaction: the message row and its text part are inserted together
 * or not at all, so a failure never leaves an orphan message with no part that
 * would render broken in the TUI. And it is idempotent: the ids are derived from
 * the delta's own content, and the inserts are OR IGNORE, so injecting the same
 * context twice — which happens if the launcher recomputes the command before
 * delivery is committed — is a harmless no-op rather than a duplicate message.
 */
export function injectionSql(sessionId, delta, now) {
  const key = createHash("sha1").update(`${sessionId}\n${delta}`).digest("hex").slice(0, 16);
  const msgId = `msg_bridge_${key}`;
  const partId = `part_bridge_${key}`;
  const messageData = JSON.stringify({
    role: "user",
    mode: "build",
    agent: "build",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now },
  });
  const partData = JSON.stringify({ type: "text", text: delta, time: { start: now, end: now } });
  return (
    "BEGIN;\n" +
    `INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES (${sqlStr(msgId)}, ${sqlStr(sessionId)}, ${now}, ${now}, ${sqlStr(messageData)});\n` +
    `INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${sqlStr(partId)}, ${sqlStr(msgId)}, ${sqlStr(sessionId)}, ${now}, ${now}, ${sqlStr(partData)});\n` +
    "COMMIT;"
  );
}

/**
 * Inject the delta into OpenCode's own session store directly, authless and
 * costless: the message is present when the TUI opens, with no model call. This
 * replaced running `opencode run`, which is a real API call that needs a paid,
 * authenticated provider and stalled a live switch on auth.
 *
 * This returns the write as a command for the launcher to run once, rather than
 * performing it here: `preResume` is called from `buildCommand`, which is meant
 * to only compute what to run, and doing the write as a side effect of that could
 * fire more than once per launch. The idempotent SQL above makes a double run
 * harmless regardless, but the write belongs at execution time, not compute time.
 *
 * Schema coupling to OpenCode's message and part tables is the accepted cost of
 * being authless; a schema change in OpenCode is what would break it, and the
 * tests pin the columns this depends on.
 */
export function preResume(ref, delta) {
  if (!ref?.id || !delta) return null;
  const dbPath = path.join(opencodeHome(), "opencode.db");
  if (!fileExists(dbPath)) return null;
  return {
    cmd: "sqlite3",
    args: [dbPath, injectionSql(ref.id, delta, Date.now())],
    note: "Injecting context into OpenCode's session store (authless)…",
  };
}

export function startCommand(extraArgs = []) {
  return { cmd: "opencode", args: [...extraArgs] };
}

export function promptArgs(delta) {
  // OpenCode cannot accept prompts via command-line `--`.
  // Delta injection is handled by preResume() instead.
  return [];
}

// No auto-start, on purpose. Claude and Codex open the turn their hook cannot
// with a one-line kickoff, and there the agent works in the interactive session
// under the person's eye. OpenCode has no seam that reaches the same place: no
// hook, and its TUI cannot submit an opening message. Every route was tried live
// and each fails a different way. `--prompt` only fills the input box without
// submitting. `opencode run -i <msg>` submits but runs a streaming tool-calling
// mode that is not the clean TUI a handoff should land in. Driving OpenCode's own
// HTTP server (`opencode serve` + POST /session/<id>/message) does auto-submit on
// the free model, but only a text reply comes back — the free model would not
// reliably use tools, so it acknowledges the handoff without acting on it, which
// is worth nothing for a review-the-changes handoff. The one route left, a
// persistent server with the TUI attached so work streams live, means rebuilding
// the launch path around a server we own for the session's life; that is a real
// risk to the switch machinery for a payoff the free model caps anyway, so it was
// declined. The delta is delivered into history (see preResume) and the person
// opens the turn. The other four auto-start; this is the documented exception.

/**
 * OpenCode sessions carry timestamps, so the mark is an ISO instant.
 */
export function currentMark() {
  return new Date().toISOString();
}

/**
 * Parse messages from an `opencode export` output.
 * Returns [{role, text, at}] for user/assistant messages only.
 * Exported so its handling of the export shape can be tested against fixtures
 * without shelling out to a real OpenCode session.
 */
export function parseExportMessages(raw) {
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) return [];
  let d;
  try {
    d = JSON.parse(raw.slice(jsonStart));
  } catch {
    return [];
  }
  const messages = [];
  for (const m of d?.messages ?? []) {
    const info = m?.info;
    const parts = m?.parts ?? [];
    if (!info?.role) continue;
    if (info.role !== "user" && info.role !== "assistant") continue;
    const textParts = parts.filter((p) => p?.type === "text" && typeof p.text === "string");
    if (!textParts.length) continue;
    const text = textParts.map((p) => p.text).join("\n").trim();
    if (!text) continue;
    const at = info.time?.created ? new Date(info.time.created).toISOString() : null;
    messages.push({ role: info.role === "user" ? "user" : "assistant", text, at });
  }
  return messages;
}

/**
 * Read the session export and extract activity since the mark.
 */
export function activitySince(ref, sinceIso) {
  if (!ref?.id) return { messages: [], patchedFiles: [], turnsCompleted: 0 };
  const raw = exportSession(ref.id);
  if (!raw) return { messages: [], patchedFiles: [], turnsCompleted: 0 };
  const all = parseExportMessages(raw);
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  const messages = all.filter((m) => {
    if (!m.at) return true;
    const t = Date.parse(m.at);
    return !Number.isFinite(t) || t > since;
  }).filter((m) => !(m.role === "user" && isBridgeProtocolNoise(m.text)));
  return { messages, patchedFiles: [], turnsCompleted: 0 };
}

/**
 * Idle detection: export the session and check if the last message is from
 * the assistant.
 */
export function idleAfter(ref, sinceIso) {
  if (!ref?.id) return false;
  const raw = exportSession(ref.id);
  if (!raw) return false;
  const all = parseExportMessages(raw);
  if (!all.length) return false;
  const last = all[all.length - 1];
  return last.role === "assistant";
}

/**
 * OpenCode stores sessions in SQLite, not JSONL files.
 */
export function parseProbe(ref) {
  if (!ref?.id) return { status: "missing", detail: "no session id" };
  const raw = exportSession(ref.id);
  if (!raw) return { status: "missing", detail: "export failed" };
  const messages = parseExportMessages(raw);
  return {
    status: messages.length > 0 ? "readable" : "partial",
    detail: `${messages.length} messages parsed from export`,
  };
}

export function discoveryProbe(projectDir) {
  const sessions = listSessions();
  if (!sessions.length) return { status: "none", examined: 0, recognised: 0 };
  const recognised = sessions.filter((s) => s?.id && (s?.location?.directory ?? s?.directory)).length;
  return {
    status: recognised > 0 ? "readable" : "blind",
    examined: sessions.length,
    recognised,
  };
}

/**
 * Adopt a session that was started outside the bridge.
 */
export function adoptStartedSession(projectDir, { startedAt } = {}) {
  const want = path.resolve(projectDir);
  const since = startedAt ? Date.parse(startedAt) : 0;
  return listSessions()
    .filter((s) => {
      if (!s?.id) return false;
      const dir = s?.location?.directory ?? s?.directory;
      if (!dir || path.resolve(dir) !== want) return false;
      const created = s.time?.created ?? s.created;
      if (since && created && created < since) return false;
      return true;
    })
    .sort((a, b) => (b.time?.updated ?? b.updated ?? 0) - (a.time?.updated ?? a.updated ?? 0))
    .map((s) => ({ id: s.id, transcriptPath: null }));
}

export function health() {
  const version = tryExec("opencode", ["--version"]);
  const authOutput = tryExec("opencode", ["auth", "list"], { timeout: 5000 });
  const hasAuth = authOutput ? !authOutput.includes("0 credentials") : false;
  const configDir = path.join(HOME, ".config", "opencode");
  const authConfigured = hasAuth || fileExists(path.join(configDir, "auth.json"));
  // Delivery into OpenCode is a `sqlite3` write (see preResume); it is the one
  // external tool this adapter shells to beyond `opencode` itself. Missing it does
  // not stop the session opening, but the handoff cannot be injected and stays
  // pending, so say so rather than let it fail quietly at switch time.
  const hasSqlite = !!tryExec("sqlite3", ["--version"]);
  return {
    version,
    auth: { ok: authConfigured, via: "opencode auth login", account: null },
    extras: [
      {
        ok: authConfigured,
        info: true,
        label: authConfigured ? "Authentication configured" : "No auth configured — run: opencode auth login",
      },
      {
        ok: hasSqlite,
        info: true,
        label: hasSqlite
          ? "sqlite3 present (used to inject a handoff into OpenCode's session store)"
          : "sqlite3 not found — a handoff into OpenCode needs it to inject context; the session still opens but the delta stays pending until it is installed",
      },
    ],
    ready: !!(version),
    installHint: "npm install -g opencode-ai",
  };
}

export function smokeCommand() {
  return { cmd: "opencode", args: ["run", "Reply with exactly: bridge-ok"] };
}

/**
 * No host-detection env var found in OpenCode child processes (verified live).
 */
export function detectHost() {
  return null;
}

/**
 * OpenCode's record is export-based, not JSONL.
 */
export const capabilities = {
  commands: false,
  commandArgs: false,
  outcome: false,
  exitCode: false,
  duration: false,
  filesRead: false,
  filesChanged: false,
  toolOutput: "truncated",
  reasoning: "full",
  tokenUsage: true,
  pairing: "positional",
};

/** What this session proves about OpenCode. */
export function observeAudit(ref) {
  if (!ref?.id) return { commandArgs: null };
  const raw = exportSession(ref.id);
  if (!raw) return { commandArgs: null };
  const hasTools = raw.includes('"type":"tool"') || raw.includes('"tool":"');
  return { commandArgs: hasTools ? true : null };
}

/**
 * What OpenCode actually ran since the mark.
 */
export function auditSince(ref, sinceIso) {
  if (!ref?.id) return { commands: [], filesRead: [], filesChanged: [], dropped: 0 };
  const raw = exportSession(ref.id);
  if (!raw) return { commands: [], filesRead: [], filesChanged: [], dropped: 0 };
  return parseAudit(raw, sinceIso);
}

/**
 * Pull commands, files read and files changed out of an export, pure so it can
 * be tested against a fixture rather than a live session. OpenCode records tool
 * use as `part.type === "tool"` with the call in `part.state.input`.
 */
export function parseAudit(raw, sinceIso) {
  const empty = { commands: [], filesRead: [], filesChanged: [], dropped: 0 };
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) return empty;
  let d;
  try {
    d = JSON.parse(raw.slice(jsonStart));
  } catch {
    return empty;
  }

  const commands = [];
  const filesRead = new Set();
  const filesChanged = new Set();
  const since = sinceIso ? Date.parse(sinceIso) : 0;

  for (const m of d?.messages ?? []) {
    const info = m?.info;
    const msgTime = info?.time?.created;
    if (since && msgTime && msgTime <= since) continue;

    for (const part of m?.parts ?? []) {
      if (part?.type !== "tool") continue;
      const tool = part?.tool;
      const state = part?.state;
      if (tool === "bash" && state?.input?.command) {
        commands.push({
          tool: "bash",
          args: state.input.command,
          at: state?.time?.start ? new Date(state.time.start).toISOString() : null,
          ok: state?.status === "completed",
          exitCode: state?.metadata?.exit ?? null,
          durationMs: state?.time?.start && state?.time?.end
            ? state.time.end - state.time.start
            : null,
        });
      }
      if (tool === "read" && state?.input?.filePath) {
        filesRead.add(state.input.filePath);
      }
      if ((tool === "edit" || tool === "write") && state?.input?.filePath) {
        filesChanged.add(state.input.filePath);
      }
    }
  }

  return {
    commands,
    filesRead: [...filesRead],
    filesChanged: [...filesChanged],
    dropped: 0,
  };
}
