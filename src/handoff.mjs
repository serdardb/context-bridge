// `bridge handoff codex` — runs inside Claude (via the /bridge slash command).
// `bridge handoff claude` — runs inside Codex (via the $bridge skill).
// Both persist state + pending markers; the launcher does the actual switching.
import fs from "node:fs";
import path from "node:path";
import { ensureState, saveState, writeCheckpoint } from "./state.mjs";
import { transferClaudeSession } from "./transfer.mjs";
import { findRolloutPath, latestRolloutForProject, latestClaudeTranscript } from "./discover.mjs";
import {
  claudeMessagesSince,
  codexActivitySince,
  gitDelta,
  currentGitSha,
  composeDelta,
  composeFullContext,
} from "./delta.mjs";
import { pruneCheckpoints } from "./clean.mjs";
import { nowIso, tryExec, fileExists, OK, WARN, BridgeError } from "./util.mjs";

/** Auto-prune after a handoff writes its checkpoints. Never fails the handoff, never silent. */
function autoPrune(projectDir, lines) {
  try {
    const res = pruneCheckpoints(projectDir);
    if (res.deletedGroups > 0) {
      lines.push(`${OK} Pruned ${res.deletedGroups} old checkpoint groups (older than 7 days, beyond the newest 20).`);
    }
  } catch {}
}

function splitNotes(s) {
  return String(s || "")
    .split(/;|\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function preflightCodex() {
  if (!tryExec("codex", ["--version"])) {
    throw new BridgeError("Codex CLI is not installed. Install with: npm install -g @openai/codex  (then rerun /bridge codex)");
  }
  if (tryExec("codex", ["login", "status"]) === null) {
    throw new BridgeError("Codex is installed but not authenticated. Run: codex login  (your ChatGPT subscription can be used), then rerun /bridge codex");
  }
}

/** Claude -> Codex handoff. Returns a short user-facing report string. */
export function handoffCodex(projectDir, { decisions = "", next = "", adopt = false } = {}) {
  const s = ensureState(projectDir);
  const lines = [];

  if (!s.agents.claude.sessionId || !s.agents.claude.transcriptPath) {
    // Adopt path: the hook did not record this session (plugin installed
    // mid-session, or state was created after startup). Transcript discovery is
    // a HEURISTIC (newest mtime), so it requires explicit user confirmation.
    const cand = latestClaudeTranscript(projectDir);
    if (!cand) {
      throw new BridgeError(
        "No Claude session recorded for this project yet. The context-bridge plugin's SessionStart hook records it — " +
          "make sure the plugin is installed (`bridge doctor`) and you are running /bridge codex inside a Claude session started in this project."
      );
    }
    if (!adopt) {
      throw new BridgeError(
        "No Claude session recorded for this project, but a recent Claude transcript was found " +
          `(last active ${new Date(cand.mtime).toISOString()}). ` +
          "Confirm with the user that it belongs to THIS conversation, then rerun the same command with --adopt.",
        { exitCode: 2, code: "adopt-confirmation-needed" }
      );
    }
    s.agents.claude.sessionId = cand.sessionId;
    s.agents.claude.transcriptPath = cand.p;
    lines.push(`${OK} Adopted the most recent Claude session of this project (user-confirmed).`);
  }
  preflightCodex();

  const now = nowIso();
  if (!s.agents.codex.threadId) {
    // FIRST switch: official import (full context seed). Never repeated afterwards.
    const res = transferClaudeSession(s.agents.claude.transcriptPath);
    s.agents.codex.threadId = res.threadId;
    s.agents.codex.rolloutPath = findRolloutPath(res.threadId);
    s.agents.codex.lastSyncAt = now; // codex now knows claude-context up to now
    s.agents.claude.lastSyncAt = now; // nothing codex-side yet for claude to learn
    lines.push(`${OK} First switch: Claude session imported into Codex via the official OpenAI transfer.`);
  } else {
    // REPEAT switch: resume + delta. Never re-import.
    const msgs = claudeMessagesSince(s.agents.claude.transcriptPath, s.agents.codex.lastSyncAt);
    const git = gitDelta(projectDir, s.git.sha);
    const sections = {
      fromAgent: "claude",
      conversation: msgs,
      decisions: splitNotes(decisions),
      work: git.lines,
      next: splitNotes(next),
    };
    const delta = composeDelta(sections);
    const fullRel = writeCheckpoint(projectDir, `${ts(now)}-claude-to-codex-full.md`, composeFullContext(sections));
    const deltaWithAck =
      delta +
      `\n\nFull un-truncated context: ${fullRel} — messages above are clipped to one line each; read that file whenever exact wording matters.` +
      "\n\nAcknowledge this context in one short sentence and continue from here. Do not repeat it back.";
    const rel = writeCheckpoint(projectDir, `${ts(now)}-claude-to-codex.md`, deltaWithAck);
    s.pendingInjection = { agent: "codex", threadId: s.agents.codex.threadId, deltaFile: rel, createdAt: now };
    s.agents.codex.lastSyncAt = now;
    lines.push(`${OK} Prepared Claude→Codex context delta (${msgs.length} messages, ${git.lines.length} work items).`);
  }

  s.git = { sha: currentGitSha(projectDir), recordedAt: now };
  s.agents.claude.idle = false; // Stop hook will flip this when the turn completes
  s.pendingHandoff = { target: "codex", ready: true, requestedAt: now };
  saveState(projectDir, s);

  autoPrune(projectDir, lines);
  lines.push(`${OK} Handoff to Codex is ready. The bridge launcher will close Claude and open Codex automatically.`);
  lines.push("If you started Claude without the bridge launcher, exit Claude and run: bridge codex");
  return lines.join("\n");
}

/** Codex -> Claude handoff. Returns a short user-facing report string. */
export function handoffClaude(projectDir, { decisions = "", next = "", adopt = false } = {}) {
  const s = ensureState(projectDir);
  const lines = [];

  let adopted = false;
  if (!s.agents.codex.threadId) {
    // Adopt rule: automatic when identity is deterministic, confirmed when heuristic.
    const envId = process.env.CODEX_THREAD_ID;
    if (envId) {
      // Codex CLI exposes the running session's thread id — zero ambiguity.
      s.agents.codex.threadId = envId;
      s.agents.codex.rolloutPath = findRolloutPath(envId);
      if (s.agents.codex.rolloutPath) {
        lines.push(`${OK} Adopted this Codex session (started outside the bridge) as the project's linked thread.`);
      } else {
        // Never silent: without the rollout the delta loses the conversation,
        // keeping only git + decision truth — say so here AND inside the delta.
        lines.push(
          `${WARN} Adopted this Codex session, but its rollout file was not found under CODEX_HOME — ` +
            "the delta will carry git and decision truth only, not the conversation."
        );
      }
    } else {
      const cand = latestRolloutForProject(projectDir);
      if (!cand) {
        throw new BridgeError(
          "No linked Codex thread and no Codex session found for this project. " +
            "Start from Claude with /bridge codex, or run $bridge claude inside a Codex session working in this project."
        );
      }
      if (!adopt) {
        throw new BridgeError(
          "No linked Codex thread for this project, but an unlinked Codex session working in this directory was found " +
            `(started ${cand.startedAt ?? "at an unknown time"}, last active ${new Date(cand.mtime).toISOString()}). ` +
            "Confirm with the user that it is the right session, then rerun the same command with --adopt.",
          { exitCode: 2, code: "adopt-confirmation-needed" }
        );
      }
      s.agents.codex.threadId = cand.threadId;
      s.agents.codex.rolloutPath = cand.rolloutPath;
      lines.push(`${OK} Adopted the most recent Codex session of this project (user-confirmed).`);
    }
    // The adopted conversation was never synced: deliver it from the beginning.
    s.agents.claude.lastSyncAt = null;
    adopted = true;
  }
  if (!s.agents.codex.rolloutPath || !fileExists(s.agents.codex.rolloutPath)) {
    s.agents.codex.rolloutPath = findRolloutPath(s.agents.codex.threadId);
  }

  const now = nowIso();
  const activity = s.agents.codex.rolloutPath
    ? codexActivitySince(s.agents.codex.rolloutPath, s.agents.claude.lastSyncAt)
    : { messages: [], patchedFiles: [], turnsCompleted: 0 };
  const git = gitDelta(projectDir, s.git.sha);
  const work = [
    ...activity.patchedFiles.map((f) => `Modified via Codex patch: ${f}`),
    ...git.lines,
  ];
  const sections = {
    fromAgent: "codex",
    conversation: activity.messages,
    decisions: splitNotes(decisions),
    work,
    next: splitNotes(next),
  };
  let delta = composeDelta(sections);
  const fullRel = writeCheckpoint(projectDir, `${ts(now)}-codex-to-claude-full.md`, composeFullContext(sections));
  delta += `\n\nFull un-truncated context: ${fullRel} — messages above are clipped to one line each; read that file whenever exact wording matters.`;
  if (adopted && s.agents.codex.rolloutPath) {
    // The bounded delta cannot carry a whole adopted session — point Claude at
    // the native rollout so it can read the full history on demand.
    delta +=
      `\n\nFull transcript of the adopted Codex session (JSONL): ${s.agents.codex.rolloutPath}` +
      "\nRead it if you need more detail than this bounded delta.";
  } else if (adopted) {
    delta +=
      "\n\n[Bridge warning] The adopted Codex session's conversation history could not be read " +
      "(rollout file not found) — this delta carries git and decision truth only. " +
      "Ask the user to fill in anything that seems missing.";
  }
  const rel = writeCheckpoint(projectDir, `${ts(now)}-codex-to-claude.md`, delta);

  s.pendingInjection = {
    agent: "claude",
    // null = Codex-first project: no session to resume — the delta seeds the
    // first Claude session that starts in this project instead.
    sessionId: s.agents.claude.sessionId ?? null,
    deltaFile: rel,
    createdAt: now,
  };
  s.agents.claude.lastSyncAt = now;
  s.git = { sha: currentGitSha(projectDir), recordedAt: now };
  s.pendingHandoff = { target: "claude", ready: true, requestedAt: now };
  saveState(projectDir, s);

  lines.push(`${OK} Prepared Codex→Claude context delta (${activity.messages.length} messages, ${work.length} work items).`);
  lines.push(
    s.agents.claude.sessionId
      ? `${OK} Handoff to Claude is ready. The bridge launcher will close Codex and resume your original Claude session automatically.`
      : `${OK} Handoff to Claude is ready. The bridge launcher will close Codex and start a fresh Claude session seeded with this context.`
  );
  autoPrune(projectDir, lines);
  lines.push("If you started Codex without the bridge launcher, exit Codex and run: bridge claude");
  if (!decisions && !next) {
    lines.push(`${WARN} No --decisions/--next notes were provided; the delta contains conversation + git truth only.`);
  }
  return lines.join("\n");
}

function ts(iso) {
  return iso.replace(/[:.]/g, "-");
}
