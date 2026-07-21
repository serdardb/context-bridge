// Claude Code adapter. Thin: the behaviour already existed and is reused as-is,
// so this round only gives it the shared shape. Injection is the one asymmetry
// that survives — Claude has no auto-submitted resume prompt, so context arrives
// through the official SessionStart hook instead.
import fs from "node:fs";
import path from "node:path";
import { latestClaudeTranscript, claudeTranscriptsSince } from "../discover.mjs";
import { claudeMessagesSince } from "../delta.mjs";
import { probeJsonl, probeWithActivity } from "../probe.mjs";
import { nowIso, tryExec, fileExists, readJson, HOME, CLAUDE_DIR } from "../util.mjs";

export const id = "claude";
export const displayName = "Claude Code";
export const injection = "hook";

export const conflictFlags = [
  { flags: ["-c", "--continue"], value: "none", why: "the bridge resumes the linked session" },
  { flags: ["--resume"], value: "optional", why: "the bridge supplies the linked session itself" },
  { flags: ["--session-id"], value: "required", why: "the bridge supplies the linked session itself" },
  { flags: ["--fork-session"], value: "none", why: "forking mints a new session id and breaks the link" },
  {
    flags: ["--no-session-persistence"],
    value: "none",
    why: "without a saved transcript the bridge cannot build a delta",
  },
  { flags: ["-p", "--print"], value: "optional", why: "the launcher runs the interactive TUI" },
];

/** Heuristic by nature: newest transcript for the project. Callers must confirm. */
export function discover(projectDir) {
  const found = latestClaudeTranscript(projectDir);
  return found ? { id: found.sessionId, transcriptPath: found.p, updatedAt: found.mtime } : null;
}

/**
 * Claude names each transcript after its session id, so discovery is readable
 * whenever the project directory holds transcripts we can name.
 */
export function discoveryProbe(projectDir) {
  const found = claudeTranscriptsSince(projectDir, 0);
  if (!found.length) return { status: "none", examined: 0, recognised: 0 };
  const recognised = found.filter((c) => c.sessionId).length;
  return { status: recognised > 0 ? "readable" : "blind", examined: found.length, recognised };
}

/**
 * Claude normally links itself through the SessionStart hook, so this is the
 * fallback for a session running without the plugin installed. Transcripts carry
 * no pid, so the only evidence is the project directory and the time window.
 */
export function adoptStartedSession(projectDir, { startedAt } = {}) {
  const since = startedAt ? Date.parse(startedAt) : 0;
  return claudeTranscriptsSince(projectDir, Number.isFinite(since) ? since : 0).map((c) => ({
    id: c.sessionId,
    transcriptPath: c.p,
  }));
}

export function resumeCommand(ref, extraArgs = []) {
  // Our --resume goes last so the bridge's session control wins any tie.
  return ref?.id
    ? { cmd: "claude", args: [...extraArgs, "--resume", ref.id] }
    : { cmd: "claude", args: [...extraArgs] };
}

export function activitySince(ref, sinceIso) {
  const messages = claudeMessagesSince(ref.transcriptPath, sinceIso);
  return { messages, patchedFiles: [], turnsCompleted: 0 };
}

/**
 * Claude rows are typed and timestamped; a transcript with no `user`/`assistant`
 * row carrying a timestamp is one we can no longer read, whatever else is in it.
 */
export function parseProbe(ref) {
  const shape = probeJsonl(ref?.transcriptPath, (r) => (r.type === "user" || r.type === "assistant") && !!r.timestamp);
  return probeWithActivity({ activitySince }, ref, shape);
}

export function hydrate(_projectDir, slot) {
  return slot?.id ? { id: slot.id, transcriptPath: slot.transcriptPath } : null;
}

/** Claude reports idleness through the Stop hook, not through its transcript. */
export function idleAfter() {
  return null;
}

/** Claude filters by transcript timestamp, so its mark is an ISO instant. */
export function currentMark() {
  return nowIso();
}

/** A brand new session. Claude receives context through its hook, not a prompt. */
export function startCommand(extraArgs = []) {
  return { cmd: "claude", args: [...extraArgs] };
}

/** What `bridge doctor` needs to know about this agent. Never reads a secret. */
export function health() {
  const version = tryExec("claude", ["--version"]);
  const account = readJson(path.join(HOME, ".claude.json"))?.oauthAccount?.emailAddress ?? null;
  let auth = { ok: false, via: null, account: null };
  if (process.platform === "darwin" && tryExec("security", ["find-generic-password", "-s", "Claude Code-credentials"]) !== null) {
    auth = { ok: true, via: "keychain", account };
  } else if (fileExists(path.join(CLAUDE_DIR, ".credentials.json"))) {
    auth = { ok: true, via: "credentials-file", account };
  } else if (account) {
    auth = { ok: true, via: "oauth-account", account };
  }
  const plugins = readJson(path.join(CLAUDE_DIR, "plugins", "installed_plugins.json"))?.plugins || {};
  const bridgePlugin = !!plugins["bridge@context-bridge"];
  return {
    version,
    auth,
    extras: [
      {
        ok: bridgePlugin,
        label: "context-bridge plugin installed (provides /bridge and the session hooks)",
        fix: "bridge doctor --fix",
      },
    ],
    // Claude needs its plugin: without the hooks nothing records the session.
    ready: !!(version && auth.ok && bridgePlugin),
    installHint: "curl -fsSL https://claude.ai/install.sh | bash",
  };
}

/** A harmless one-line headless prompt: proves the CLI actually answers today. */
export function smokeCommand() {
  return { cmd: "claude", args: ["-p", "Reply with exactly: bridge-ok"] };
}

/**
 * `CLAUDECODE` is exported into the session, so it inherits into children and on
 * its own proves only that Claude is somewhere above us. What makes it usable is
 * the launcher: it deletes both Claude markers before spawning any agent, so a
 * surviving marker means no bridge-launched agent stands between us and Claude.
 * Under the launcher this is not consulted at all.
 */
export function detectHost(env = process.env) {
  return env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT ? "claude" : null;
}

/**
 * Measured on a real 7878-row session transcript, not read from documentation.
 *
 * Tool calls and their results pair perfectly through `tool_use_id`: 1185 of
 * 1185 in the session this was measured on, with failures marked by `is_error`.
 * What Claude does NOT record is the shape of the result: there is no exit code,
 * only a boolean, and no duration at all.
 *
 * `filesRead` is the honest weak spot. The `Read` tool names its file, but most
 * reading here happens inside `Bash` (930 calls against 56 Reads) through grep,
 * sed and cat, which is invisible without parsing shell. Reporting only the Read
 * tool would make Claude look like it barely reads anything, so this says partial
 * rather than true and the difference is the whole reason the field is not a
 * boolean.
 */
export const capabilities = {
  commands: true,
  commandArgs: true,
  outcome: true,
  exitCode: false,
  duration: false,
  filesRead: "partial",
  filesChanged: true,
  toolOutput: "pointer",
  reasoning: "full",
  tokenUsage: false,
  pairing: "keyed",
};

/** What this session proves about Claude. `null` means it was silent. */
export function observeAudit(ref) {
  let sawTool = false;
  let args = false;
  let exitCode = false;
  let content;
  try {
    content = fs.readFileSync(ref?.transcriptPath, "utf8");
  } catch {
    return { commandArgs: null, exitCode: null };
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    for (const b of row?.message?.content ?? []) {
      if (b?.type === "tool_use") {
        sawTool = true;
        if (b.input && Object.keys(b.input).length) args = true;
      }
      // If Claude ever starts reporting a real exit code, this notices. Today it
      // reports only is_error, which is why the declaration says false.
      if (b?.type === "tool_result" && (b.exit_code !== undefined || b.exitCode !== undefined)) exitCode = true;
    }
  }
  if (!sawTool) return { commandArgs: null, exitCode: null };
  return { commandArgs: args, exitCode };
}
