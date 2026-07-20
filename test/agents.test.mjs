import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTERS, adapterFor, AGENT_IDS } from "../src/agents/index.mjs";

const SESSION_ID = "019f7f63-c118-7ee1-92dc-4607d08f345d";

test("every adapter implements the contract", () => {
  assert.deepEqual(AGENT_IDS, ["claude", "codex", "grok"]);
  for (const [name, a] of Object.entries(ADAPTERS)) {
    assert.equal(a.id, name);
    assert.ok(a.displayName, `${name} needs a display name`);
    assert.ok(["prompt", "hook"].includes(a.injection), `${name} injection mode`);
    for (const fn of ["discover", "resumeCommand", "activitySince", "idleAfter", "currentMark"]) {
      assert.equal(typeof a[fn], "function", `${name}.${fn} must exist`);
    }
    assert.ok(Array.isArray(a.conflictFlags), `${name} needs conflict flags`);
  }
  assert.equal(adapterFor("nope"), null);
});

test("grok discovery is deterministic: percent-encoded cwd plus summary.json", async () => {
  const { project } = await withGrokFixture();
  const grok = adapterFor("grok");
  const ref = grok.discover(project);
  assert.equal(ref.id, SESSION_ID);
  assert.match(ref.transcriptPath, /chat_history\.jsonl$/);
  assert.match(ref.eventsPath, /events\.jsonl$/);
  assert.equal(grok.projectDirKey(project), encodeURIComponent(project));
});

test("a grok session recorded for another cwd is never adopted", async () => {
  const { project, sessionDir } = await withGrokFixture();
  const summaryPath = path.join(sessionDir, "summary.json");
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  summary.info.cwd = "/somewhere/else";
  fs.writeFileSync(summaryPath, JSON.stringify(summary));
  assert.equal(adapterFor("grok").discover(project), null);
});

test("grok marks by row count because its chat rows have no timestamps", async () => {
  const { project } = await withGrokFixture();
  const grok = adapterFor("grok");
  const ref = grok.discover(project);

  assert.deepEqual(grok.currentMark(ref), { rows: 12, ts: "2026-07-20T11:58:13.932Z" });

  const all = grok.activitySince(ref, 0).messages;
  assert.deepEqual(
    all.map((m) => `${m.role}:${m.text}`),
    [
      "user:Reply with exactly: bridge-smoke-ok",
      "assistant:bridge-smoke-ok",
      "user:Reply with exactly: bridge-resume-ok",
      "assistant:bridge-resume-ok",
    ],
    "user_query wrappers are stripped and harness noise is dropped"
  );

  assert.equal(grok.activitySince(ref, 7).messages.length, 2, "mid-session mark returns only new rows");
  assert.equal(grok.activitySince(ref, grok.currentMark(ref)).messages.length, 0, "a fresh mark returns nothing");
});

test("grok events are marked by instant, so turns and files are not recounted", async () => {
  const { project } = await withGrokFixture();
  const grok = adapterFor("grok");
  const ref = grok.discover(project);

  // The two streams need different marks: rows for the chat, ts for the events.
  assert.equal(grok.activitySince(ref, 0).turnsCompleted, 2, "unmarked reads the whole session");
  const midway = { rows: 7, ts: "2026-07-20T11:57:55.025Z" };
  assert.equal(grok.activitySince(ref, midway).turnsCompleted, 1, "only turns after the mark count");

  const fresh = grok.activitySince(ref, grok.currentMark(ref));
  assert.equal(fresh.turnsCompleted, 0);
  assert.deepEqual(fresh.patchedFiles, [], "a fresh mark must not replay earlier file work");
});

test("grok idleness comes from turn_ended, not from guessing at message order", async () => {
  const { project } = await withGrokFixture();
  const grok = adapterFor("grok");
  const ref = grok.discover(project);
  assert.equal(grok.idleAfter(ref, "2026-07-20T11:57:00.000Z"), true);
  assert.equal(grok.idleAfter(ref, "2026-07-20T23:59:00.000Z"), false);
});

test("grok resume uses the session id and shields the delta behind --", async () => {
  const { project } = await withGrokFixture();
  const grok = adapterFor("grok");
  const ref = grok.discover(project);
  assert.deepEqual(grok.resumeCommand(ref, ["--permission-mode", "auto"]), {
    cmd: "grok",
    args: ["--resume", SESSION_ID, "--permission-mode", "auto"],
  });
  assert.deepEqual(grok.promptArgs("[Bridge Context Update]"), ["--", "[Bridge Context Update]"]);
});

/**
 * Builds a Grok home mirroring the real on-disk layout, then reloads the adapter so
 * it picks up GROK_HOME. Shapes copied from a real session written by Grok 0.2.106.
 */
async function withGrokFixture() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-grok-proj-")));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-grok-home-")));
  const sessionDir = path.join(home, "sessions", encodeURIComponent(project), SESSION_ID);
  fs.mkdirSync(sessionDir, { recursive: true });

  fs.writeFileSync(
    path.join(sessionDir, "summary.json"),
    JSON.stringify({
      info: { id: SESSION_ID, cwd: project },
      created_at: "2026-07-20T11:57:50.000000Z",
      updated_at: "2026-07-20T11:58:13.934137Z",
      num_chat_messages: 12,
      current_model_id: "grok-4.5",
    })
  );

  const wrap = (text) => [{ type: "text", text }];
  const rows = [
    { type: "system", content: "You are Grok 4.5 released by xAI." },
    { type: "user", content: wrap("<user_info>\nOS Version: macos\n</user_info>") },
    { type: "user", content: wrap("<system-reminder>\nskills\n</system-reminder>"), synthetic_reason: "skills" },
    { type: "user", content: wrap("<system-reminder>\nmcp\n</system-reminder>"), synthetic_reason: "mcp" },
    { type: "user", content: wrap("<user_query>\nReply with exactly: bridge-smoke-ok\n</user_query>"), prompt_index: 0 },
    { type: "reasoning", content: null, status: "completed" },
    { type: "assistant", content: "bridge-smoke-ok" },
    { type: "user", content: wrap("<system-reminder>\nnoise\n</system-reminder>") },
    { type: "user", content: wrap("<user_query>\nReply with exactly: bridge-resume-ok\n</user_query>"), prompt_index: 1 },
    { type: "user", content: wrap("<system-reminder>\nnoise\n</system-reminder>") },
    { type: "reasoning", content: null, status: "completed" },
    { type: "assistant", content: "bridge-resume-ok" },
  ];
  writeJsonl(path.join(sessionDir, "chat_history.jsonl"), rows);

  writeJsonl(path.join(sessionDir, "events.jsonl"), [
    { ts: "2026-07-20T11:57:53.311Z", type: "turn_started", turn_number: 0, conversation_message_count: 3 },
    { ts: "2026-07-20T11:57:55.025Z", type: "turn_ended", outcome: "completed" },
    { ts: "2026-07-20T11:58:10.878Z", type: "turn_started", turn_number: 1, conversation_message_count: 7 },
    { ts: "2026-07-20T11:58:13.932Z", type: "turn_ended", outcome: "completed" },
  ]);

  process.env.GROK_HOME = home;
  return { project, home, sessionDir };
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("the launcher builds commands through adapters, including for grok", async () => {
  const { project } = await withGrokFixture();
  const { buildCommand } = await import("../src/launcher.mjs");
  const { defaultState } = await import("../src/state.mjs");
  const grok = adapterFor("grok");
  const ref = grok.discover(project);

  const s = defaultState(project);
  // A brand new agent slot: no legacy field names, written by the uniform accessor.
  s.agents.grok = { id: ref.id, transcriptPath: ref.transcriptPath, mark: null, idle: false };

  const built = buildCommand(project, s, "grok", ["--permission-mode", "auto"]);
  assert.equal(built.cmd, "grok");
  assert.deepEqual(built.args, ["--resume", SESSION_ID, "--permission-mode", "auto"]);
  assert.match(built.note, /Resuming your Grok session/);
});

test("an unlinked prompt-injecting agent refuses to start, a hook-injecting one starts fresh", async () => {
  const { buildCommand } = await import("../src/launcher.mjs");
  const { defaultState } = await import("../src/state.mjs");
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-unlinked-")));
  const s = defaultState(project);

  const grok = buildCommand(project, s, "grok");
  assert.equal(grok.cmd, null, "no session to resume and no official import path");
  assert.match(grok.note, /No linked Grok session yet/);

  const claude = buildCommand(project, s, "claude");
  assert.equal(claude.cmd, "claude");
  assert.deepEqual(claude.args, [], "a fresh Claude session needs no resume flag");
});

test("a v1 state file is migrated in place, with a backup kept", async () => {
  const { loadState, statePath } = await import("../src/state.mjs");
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-v1-")));
  fs.mkdirSync(path.join(project, ".bridge"), { recursive: true });
  const v1 = {
    version: 1,
    project,
    activeAgent: "claude",
    agents: {
      claude: { sessionId: "claude-1", transcriptPath: "/tmp/claude.jsonl", lastSyncAt: "2026-07-20T00:00:00Z", idle: true },
      codex: { threadId: "codex-1", rolloutPath: "/tmp/rollout.jsonl", lastSyncAt: null, idle: false },
    },
    pendingHandoff: null,
    pendingInjection: { agent: "claude", sessionId: null, deltaFile: ".bridge/checkpoints/d.md", createdAt: "2026-07-20T00:00:00Z" },
    git: { sha: null, recordedAt: null },
    updatedAt: null,
  };
  fs.writeFileSync(statePath(project), JSON.stringify(v1));

  const s = loadState(project);
  assert.equal(s.version, 3);
  // v3 swaps the pair's marks: each agent now marks its OWN stream, and v1 stored
  // claude's mark as a position in codex's stream.
  assert.deepEqual(s.agents.claude, {
    id: "claude-1",
    transcriptPath: "/tmp/claude.jsonl",
    mark: null,
    idle: true,
  });
  assert.equal(s.agents.codex.mark, "2026-07-20T00:00:00Z");
  assert.equal(s.agents.codex.id, "codex-1");
  assert.equal(s.agents.codex.transcriptPath, "/tmp/rollout.jsonl");
  assert.ok(s.agents.grok, "a new agent slot appears without any migration of its own");
  // A null id means "seed the next new session"; that must survive as null, not vanish.
  assert.equal(s.pendingInjection.id, null);
  assert.equal(s.pendingInjection.deltaFile, ".bridge/checkpoints/d.md");

  assert.ok(fs.existsSync(statePath(project) + ".v1.backup"), "the original file is kept");
  assert.equal(JSON.parse(fs.readFileSync(statePath(project), "utf8")).version, 3, "migration is written back");
  assert.equal(loadState(project).version, 3, "second load is a no-op");
});

test("a state file from a newer bridge is refused, not guessed at", async () => {
  const { loadState, statePath } = await import("../src/state.mjs");
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-v9-")));
  fs.mkdirSync(path.join(project, ".bridge"), { recursive: true });
  fs.writeFileSync(statePath(project), JSON.stringify({ version: 99, agents: {} }));
  assert.throws(() => loadState(project), /newer than this bridge understands/);
});


test("the official first import marks the new thread, so the return does not replay it", async () => {
  // Regression: a v3 mark means "my own stream is shared up to here". The import
  // writes the whole Claude conversation into the fresh Codex thread, so leaving
  // that thread unmarked made the first Codex→Claude delta echo it all back.
  const { handoff } = await import("../src/handoff.mjs");
  const { loadState } = await import("../src/state.mjs");

  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-import-")));
  const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-import-home-")));
  const threadId = "0198dddd-eeee-7fff-8aaa-bbbbcccc0001";
  const day = path.join(codexHome, "sessions", "2026", "07", "20");
  fs.mkdirSync(day, { recursive: true });
  // What the official transfer produces: the imported conversation, already in
  // the new thread before the bridge has recorded anything.
  writeJsonl(path.join(day, `rollout-2026-07-20T10-00-00-${threadId}.jsonl`), [
    { timestamp: "2026-07-20T10:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: project } },
    { timestamp: "2026-07-20T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "imported history" } },
    { timestamp: "2026-07-20T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "imported reply" } },
  ]);

  const claudeTranscript = path.join(project, "claude.jsonl");
  fs.writeFileSync(claudeTranscript, "");
  process.env.CODEX_HOME = codexHome;

  const state = (await import("../src/state.mjs")).defaultState(project);
  state.agents.claude = { id: "claude-1", transcriptPath: claudeTranscript, mark: null, idle: false };
  (await import("../src/state.mjs")).saveState(project, state);

  // The real transfer shells out to the OpenAI plugin; only its result matters here.
  handoff(project, "codex", {
    from: "claude",
    decisions: "d",
    transfer: () => ({ threadId }),
    checkTarget: () => {}, // the fixture CODEX_HOME has no credentials, and auth is not what this test is about
  });

  const s = loadState(project);
  assert.equal(s.agents.codex.id, threadId);
  assert.ok(s.agents.codex.mark, "the imported thread must be marked as already shared");
});
