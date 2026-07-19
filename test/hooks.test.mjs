import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultState, saveState } from "../src/state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_BIN = path.join(ROOT, "bin", "bridge.mjs");

test("Claude SessionStart hook injects pending delta exactly once", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hook-"));
  const checkpointDir = path.join(project, ".bridge", "checkpoints");
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(path.join(checkpointDir, "delta.md"), "[Bridge Context Update]\nCodex changed files.\n");

  const state = defaultState(project);
  state.agents.claude.sessionId = "claude-session-1";
  state.agents.claude.transcriptPath = path.join(project, "claude.jsonl");
  state.pendingInjection = {
    agent: "claude",
    sessionId: "claude-session-1",
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
    encoding: "utf8",
  });
}
