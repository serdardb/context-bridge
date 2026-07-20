// Codex adapter. Thin wrapper over the existing rollout discovery and parsing.
import { findRolloutPath, latestRolloutForProject } from "../discover.mjs";
import { codexActivitySince, rolloutIdleAfter } from "../delta.mjs";
import { nowIso } from "../util.mjs";

export const id = "codex";
export const displayName = "Codex";
export const injection = "prompt";

export const conflictFlags = [
  { flags: ["--last"], value: "none", why: "codex rejects --last together with the delta prompt" },
  { flags: ["-C", "--cd"], value: "required", why: "bridge state belongs to this project directory" },
  { flags: ["--remote"], value: "required", why: "a remote session writes no local rollout to read" },
  { flags: ["--remote-auth-token-env"], value: "required", why: "only used with --remote" },
];

/**
 * Deterministic when CODEX_THREAD_ID is set (we are inside the session), heuristic
 * otherwise — the caller decides whether confirmation is required.
 */
export function discover(projectDir) {
  const envId = process.env.CODEX_THREAD_ID;
  if (envId) {
    const rolloutPath = findRolloutPath(envId);
    return { id: envId, transcriptPath: rolloutPath, deterministic: true };
  }
  const found = latestRolloutForProject(projectDir);
  return found
    ? { id: found.threadId, transcriptPath: found.rolloutPath, updatedAt: found.mtime, deterministic: false }
    : null;
}

export function refById(_projectDir, threadId) {
  const rolloutPath = findRolloutPath(threadId);
  return rolloutPath ? { id: threadId, transcriptPath: rolloutPath } : null;
}

export function resumeCommand(ref, extraArgs = []) {
  return { cmd: "codex", args: ["resume", ref.id, ...extraArgs] };
}

export function promptArgs(delta) {
  // `--` first: without it a trailing variadic flag (-i/--image …) swallows the delta.
  return ["--", delta];
}

export function activitySince(ref, sinceIso) {
  return codexActivitySince(ref.transcriptPath, sinceIso);
}

export function idleAfter(ref, sinceIso) {
  return ref.transcriptPath ? rolloutIdleAfter(ref.transcriptPath, sinceIso) : false;
}

/** Codex rollout records carry timestamps, so its mark is an ISO instant. */
export function currentMark() {
  return nowIso();
}
