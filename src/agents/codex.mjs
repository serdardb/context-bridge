// Codex adapter. Thin wrapper over the existing rollout discovery and parsing.
import { findRolloutPath, latestRolloutForProject } from "../discover.mjs";
import { codexActivitySince, rolloutIdleAfter } from "../delta.mjs";
import path from "node:path";
import { nowIso, fileExists, tryExec, HOME, CODEX_HOME } from "../util.mjs";

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

/** Rehydrate from state, re-finding the rollout if the stored path went stale. */
export function hydrate(_projectDir, slot) {
  if (!slot?.id) return null;
  const transcriptPath = slot.transcriptPath && fileExists(slot.transcriptPath)
    ? slot.transcriptPath
    : findRolloutPath(slot.id);
  return { id: slot.id, transcriptPath };
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

/** A brand new thread seeded by an initial prompt: `codex [OPTIONS] [PROMPT]`. */
export function startCommand(extraArgs = []) {
  return { cmd: "codex", args: [...extraArgs] };
}

export function health() {
  const version = tryExec("codex", ["--version"]);
  const detail = version ? tryExec("sh", ["-c", "codex login status 2>&1"]) : null;
  const skill = fileExists(path.join(HOME, ".agents", "skills", "bridge", "SKILL.md"));
  const rules = fileExists(path.join(CODEX_HOME, "rules", "bridge.rules"));
  return {
    version,
    auth: { ok: detail !== null, via: "codex login", account: detail },
    extras: [
      { ok: skill, label: "$bridge skill installed (~/.agents/skills/bridge)", fix: "bridge doctor --fix" },
      { ok: rules, label: "bridge command pre-allowed in Codex rules", fix: "bridge doctor --fix", info: true },
    ],
    ready: !!(version && detail !== null && skill),
    installHint: "npm install -g @openai/codex",
  };
}

export function smokeCommand() {
  return { cmd: "codex", args: ["exec", "Reply with exactly: bridge-ok"] };
}
