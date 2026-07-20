// Claude Code adapter. Thin: the behaviour already existed and is reused as-is,
// so this round only gives it the shared shape. Injection is the one asymmetry
// that survives — Claude has no auto-submitted resume prompt, so context arrives
// through the official SessionStart hook instead.
import { latestClaudeTranscript } from "../discover.mjs";
import { claudeMessagesSince } from "../delta.mjs";
import { nowIso } from "../util.mjs";

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
