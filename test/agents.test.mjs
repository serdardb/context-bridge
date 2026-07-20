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
