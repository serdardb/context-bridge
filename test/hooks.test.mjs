import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultState, saveState, loadState } from "../src/state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_BIN = path.join(ROOT, "bin", "bridge.mjs");

test("Claude SessionStart hook injects pending delta exactly once", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hook-"));
  const checkpointDir = path.join(project, ".bridge", "checkpoints");
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(path.join(checkpointDir, "delta.md"), "[Bridge Context Update]\nCodex changed files.\n");

  const state = defaultState(project);
  state.agents.claude.id = "claude-session-1";
  state.agents.claude.transcriptPath = path.join(project, "claude.jsonl");
  state.pendingInjection = {
    agent: "claude",
    id: "claude-session-1",
    deltaFile: path.join(".bridge", "checkpoints", "delta.md"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  saveState(project, state);

  const input = JSON.stringify({
    cwd: project,
    source: "resume",
    session_id: "claude-session-1",
    transcript_path: state.agents.claude.transcriptPath,
  });

  const first = runHook(input);
  assert.equal(first.status, 0);
  const payload = JSON.parse(first.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(payload.hookSpecificOutput.additionalContext, /Codex changed files/);
  assert.equal(fs.existsSync(path.join(checkpointDir, "delta.md")), false);
  assert.equal(fs.existsSync(path.join(checkpointDir, "delta.md.consumed")), true);

  const second = runHook(input);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, "");
});

function runHook(input) {
  return spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start"], {
    input,
    // Scrubbed on purpose. A developer machine already carries another agent's
    // variables, and a test that inherits them is testing the machine rather than
    // the code: an earlier version of the guard's own test passed because the
    // ambient CLAUDECODE meant the guard was never reached.
    env: { ...cleanEnv(), CLAUDECODE: "1" },
    encoding: "utf8",
  });
}

// Grok loads Claude's own ~/.claude/settings.json hooks for compatibility, so a
// bridge hook can fire inside a Grok session and write Claude's slot from another
// agent's conversation: an id that looks entirely valid, pointing at the wrong
// session, with nothing to indicate it.
test("a hook running inside Grok refuses to touch this project's state", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-foreign-"));
  saveState(project, defaultState(project));
  const transcript = path.join(project, "transcript.jsonl");
  fs.writeFileSync(transcript, "");

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start"], {
    input: JSON.stringify({
      cwd: project,
      source: "startup",
      session_id: "session-belonging-to-grok",
      transcript_path: transcript,
    }),
    // GROK_HOOK_EVENT is injected by Grok's hook runner into every hook process,
    // which makes it a marker of a hook rather than of a session.
    env: { ...cleanEnv(), GROK_HOOK_EVENT: "session_start", GROK_SESSION_ID: "019f-grok" },
    encoding: "utf8",
  });

  assert.equal(res.status, 0, "a refusal is not a failure; the agent must keep working");
  assert.match(res.stderr, /Grok/, "the refusal has to say which agent it saw");
  assert.equal(loadState(project).agents.claude.id, null, "Grok must not become Claude's linked session");
});

// The first version of this guard also refused on CODEX_THREAD_ID, and review
// caught why that was wrong: it is ambient session environment, inherited by
// every child process, so a Claude hook running anywhere downstream of a Codex
// session was refused. A guard that disables the bridge on a variable nobody
// chose is worse than the exposure it was closing.
test("a leaked Codex session variable does not disable Claude's own hook", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-leak-"));
  saveState(project, defaultState(project));
  const transcript = path.join(project, "transcript.jsonl");
  fs.writeFileSync(transcript, "");

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start"], {
    input: JSON.stringify({ cwd: project, source: "startup", session_id: "real-claude", transcript_path: transcript }),
    env: { ...cleanEnv(), CODEX_THREAD_ID: "leaked-from-a-parent-shell" },
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  assert.equal(loadState(project).agents.claude.id, "real-claude", "the session must still be recorded");
});

test("the same hook still records the session when it really is Claude", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-native-"));
  saveState(project, defaultState(project));
  const transcript = path.join(project, "transcript.jsonl");
  fs.writeFileSync(transcript, "");

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start"], {
    input: JSON.stringify({ cwd: project, source: "startup", session_id: "real-claude", transcript_path: transcript }),
    env: { ...cleanEnv(), CLAUDECODE: "1" },
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  assert.equal(loadState(project).agents.claude.id, "real-claude");
});

/** The test's own environment, minus every agent marker, so each case sets its own. */
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|GROK_|CODEX_)/.test(key)) delete env[key];
  }
  return env;
}

// Codex hooks were proven live: SessionStart, UserPromptSubmit and Stop all fire
// and its hook input carries session_id and transcript_path, which makes linking
// a fact rather than the filesystem guesswork adoptStartedSession has to do.
test("the Codex hook links its own session from the hook input", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cxhook-"));
  saveState(project, defaultState(project));
  const rollout = path.join(project, "rollout.jsonl");
  fs.writeFileSync(rollout, "");

  const res = spawnSync(
    process.execPath,
    [BRIDGE_BIN, "internal-hook", "session-start", "--agent", "codex"],
    {
      input: JSON.stringify({ cwd: project, source: "startup", session_id: "019f-codex", transcript_path: rollout }),
      // No Codex marker is set, because Codex sets none: the hook is identified
      // by the --agent it was installed with and by its stdin payload.
      env: cleanEnv(),
      encoding: "utf8",
    }
  );

  assert.equal(res.status, 0);
  const slot = loadState(project).agents.codex;
  assert.equal(slot.id, "019f-codex");
  assert.equal(slot.transcriptPath, rollout);
  assert.ok(slot.hookSeen, "the run is stamped, so a later version can tell hooks are actually live here");
  assert.equal(loadState(project).agents.claude.id, null, "a Codex hook must never write Claude's slot");
});

// The guard is a comparison now, not a special case: each hook names the agent
// it was installed for, so it works the same way for an agent added later.
test("a hook installed for one agent refuses to run inside another", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-crossed-"));
  saveState(project, defaultState(project));
  const rollout = path.join(project, "rollout.jsonl");
  fs.writeFileSync(rollout, "");

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start", "--agent", "codex"], {
    input: JSON.stringify({ cwd: project, source: "startup", session_id: "019f-codex", transcript_path: rollout }),
    env: { ...cleanEnv(), GROK_HOOK_EVENT: "session_start" },
    encoding: "utf8",
  });

  assert.equal(res.status, 0, "a refusal is not a failure");
  assert.match(res.stderr, /Grok/);
  assert.equal(loadState(project).agents.codex.id, null, "nothing is written when the host is wrong");
});
