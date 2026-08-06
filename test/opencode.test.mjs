import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  injectionSql,
  preResume,
  fabricateSession,
  selectDiscovered,
  bridgeTouchedSessionIds,
  parseExportMessages,
  parseAudit,
} from "../src/agents/opencode.mjs";
import { buildCommand } from "../src/launcher.mjs";
import { defaultState, saveState, checkpointsDir, writeCheckpoint } from "../src/state.mjs";

// OpenCode stores its sessions in SQLite, so the bridge injects a delta by
// writing a message and its text part directly into that database — authless,
// because the alternative, `opencode run`, is a paid model call that stalled a
// live switch on auth. Writing into a real app's store is where this has to be
// most careful, so the SQL is a pure, tested function.

// Minimal real-shaped schema. `session` and `project` carry only the columns the
// bridge writes or reads (the live table has many more, all defaulted); the point
// is that a fabricated session INSERT is accepted and its project_id subquery
// resolves. cost/tokens keep their live DEFAULTs so fabricateSession can omit them.
const SCHEMA =
  "CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL);" +
  "CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);" +
  "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer, time_updated integer, data text NOT NULL);" +
  "CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer, time_updated integer, data text NOT NULL);";

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-db-"));
  const db = path.join(dir, "opencode.db");
  execFileSync("sqlite3", [db, SCHEMA]);
  return { dir, db };
}

test("the injection writes one message and its text part, together", () => {
  const { dir, db } = freshDb();
  try {
    execFileSync("sqlite3", [db, injectionSql("ses_a", "the delta", 1000)]);
    assert.equal(execFileSync("sqlite3", [db, "SELECT count(*) FROM message;"]).toString().trim(), "1");
    assert.equal(execFileSync("sqlite3", [db, "SELECT count(*) FROM part;"]).toString().trim(), "1");
    // The part points at the message it belongs to, or the TUI renders an orphan.
    const linked = execFileSync("sqlite3", [db, "SELECT p.message_id = m.id FROM part p, message m;"]).toString().trim();
    assert.equal(linked, "1", "the part must reference its message");
    const data = execFileSync("sqlite3", [db, "SELECT data FROM part;"]).toString();
    assert.ok(data.includes("the delta"), "the delta text is in the part's data");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("injecting the same delta twice is a no-op, not a duplicate", () => {
  // The launcher can recompute the command before delivery is committed, so the
  // write has to be idempotent or the session fills with repeated context. The
  // id is derived from the delta's content and the inserts are OR IGNORE.
  const { dir, db } = freshDb();
  try {
    const sql = injectionSql("ses_a", "same delta", 1000);
    execFileSync("sqlite3", [db, sql]);
    execFileSync("sqlite3", [db, sql]);
    execFileSync("sqlite3", [db, sql]);
    assert.equal(execFileSync("sqlite3", [db, "SELECT count(*) FROM message;"]).toString().trim(), "1");
    // A different delta is a different message, not ignored.
    execFileSync("sqlite3", [db, injectionSql("ses_a", "a different delta", 2000)]);
    assert.equal(execFileSync("sqlite3", [db, "SELECT count(*) FROM message;"]).toString().trim(), "2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the two inserts are one transaction, so a failure leaves no orphan message", () => {
  const sql = injectionSql("ses_a", "x", 1000);
  assert.match(sql, /^BEGIN;/, "opens a transaction");
  assert.match(sql, /COMMIT;$/, "closes it");
  // If the part insert fails, the message insert must roll back with it. Force a
  // failure by dropping the part table, and assert the message did not land.
  const { dir, db } = freshDb();
  try {
    execFileSync("sqlite3", [db, "DROP TABLE part;"]);
    assert.throws(() => execFileSync("sqlite3", [db, sql], { stdio: "ignore" }));
    assert.equal(execFileSync("sqlite3", [db, "SELECT count(*) FROM message;"]).toString().trim(), "0", "no orphan");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a delta full of quotes and SQL is stored verbatim, not executed", () => {
  const { dir, db } = freshDb();
  try {
    const nasty = "it's a trap'); DROP TABLE message;-- and more '' quotes";
    execFileSync("sqlite3", [db, injectionSql("ses_a", nasty, 1000)]);
    assert.equal(execFileSync("sqlite3", [db, "SELECT count(*) FROM message;"]).toString().trim(), "1", "table survives");
    const data = execFileSync("sqlite3", [db, "SELECT data FROM part;"]).toString();
    assert.ok(data.includes("DROP TABLE message"), "the text is stored as data, harmlessly");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preResume returns a runnable write when the store exists, and nothing when it does not", () => {
  const prev = process.env.OPENCODE_HOME;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oc-home-none-"));
  try {
    process.env.OPENCODE_HOME = empty;
    assert.equal(preResume({ id: "ses_a" }, "delta"), null, "no db, nothing to run, delta stays pending");

    const { dir, db } = freshDb();
    process.env.OPENCODE_HOME = path.dirname(db);
    const pre = preResume({ id: "ses_a" }, "delta");
    assert.equal(pre.cmd, "sqlite3", "the launcher runs the write, so the write is not a side effect of building it");
    assert.equal(pre.args[0], db);
    assert.match(pre.args[1], /INSERT OR IGNORE INTO message/);
    assert.equal(preResume({ id: null }, "delta"), null);
    assert.equal(preResume({ id: "ses_a" }, ""), null, "no delta, nothing to inject");
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prev;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("the export parser keeps user and assistant text and drops everything else", () => {
  const raw = JSON.stringify({
    messages: [
      { info: { role: "user", time: { created: 1000 } }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "assistant", time: { created: 2000 } }, parts: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "hi back" }] },
      { info: { role: "assistant", time: { created: 3000 } }, parts: [{ type: "tool", tool: "bash" }] },
      { info: { role: "system", time: { created: 4000 } }, parts: [{ type: "text", text: "ignore me" }] },
    ],
  });
  const msgs = parseExportMessages(raw);
  assert.deepEqual(
    msgs.map((m) => `${m.role}:${m.text}`),
    ["user:hello", "assistant:hi back"],
    "reasoning and tool parts and system messages are not conversation"
  );
  assert.equal(msgs[0].at, new Date(1000).toISOString(), "timestamps come through as ISO");
  assert.deepEqual(parseExportMessages("not json at all"), [], "garbage in, empty out, no throw");
});

test("the audit parser pulls commands, reads and changes from tool parts, honouring the mark", () => {
  const raw = JSON.stringify({
    messages: [
      {
        info: { role: "assistant", time: { created: 1000 } },
        parts: [
          { type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" }, metadata: { exit: 0 }, time: { start: 1000, end: 1200 } } },
          { type: "tool", tool: "read", state: { input: { filePath: "/a.js" } } },
        ],
      },
      {
        info: { role: "assistant", time: { created: 5000 } },
        parts: [{ type: "tool", tool: "edit", state: { input: { filePath: "/b.js" } } }],
      },
    ],
  });
  const before = parseAudit(raw, null);
  assert.equal(before.commands.length, 1);
  assert.equal(before.commands[0].args, "npm test");
  assert.equal(before.commands[0].ok, true);
  assert.equal(before.commands[0].exitCode, 0);
  assert.equal(before.commands[0].durationMs, 200);
  assert.deepEqual(before.filesRead, ["/a.js"]);
  assert.deepEqual(before.filesChanged, ["/b.js"]);

  // A mark after the first message drops its commands and reads, keeps the later edit.
  const after = parseAudit(raw, new Date(3000).toISOString());
  assert.equal(after.commands.length, 0);
  assert.deepEqual(after.filesRead, []);
  assert.deepEqual(after.filesChanged, ["/b.js"]);
});

// The delivery model, at the branch level. OpenCode is the case the launcher's
// "delivered = new activity after start" rule does not fit: its context is a
// message pre-inserted before the session opens, which produces no after-start
// activity. So buildCommand routes it through preResume and never claims the
// delta is carried on a path that would let it be marked delivered without being.
function linkedOpencode(dbPresent) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-build-")));
  fs.mkdirSync(checkpointsDir(project), { recursive: true });
  const rel = writeCheckpoint(project, "main", "x-claude-to-opencode.md", "[Bridge Context Update]\nSummary\n\nthe reading\n");
  const s = defaultState(project);
  s.agents.opencode = { id: "ses_live", transcriptPath: null, mark: null, idle: false };
  s.pendingInjection = { agent: "opencode", id: "ses_live", via: "prompt", deltaFile: rel, createdAt: "2026-01-01T00:00:00.000Z" };
  saveState(project, s);
  let home;
  if (dbPresent) {
    const { dir, db } = freshDb();
    home = { dir, path: path.dirname(db) };
  }
  return { project, s, home };
}

test("a resume with the store present routes delivery through preResume", () => {
  const prev = process.env.OPENCODE_HOME;
  const { project, s, home } = linkedOpencode(true);
  try {
    process.env.OPENCODE_HOME = home.path;
    const built = buildCommand(project, s, "opencode", []);
    assert.ok(built.preResume, "the delta is delivered by injection, not by the command line");
    assert.equal(built.preResume.cmd, "sqlite3");
    assert.ok(built.carries, "and it is carried, so the launcher commits it once the injection succeeds");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prev;
    fs.rmSync(home.dir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("resuming a linked OpenCode session opens the plain TUI, not a run turn", () => {
  // OpenCode has no clean auto-start (see the note in the adapter): its TUI
  // cannot submit an opening message, so delivery is the injection and the
  // person opens the turn. This pins that the resume command stays the plain
  // `opencode --session <id>` and never became an `opencode run` turn.
  const prev = process.env.OPENCODE_HOME;
  const { project, s, home } = linkedOpencode(true);
  try {
    process.env.OPENCODE_HOME = home.path;
    const built = buildCommand(project, s, "opencode", []);
    assert.ok(built.preResume, "delivery is the injection");
    assert.equal(built.cmd, "opencode");
    assert.deepEqual(built.args, ["--session", "ses_live"], "plain resume, no run subcommand and no opening message");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prev;
    fs.rmSync(home.dir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a resume with no store leaves the delta pending rather than falsely delivered", () => {
  const prev = process.env.OPENCODE_HOME;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oc-home-none-"));
  const { project, s } = linkedOpencode(false);
  try {
    process.env.OPENCODE_HOME = empty;
    const built = buildCommand(project, s, "opencode", []);
    assert.equal(built.preResume, undefined, "injection could not be built");
    assert.equal(built.carries, undefined, "so nothing is carried; the delta stays pending and retries next launch");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prev;
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

function firstSwitchProject() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-first-")));
  fs.mkdirSync(checkpointsDir(project), { recursive: true });
  const rel = writeCheckpoint(project, "main", "x-claude-to-opencode.md", "[Bridge Context Update]\nSummary\n\nfirst\n");
  const s = defaultState(project);
  s.agents.opencode = { id: null, transcriptPath: null, mark: null, idle: false };
  s.pendingInjection = { agent: "opencode", id: null, via: "prompt", deltaFile: rel, createdAt: "2026-01-01T00:00:00.000Z" };
  saveState(project, s);
  return { project, s };
}

test("a first switch WITH a store fabricates a session and delivers on the spot", () => {
  // OpenCode's message table has a foreign key to session, so a first handoff has
  // nowhere to land until a session exists. With a store present, buildCommand now
  // fabricates that session, injects the delta into it, resumes it by id, and
  // carries the delta so the launcher commits once the write succeeds. This is the
  // fix for the reported bug: the FIRST switch no longer arrives empty.
  const prev = process.env.OPENCODE_HOME;
  const { dir, db } = freshDb();
  const { project, s } = firstSwitchProject();
  try {
    process.env.OPENCODE_HOME = path.dirname(db);
    const built = buildCommand(project, s, "opencode", []);
    assert.ok(built.fabricatedId, "a session id was minted for the fresh switch");
    assert.match(built.fabricatedId, /^ses_bridge/, "and it is recognisably a bridge-made session");
    assert.ok(built.carries, "the delta is carried, so the launcher commits it once injection succeeds");
    assert.equal(built.preResume.cmd, "sqlite3", "delivery is the direct store write");
    assert.deepEqual(built.args, ["--session", built.fabricatedId], "and it resumes the very session it fabricated");
    // The write it hands the launcher really creates the session and the message.
    execFileSync("sqlite3", [db, built.preResume.args[1]]);
    assert.equal(execFileSync("sqlite3", [db, `SELECT count(*) FROM session WHERE id='${built.fabricatedId}';`]).toString().trim(), "1");
    assert.equal(execFileSync("sqlite3", [db, `SELECT count(*) FROM message WHERE session_id='${built.fabricatedId}';`]).toString().trim(), "1");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a first switch with NO store leaves the delta pending, never blank-delivered", () => {
  // Without a store there is nothing to fabricate into, so the old safety holds:
  // the delta stays pending rather than being credited to a session that never got it.
  const prev = process.env.OPENCODE_HOME;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oc-home-none-"));
  const { project, s } = firstSwitchProject();
  try {
    process.env.OPENCODE_HOME = empty;
    const built = buildCommand(project, s, "opencode", []);
    assert.equal(built.fabricatedId, undefined, "nothing to fabricate");
    assert.equal(built.carries ?? null, null, "a blank first session must not be credited with the handoff");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prev;
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("fabricateSession resolves project_id from the store, falling back to global", () => {
  // The project_id is read, not guessed: a directory OpenCode has already projected
  // uses its real project row; one it has not falls back to the 'global' project,
  // exactly as OpenCode's own sessions in an un-projected directory do. Proven by
  // running the fabricated SQL against a store with and without a matching project.
  const prev = process.env.OPENCODE_HOME;
  const { dir, db } = freshDb();
  const projected = "/tmp/projected-dir";
  const fresh = "/tmp/fresh-dir";
  execFileSync("sqlite3", [db, "INSERT INTO project (id, worktree) VALUES ('proj_real', '/tmp/projected-dir');"]);
  try {
    process.env.OPENCODE_HOME = path.dirname(db);

    const a = fabricateSession(projected, "delta A", 1000);
    execFileSync("sqlite3", [db, a.preResume.args[1]]);
    assert.equal(
      execFileSync("sqlite3", [db, `SELECT project_id FROM session WHERE id='${a.id}';`]).toString().trim(),
      "proj_real",
      "a directory with a project row uses that project's id"
    );

    const b = fabricateSession(fresh, "delta B", 1000);
    execFileSync("sqlite3", [db, b.preResume.args[1]]);
    assert.equal(
      execFileSync("sqlite3", [db, `SELECT project_id FROM session WHERE id='${b.id}';`]).toString().trim(),
      "global",
      "a directory with no project row falls back to the global project"
    );

    // Idempotent: the id is derived from the delta, so a recompute is the same id.
    assert.equal(fabricateSession(fresh, "delta B", 9999).id, b.id, "same delta and dir mint the same session id");
    assert.equal(fabricateSession(projected, "delta A", 1000).id === b.id, false, "different delta or dir differs");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fabricateSession returns null when there is no store to write into", () => {
  const prev = process.env.OPENCODE_HOME;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oc-none-"));
  try {
    process.env.OPENCODE_HOME = empty;
    assert.equal(fabricateSession("/tmp/x", "delta", 1000), null, "no db, nothing to fabricate");
    assert.equal(fabricateSession("/tmp/x", "", 1000), null, "no delta, nothing to fabricate");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prev;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// discover() must not blindly link the newest session in a directory. OpenCode's
// store, unlike the file-based agents, lets any `opencode run` in a directory
// leave a session there, so a busy project dir fills with stray model-call
// remnants. selectDiscovered prefers a session the bridge actually manages.

const sess = (id, updated) => ({ id, time: { updated } });

test("selectDiscovered: a lone session is unambiguous", () => {
  assert.deepEqual(selectDiscovered([sess("ses_x", 5)], new Set()), {
    id: "ses_x",
    transcriptPath: null,
    updatedAt: 5,
    deterministic: true,
  });
  assert.equal(selectDiscovered([], new Set()), null);
});

test("selectDiscovered: the newest is NOT taken when it is stray litter and a bridge session exists", () => {
  // The reported failure: 1 real 82-message chat the bridge handed off into, and a
  // newer 2-message `opencode run` remnant. Newest-wins would adopt the remnant.
  const sessions = [sess("ses_run_remnant", 200), sess("ses_real", 100)];
  const touched = new Set(["ses_real"]);
  const got = selectDiscovered(sessions, touched);
  assert.equal(got.id, "ses_real", "the bridge-touched session wins over the newer stray");
  assert.equal(got.deterministic, true, "and being provably ours, it is adopted silently");
});

test("selectDiscovered: a fabricated ses_bridge* id counts as the bridge's own", () => {
  const sessions = [sess("ses_run_remnant", 200), sess("ses_bridgeabc123", 100)];
  const got = selectDiscovered(sessions, new Set());
  assert.equal(got.id, "ses_bridgeabc123", "a fabricated session is recognised by its id alone");
  assert.equal(got.deterministic, true);
});

test("selectDiscovered: several bridge sessions narrow to the newest but ask for --adopt", () => {
  const sessions = [sess("ses_bridgeA", 300), sess("ses_bridgeB", 200), sess("ses_stray", 400)];
  const got = selectDiscovered(sessions, new Set());
  assert.equal(got.id, "ses_bridgeA", "newest of the bridge's own, not the newer stray");
  assert.equal(got.deterministic, false, "more than one of ours means the human confirms");
});

test("selectDiscovered: with no bridge session it keeps the old newest-wins guess", () => {
  const sessions = [sess("ses_p", 200), sess("ses_q", 100)];
  const got = selectDiscovered(sessions, new Set());
  assert.equal(got.id, "ses_p", "backwards compatible: newest");
  assert.equal(got.deterministic, false, "and still behind --adopt for a genuine first adoption");
});

test("bridgeTouchedSessionIds reads the sessions the bridge has injected into", () => {
  const prev = process.env.OPENCODE_HOME;
  const { dir, db } = freshDb();
  try {
    process.env.OPENCODE_HOME = path.dirname(db);
    // A bridge handoff into ses_real, and an untouched app session ses_app.
    execFileSync("sqlite3", [db, injectionSql("ses_real", "a handoff", 1000)]);
    execFileSync("sqlite3", [db, "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_app_1', 'ses_app', 1, 1, '{}');"]);
    const touched = bridgeTouchedSessionIds();
    assert.ok(touched.has("ses_real"), "a session with an injected msg_bridge_* message is touched");
    assert.equal(touched.has("ses_app"), false, "an app's own session is not");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
