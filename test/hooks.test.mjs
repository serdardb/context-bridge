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

// A pending deltaFile is state, and state can be corrupt or hostile. Before the
// containment gate, the SessionStart hook path.join'd it onto the project and
// renamed it to .consumed, so a `..` path renamed a real file outside .bridge. The
// hook now resolves through safeCheckpointPath: an escaping path reads as an
// unreadable delta and surfaces the missing-context notice, and nothing outside is
// touched. Revert the resolve to a raw path.join and the external file is renamed.
test("SessionStart refuses a pending deltaFile that escapes .bridge and never renames it", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hook-escape-")));
  fs.mkdirSync(path.join(project, ".bridge", "checkpoints"), { recursive: true });
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-outside-")));
  const evil = path.join(outside, "delta.md");
  fs.writeFileSync(evil, "external file the hook must not touch");

  const state = defaultState(project);
  state.agents.claude.id = "claude-session-1";
  state.agents.claude.transcriptPath = path.join(project, "claude.jsonl");
  state.pendingInjection = {
    agent: "claude",
    id: "claude-session-1",
    deltaFile: path.relative(project, evil), // ../bridge-outside-XXXX/delta.md
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  saveState(project, state);

  const input = JSON.stringify({
    cwd: project,
    source: "resume",
    session_id: "claude-session-1",
    transcript_path: state.agents.claude.transcriptPath,
  });

  const res = runHook(input);
  assert.equal(res.status, 0);
  assert.ok(fs.existsSync(evil), "the external file is left in place");
  assert.equal(fs.existsSync(evil + ".consumed"), false, "the hook did not rename an external file to .consumed");
  const payload = res.stdout ? JSON.parse(res.stdout) : null;
  assert.match(
    payload?.hookSpecificOutput?.additionalContext ?? "",
    /could not be read/,
    "context is not silently lost: the missing-delta notice is surfaced"
  );

  fs.rmSync(project, { recursive: true });
  fs.rmSync(outside, { recursive: true });
});

test("a Claude SessionStart hook refuses to relink a session that was unlinked, but links a new one", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-tombstone-")));
  const transcript = path.join(project, "claude.jsonl");
  fs.writeFileSync(transcript, "{}");

  const state = defaultState(project);
  // claude was unlinked: an empty slot carrying only the tombstone for its old session.
  state.agents.claude = { id: null, transcriptPath: null, mark: null, idle: false, rejectedSessions: ["old-session"] };
  saveState(project, state);

  const fire = (session_id, source) =>
    spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start"], {
      input: JSON.stringify({ cwd: project, source, session_id, transcript_path: transcript }),
      env: { ...cleanEnv(), CLAUDECODE: "1" },
      encoding: "utf8",
    });

  fire("old-session", "resume");
  assert.equal(loadState(project).agents.claude.id, null, "the unlinked session was NOT relinked by its stale hook");
  assert.deepEqual(loadState(project).agents.claude.rejectedSessions, ["old-session"], "the tombstone is still in place");

  fire("new-session", "startup");
  const after = loadState(project);
  assert.equal(after.agents.claude.id, "new-session", "a genuinely new session links normally");
  // The new session is a different id, so the old one STAYS rejected: a later stale
  // hook from old-session must still be turned away, not welcomed back by a fresh link.
  assert.deepEqual(after.agents.claude.rejectedSessions, ["old-session"], "the old session stays rejected after a new one links");

  fs.rmSync(project, { recursive: true });
});

test("a stale Codex hook for an unlinked session neither stamps hookSeen nor consumes a pending delta", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-codextomb-")));
  const checkpoints = path.join(project, ".bridge", "checkpoints");
  fs.mkdirSync(checkpoints, { recursive: true });
  const deltaName = "2026-08-04T00-00-00-000Z-codex-to-claude.md";
  fs.writeFileSync(path.join(checkpoints, deltaName), "[Bridge] context for the NEW codex session");

  const state = defaultState(project);
  // codex was unlinked: an empty slot with a tombstone for its old session.
  state.agents.codex = { id: null, transcriptPath: null, mark: null, idle: false, rejectedSessions: ["old-codex"] };
  // A hook delivery is pending for codex (bound to a NEW session, delivered by hook).
  state.pendingInjection = { agent: "codex", via: "hook", id: "new-codex", deltaFile: path.join(".bridge", "checkpoints", deltaName), createdAt: "2026-01-01T00:00:00.000Z", sources: {} };
  saveState(project, state);

  const transcript = path.join(project, "codex.jsonl");
  fs.writeFileSync(transcript, "{}");
  const fireCodex = (session_id) =>
    spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start", "--agent", "codex"], {
      input: JSON.stringify({ cwd: project, session_id, transcript_path: transcript }),
      env: cleanEnv(),
      encoding: "utf8",
    });

  // The stale unlinked session's hook fires: it must be a complete no-op.
  fireCodex("old-codex");
  const after = loadState(project);
  assert.equal(after.agents.codex.id, null, "the stale session is not relinked");
  assert.equal(after.agents.codex.hookSeen ?? null, null, "and it does not stamp hookSeen, so the empty slot is not made hook-eligible");
  assert.ok(after.pendingInjection, "the pending delta is NOT consumed by the stale session");
  assert.ok(fs.existsSync(path.join(checkpoints, deltaName)), "the delta file survives, not renamed to .consumed");

  fs.rmSync(project, { recursive: true });
});
