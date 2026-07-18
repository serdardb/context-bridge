// `bridge handoff codex` — runs inside Claude (via the /bridge slash command).
// `bridge handoff claude` — runs inside Codex (via the $bridge skill).
// Both persist state + pending markers; the launcher does the actual switching.
import fs from "node:fs";
import path from "node:path";
import { ensureState, saveState, writeCheckpoint } from "./state.mjs";
import { transferClaudeSession } from "./transfer.mjs";
import { findRolloutPath } from "./discover.mjs";
import {
  claudeMessagesSince,
  codexActivitySince,
  gitDelta,
  currentGitSha,
  composeDelta,
} from "./delta.mjs";
import { nowIso, tryExec, fileExists, OK, WARN } from "./util.mjs";

function splitNotes(s) {
  return String(s || "")
    .split(/;|\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function preflightCodex() {
  if (!tryExec("codex", ["--version"])) {
    throw new Error("Codex CLI is not installed. Install with: npm install -g @openai/codex  (then rerun /bridge codex)");
  }
  if (tryExec("codex", ["login", "status"]) === null) {
    throw new Error("Codex is installed but not authenticated. Run: codex login  (your ChatGPT subscription can be used), then rerun /bridge codex");
  }
}

/** Claude -> Codex handoff. Returns a short user-facing report string. */
export function handoffCodex(projectDir, { decisions = "", next = "" } = {}) {
  const s = ensureState(projectDir);
  const lines = [];

  if (!s.agents.claude.sessionId || !s.agents.claude.transcriptPath) {
    throw new Error(
      "No Claude session recorded for this project yet. The context-bridge plugin's SessionStart hook records it — " +
        "make sure the plugin is installed (`bridge doctor`) and you are running /bridge codex inside a Claude session started in this project."
    );
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
    const delta = composeDelta({
      fromAgent: "claude",
      conversation: msgs,
      decisions: splitNotes(decisions),
      work: git.lines,
      next: splitNotes(next),
    });
    const deltaWithAck =
      delta + "\n\nAcknowledge this context in one short sentence and continue from here. Do not repeat it back.";
    const rel = writeCheckpoint(projectDir, `${ts(now)}-claude-to-codex.md`, deltaWithAck);
    s.pendingInjection = { agent: "codex", threadId: s.agents.codex.threadId, deltaFile: rel, createdAt: now };
    s.agents.codex.lastSyncAt = now;
    lines.push(`${OK} Prepared Claude→Codex context delta (${msgs.length} messages, ${git.lines.length} work items).`);
  }

  s.git = { sha: currentGitSha(projectDir), recordedAt: now };
  s.agents.claude.idle = false; // Stop hook will flip this when the turn completes
  s.pendingHandoff = { target: "codex", ready: true, requestedAt: now };
  saveState(projectDir, s);

  lines.push(`${OK} Handoff to Codex is ready. The bridge launcher will close Claude and open Codex automatically.`);
  lines.push("If you started Claude without the bridge launcher, exit Claude and run: bridge codex");
  return lines.join("\n");
}

/** Codex -> Claude handoff. Returns a short user-facing report string. */
export function handoffClaude(projectDir, { decisions = "", next = "" } = {}) {
  const s = ensureState(projectDir);
  const lines = [];

  if (!s.agents.codex.threadId) {
    throw new Error("No linked Codex thread for this project. Start from Claude with /bridge codex first.");
  }
  if (!s.agents.claude.sessionId) {
    throw new Error("No original Claude session recorded for this project — nothing to return to.");
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
  const delta = composeDelta({
    fromAgent: "codex",
    conversation: activity.messages,
    decisions: splitNotes(decisions),
    work,
    next: splitNotes(next),
  });
  const rel = writeCheckpoint(projectDir, `${ts(now)}-codex-to-claude.md`, delta);

  s.pendingInjection = {
    agent: "claude",
    sessionId: s.agents.claude.sessionId,
    deltaFile: rel,
    createdAt: now,
  };
  s.agents.claude.lastSyncAt = now;
  s.git = { sha: currentGitSha(projectDir), recordedAt: now };
  s.pendingHandoff = { target: "claude", ready: true, requestedAt: now };
  saveState(projectDir, s);

  lines.push(`${OK} Prepared Codex→Claude context delta (${activity.messages.length} messages, ${work.length} work items).`);
  lines.push(`${OK} Handoff to Claude is ready. The bridge launcher will close Codex and resume your original Claude session automatically.`);
  lines.push("If you started Codex without the bridge launcher, exit Codex and run: bridge claude");
  if (!decisions && !next) {
    lines.push(`${WARN} No --decisions/--next notes were provided; the delta contains conversation + git truth only.`);
  }
  return lines.join("\n");
}

function ts(iso) {
  return iso.replace(/[:.]/g, "-");
}
