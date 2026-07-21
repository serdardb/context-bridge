// Codex adapter. Thin wrapper over the existing rollout discovery and parsing.
import {
  findRolloutPath,
  latestRolloutForProject,
  rolloutsForProjectSince,
  rolloutHeadHealth,
} from "../discover.mjs";
import { codexActivitySince, rolloutIdleAfter } from "../delta.mjs";
import { probeJsonl, probeWithActivity } from "../probe.mjs";
import fs from "node:fs";
import path from "node:path";
import {
  nowIso,
  fileExists,
  readJson,
  tryExec,
  codexHome,
  REPO_ROOT,
  sharedSkillPath,
  installedCopyStatus,
} from "../util.mjs";

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

/**
 * Is discovery itself still working? Codex sessions are stored by date, not by
 * project, so this asks whether the head-record reader can read rollouts at all
 * rather than whether one belongs here. A project with no Codex session must not
 * look broken; a machine full of rollouts that we can no longer parse must.
 */
export function discoveryProbe() {
  const { examined, recognised } = rolloutHeadHealth();
  if (examined === 0) return { status: "none", examined, recognised };
  return { status: recognised > 0 ? "readable" : "blind", examined, recognised };
}

/**
 * Rollouts record their own cwd and start time in the head record, so a session
 * started after the launcher spawned, in this project, is identifiable without
 * guessing. Codex writes no pid we can match, hence the time window instead.
 */
export function adoptStartedSession(projectDir, { startedAt } = {}) {
  return rolloutsForProjectSince(projectDir, startedAt)
    .map((r) => ({ id: r.threadId, transcriptPath: r.rolloutPath }))
    .filter((r) => r.id && r.transcriptPath);
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

/**
 * Codex wraps everything in {type, payload, timestamp}. We read `event_msg` and
 * `response_item` rows; if a rollout contains neither, the envelope has changed
 * under us and every delta from this agent would come back empty.
 */
export function parseProbe(ref) {
  const shape = probeJsonl(
    ref?.transcriptPath,
    (r) => (r.type === "event_msg" || r.type === "response_item") && !!r.timestamp && !!r.payload
  );
  return probeWithActivity({ activitySince }, ref, shape);
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

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"];

/** Where Codex looks for user-level hooks. */
export function hooksPath() {
  return path.join(codexHome(), "hooks.json");
}

/**
 * Our hook definitions, in Codex's own schema. `SessionStart` is matched on
 * startup and resume because those are the two ways a session we care about
 * begins; clear and compact are somebody else's business.
 *
 * Each command names the agent it belongs to, so a hook that ends up running
 * inside a different CLI can recognise that and refuse rather than writing the
 * wrong conversation into a project's state.
 */
export function hookDefinitions() {
  const entry = (event) => ({
    ...(event === "SessionStart" ? { matcher: "startup|resume" } : {}),
    hooks: [{ type: "command", command: `bridge internal-hook ${hookEventSlug(event)} --agent codex` }],
  });
  return Object.fromEntries(HOOK_EVENTS.map((event) => [event, [entry(event)]]));
}

function hookEventSlug(event) {
  return { SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", Stop: "stop" }[event];
}

/** Which of our hooks are present in the user's file, without judging the rest of it. */
export function installedHooks() {
  const file = readJson(hooksPath());
  const mine = hookDefinitions();
  const present = HOOK_EVENTS.filter((event) => {
    const groups = file?.hooks?.[event];
    if (!Array.isArray(groups)) return false;
    return groups.some((g) => (g?.hooks ?? []).some((h) => typeof h?.command === "string" && h.command.includes("internal-hook") && h.command.includes("--agent codex")));
  });
  return { present, missing: HOOK_EVENTS.filter((e) => !present.includes(e)), fileExists: !!file, definitions: mine };
}

/**
 * Add our hooks to whatever is already in the file. Codex merges every hook
 * source rather than letting one replace another, so the only wrong move here is
 * discarding somebody else's entries.
 */
export function installHooks() {
  const file = readJson(hooksPath()) ?? {};
  const hooks = { ...(file.hooks ?? {}) };
  const mine = hookDefinitions();
  for (const [event, groups] of Object.entries(mine)) {
    const existing = (hooks[event] ?? []).filter(
      (g) => !(g?.hooks ?? []).some((h) => typeof h?.command === "string" && h.command.includes("internal-hook") && h.command.includes("--agent codex"))
    );
    hooks[event] = [...existing, ...groups];
  }
  fs.mkdirSync(codexHome(), { recursive: true });
  fs.writeFileSync(hooksPath(), JSON.stringify({ ...file, hooks }, null, 2) + "\n");
  return hooksPath();
}

/**
 * Doctor's line about the hooks. It reports installation, which is knowable, and
 * says nothing about trust, which is not: Codex records hook trust somewhere we
 * cannot read, so claiming a hook will run would be exactly the kind of green
 * tick this project spent a release removing.
 */
function hookExtra() {
  const { present, missing } = installedHooks();
  if (!present.length) {
    return {
      ok: false,
      info: true,
      label: "Session hooks not installed (optional: they make Codex session linking exact)",
      fix: "bridge doctor --fix",
    };
  }
  if (missing.length) {
    return { ok: false, info: true, label: `Session hooks partly installed, missing ${missing.join(", ")}`, fix: "bridge doctor --fix" };
  }
  return {
    ok: true,
    info: true,
    label: "Session hooks installed — run /hooks inside Codex once to trust them, or they never fire",
  };
}

export function health() {
  const version = tryExec("codex", ["--version"]);
  const detail = version ? tryExec("sh", ["-c", "codex login status 2>&1"]) : null;
  const skill = installedCopyStatus(sharedSkillPath(), path.join(REPO_ROOT, "codex", "SKILL.md"));
  const rules = fileExists(path.join(codexHome(), "rules", "bridge.rules"));
  return {
    version,
    auth: { ok: detail !== null, via: "codex login", account: detail },
    extras: [
      hookExtra(),
      {
        ok: skill === "current",
        label: skillLabel(skill),
        fix: "bridge doctor --fix",
      },
      {
        ok: rules,
        // The label has to follow the state: a row that says "pre-allowed" while
        // the rule is missing reads as reassurance and is simply untrue.
        label: rules
          ? "bridge command pre-allowed in Codex rules"
          : "No Codex allow-rule for `bridge` — Codex will ask for approval once",
        fix: "bridge doctor --fix",
        info: true,
      },
    ],
    ready: !!(version && detail !== null && skill !== "missing"),
    installHint: "npm install -g @openai/codex",
  };
}

export function smokeCommand() {
  return { cmd: "codex", args: ["exec", "Reply with exactly: bridge-ok"] };
}

/** Says which of the three states the installed skill is in, never just "ok". */
export function skillLabel(status) {
  if (status === "missing") return "$bridge skill not installed (~/.agents/skills/bridge)";
  if (status === "stale") return "$bridge skill is OUT OF DATE (~/.agents/skills/bridge) — it teaches the old instructions";
  return "$bridge skill installed and current (~/.agents/skills/bridge)";
}

/**
 * Deliberately null, and this is the whole reason the method is documented rather
 * than merely declared. `CODEX_THREAD_ID` is ambient session state: it inherits
 * into every child, so it answers yes from inside a Grok or Antigravity session
 * the bridge launched, which is exactly the bug this replaced. Codex ships no
 * per-process host marker, so the honest answer is that we cannot tell. If one
 * ever appears, this is where it goes, and nowhere else.
 */
export function detectHost() {
  return null;
}
