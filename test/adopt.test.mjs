import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultState, saveState, loadState, STATE_VERSION } from "../src/state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_BIN = path.join(ROOT, "bin", "bridge.mjs");
const THREAD_ID = "0198aaaa-bbbb-7ccc-8ddd-eeeeffff0001";

test("handoff claude auto-adopts the running Codex session via CODEX_THREAD_ID", () => {
  const { project, codexHome, rolloutPath } = makeCodexFixture();

  const res = runBridge(["handoff", "claude", "--decisions", "d", "--next", "n"], project, {
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: THREAD_ID,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Adopted this Codex session/);
  assert.match(res.stdout, /start a fresh Claude/);
  assert.doesNotMatch(res.stderr, /fatal:/, "git probes in a non-repo must not leak stderr");
  assert.match(res.stdout, /not running under the bridge launcher/);
  assert.doesNotMatch(res.stdout, /launcher will close/, "must not promise an automatic switch without a launcher");

  const s = loadState(project);
  assert.equal(s.agents.codex.id, THREAD_ID);
  assert.equal(s.agents.codex.transcriptPath, rolloutPath);
  assert.equal(s.pendingInjection.agent, "claude");
  assert.equal(s.pendingInjection.id, null);
  assert.equal(s.pendingHandoff.target, "claude");

  const delta = fs.readFileSync(path.join(project, s.pendingInjection.deltaFile), "utf8");
  assert.match(delta, /fix the bug/);
  assert.ok(delta.includes(rolloutPath), "delta should reference the full adopted rollout");
});

test("handoff claude falls back to cwd-matched discovery and requires --adopt", () => {
  const { project, codexHome } = makeCodexFixture();

  const denied = runBridge(["handoff", "claude"], project, { CODEX_HOME: codexHome });
  assert.equal(denied.status, 2, "adopt-confirmation-needed is a structured exit code 2");
  assert.match(denied.stderr, /--adopt/);
  assert.doesNotMatch(denied.stderr, /at handoffClaude/, "expected errors print without a stack trace");
  assert.equal(loadState(project).agents.codex.id, null);

  const adopted = runBridge(["handoff", "claude", "--adopt"], project, { CODEX_HOME: codexHome });
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(loadState(project).agents.codex.id, THREAD_ID);
});

test("handoff claude env-adopt without a rollout warns loudly but still transfers decisions", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-norollout-")));
  const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-codexhome-")));

  const res = runBridge(
    ["handoff", "claude", "--decisions", "ship it", "--next", "review"],
    project,
    { CODEX_HOME: codexHome, CODEX_THREAD_ID: THREAD_ID }
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /transcript file was not found/);

  const s = loadState(project);
  assert.equal(s.agents.codex.id, THREAD_ID);
  const delta = fs.readFileSync(path.join(project, s.pendingInjection.deltaFile), "utf8");
  assert.match(delta, /\[Bridge warning\]/);
  assert.match(delta, /ship it/);
});

test("a rollout belonging to a different project directory is never adopted", () => {
  const { project, codexHome } = makeCodexFixture();
  const otherProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-other-")));

  const res = runBridge(["handoff", "claude", "--adopt"], otherProject, { CODEX_HOME: codexHome });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no linked or discoverable .*codex.*session/, "the message names the agents it looked for");
  assert.ok(project); // fixture rollout exists but points at the other cwd
});

test("discovery falls back to the filename uuid when session_meta lacks an id", () => {
  const { project, codexHome, rolloutPath } = makeCodexFixture();
  const records = fs.readFileSync(rolloutPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  delete records[0].payload.id;
  fs.writeFileSync(rolloutPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const res = runBridge(["handoff", "claude", "--adopt"], project, { CODEX_HOME: codexHome });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(loadState(project).agents.codex.id, THREAD_ID);
});

test("an old launcher marker avoids promising an automatic switch", () => {
  const { project, codexHome } = makeCodexFixture();
  const res = runBridge(["handoff", "claude"], project, {
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: THREAD_ID,
    CONTEXT_BRIDGE_LAUNCHER: "1",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /predates this check/, "no marker means a launcher from before this protocol");
  assert.match(res.stdout, /If the switch stalls/);
  assert.doesNotMatch(res.stdout, /will close Codex and .* automatically/);
  assert.doesNotMatch(res.stdout, /not running under the bridge launcher/);
});

test("a current launcher marker suppresses the stale-launcher warning", () => {
  const { project, codexHome } = makeCodexFixture();
  const s = defaultState(project);
  s.launcher = { stateVersion: STATE_VERSION, pid: process.pid, recordedAt: "2026-07-20T00:00:00.000Z" };
  saveState(project, s);

  const res = runBridge(["handoff", "claude"], project, {
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: THREAD_ID,
    CONTEXT_BRIDGE_LAUNCHER: "1",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /older bridge launcher/);
  assert.match(res.stdout, /launcher will close Codex/);
});

test("a current marker left by a launcher that has exited still warns", () => {
  // Grok caught this: matching the state version proves the marker was written by
  // a compatible launcher, not that anything is still watching. A dead launcher
  // with a current marker was being promised an automatic switch.
  const { project, codexHome } = makeCodexFixture();
  const s = defaultState(project);
  s.launcher = { stateVersion: STATE_VERSION, pid: 999999, recordedAt: "2026-07-20T00:00:00.000Z" };
  saveState(project, s);

  const res = runBridge(["handoff", "claude"], project, {
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: THREAD_ID,
    CONTEXT_BRIDGE_LAUNCHER: "1",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /launcher that has since exited/);
  assert.doesNotMatch(res.stdout, /will close Codex and .* automatically/);
});

test("the warning says which side is behind, and whether that launcher still exists", () => {
  const { project, codexHome } = makeCodexFixture();
  const s = defaultState(project);
  // A launcher that understands a NEWER state file than this bridge writes: it is
  // this bridge that is behind, and saying "older launcher" would be backwards.
  s.launcher = { stateVersion: STATE_VERSION + 1, pid: 999999, recordedAt: "2026-07-20T00:00:00.000Z" };
  saveState(project, s);

  const res = runBridge(["handoff", "claude"], project, {
    CODEX_HOME: codexHome,
    CODEX_THREAD_ID: THREAD_ID,
    CONTEXT_BRIDGE_LAUNCHER: "1",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /newer bridge launcher/);
  assert.doesNotMatch(res.stdout, /older bridge launcher/);
  // The marker's process is long gone, so the marker describes nobody.
  assert.match(res.stdout, /no longer running/);
});

test("handoff claude without any Codex session fails with guidance", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-adopt-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-codexhome-"));
  const res = runBridge(["handoff", "claude"], project, { CODEX_HOME: codexHome });
  assert.notEqual(res.status, 0);
  // With three agents the bridge cannot assume Codex; it says what it looked for.
  assert.match(res.stderr, /no linked or discoverable .*codex.*session/, "the message names the agents it looked for");
});

test("SessionStart hook delivers a sessionId=null delta to the first new Claude session", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-firstinj-"));
  const checkpointDir = path.join(project, ".bridge", "checkpoints");
  fs.mkdirSync(checkpointDir, { recursive: true });
  fs.writeFileSync(path.join(checkpointDir, "delta.md"), "[Bridge Context Update]\nCodex-first seed.\n");

  const state = defaultState(project);
  state.pendingInjection = {
    agent: "claude",
    id: null,
    deltaFile: path.join(".bridge", "checkpoints", "delta.md"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  saveState(project, state);

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start"], {
    input: JSON.stringify({
      cwd: project,
      source: "startup",
      session_id: "brand-new-session",
      transcript_path: path.join(project, "claude.jsonl"),
    }),
    env: hookEnv(),
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  const payload = JSON.parse(res.stdout);
  assert.match(payload.hookSpecificOutput.additionalContext, /Codex-first seed/);

  // The delta is delivered to whichever session starts here, but the link is not
  // claimed yet: Claude names its transcript at SessionStart and only writes it
  // at the first message. A session abandoned before that would otherwise leave
  // the project pointing at a file that never existed.
  const s = loadState(project);
  assert.equal(s.agents.claude.id, null, "nothing to link to until the transcript exists");
  assert.equal(s.agents.claude.pendingId, "brand-new-session", "the id is remembered, not thrown away");
  assert.equal(s.pendingInjection, null);
  assert.ok(fs.existsSync(path.join(checkpointDir, "delta.md.consumed")));

  // The user speaks, Claude writes the transcript, and the candidate is promoted.
  fs.writeFileSync(path.join(project, "claude.jsonl"), "");
  const after = spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "user-prompt-submit"], {
    input: JSON.stringify({
      cwd: project,
      session_id: "brand-new-session",
      transcript_path: path.join(project, "claude.jsonl"),
    }),
    env: hookEnv(),
    encoding: "utf8",
  });
  assert.equal(after.status, 0);
  assert.equal(loadState(project).agents.claude.id, "brand-new-session");
});

test("a Claude session that never writes a transcript never becomes the project's link", () => {
  // The fresh-install failure, exactly: the agent opened, nobody typed, the
  // window closed. State used to keep the id and a path that was never created,
  // and the next handoff died on it with a stack trace.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-empty-"));
  saveState(project, defaultState(project));

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start"], {
    input: JSON.stringify({
      cwd: project,
      source: "startup",
      session_id: "abandoned-session",
      transcript_path: path.join(project, "never-written.jsonl"),
    }),
    env: hookEnv(),
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  const s = loadState(project);
  assert.equal(s.agents.claude.id, null, "an empty session must not become the link");
  assert.equal(s.agents.claude.transcriptPath, null);
});

function makeCodexFixture() {
  // realpath: on macOS os.tmpdir() is a symlink (/var → /private/var), but the
  // child process's cwd resolves to the physical path — session_meta.cwd must match it.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-adopt-")));
  const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-codexhome-")));
  const day = path.join(codexHome, "sessions", "2026", "07", "20");
  fs.mkdirSync(day, { recursive: true });
  const rolloutPath = path.join(day, `rollout-2026-07-20T10-00-00-${THREAD_ID}.jsonl`);
  fs.writeFileSync(
    rolloutPath,
    [
      { timestamp: "2026-07-20T10:00:00.000Z", type: "session_meta", payload: { id: THREAD_ID, cwd: project } },
      { timestamp: "2026-07-20T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "fix the bug" } },
      { timestamp: "2026-07-20T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "patched app.js" } },
      { timestamp: "2026-07-20T10:00:03.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "patched app.js" } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
  );
  return { project, codexHome, rolloutPath };
}

function runBridge(args, cwd, envOverrides) {
  const env = { ...process.env, ...envOverrides };
  if (!("CODEX_THREAD_ID" in envOverrides)) delete env.CODEX_THREAD_ID;
  if (!("CONTEXT_BRIDGE_LAUNCHER" in envOverrides)) delete env.CONTEXT_BRIDGE_LAUNCHER;
  return spawnSync(process.execPath, [BRIDGE_BIN, ...args], { cwd, encoding: "utf8", env });
}

/**
 * A hook environment that belongs to the test rather than to the machine it runs
 * on. Every agent marker is stripped and Claude's is set back, because otherwise
 * these tests quietly measure whichever agent the developer happens to be inside.
 */
function hookEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|GROK_|CODEX_)/.test(key)) delete env[key];
  }
  env.CLAUDECODE = "1";
  return env;
}
