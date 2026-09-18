import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  injectionSql,
  preResume,
  fabricateSession,
  discover,
  schemaHealth,
  selectDiscovered,
  bridgeTouchedSessionIds,
  parseExportMessages,
  parseAudit,
  activitySince,
  auditSince,
  parseProbe,
  snapshotSource,
  SQLITE_OPERATION_TIMEOUT_MS,
} from "../src/agents/opencode.mjs";
import { buildCommand } from "../src/launcher.mjs";
import { handoff } from "../src/handoff.mjs";
import { defaultState, saveState, loadState, safeCheckpointPath, checkpointsDir, writeCheckpoint } from "../src/state.mjs";

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

test("fabricating a session rolls back the session when its message write fails", () => {
  const previous = process.env.OPENCODE_HOME;
  const { dir, db } = freshDb();
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  try {
    process.env.OPENCODE_HOME = path.dirname(db);
    const fabricated = fabricateSession(project, "delta", 1000);
    assert.ok(fabricated, "the fixture has a store, so fabrication reaches SQLite");

    // The session and message are one transaction. Removing the message table
    // forces the second write to fail; the session must not survive as a ghost.
    execFileSync("sqlite3", [db, "DROP TABLE message;"]);
    assert.throws(() => execFileSync("sqlite3", [db, fabricated.preResume.args[1]], { stdio: "ignore" }));
    assert.equal(
      execFileSync("sqlite3", [db, "SELECT count(*) FROM session WHERE id LIKE 'ses_bridge%';"]).toString().trim(),
      "0",
      "a failed message write rolls back the fabricated session"
    );
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = previous;
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
    assert.equal(pre.timeout, SQLITE_OPERATION_TIMEOUT_MS);
    assert.equal(pre.operation, "OpenCode context injection");
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

test("a locked OpenCode store fails quickly instead of hanging the injection", async () => {
  const { dir, db } = freshDb();
  const holder = spawn("sqlite3", [db], { stdio: ["pipe", "pipe", "ignore"] });
  const closed = once(holder, "close");
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SQLite did not acquire its fixture lock")), 5000);
      let output = "";
      holder.stdout.on("data", (data) => {
        output += data;
        if (output.includes("LOCK_ACQUIRED")) { clearTimeout(timer); resolve(); }
      });
      holder.once("close", () => { clearTimeout(timer); reject(new Error("SQLite lock holder exited early")); });
      holder.stdin.write("BEGIN EXCLUSIVE;\n.print LOCK_ACQUIRED\n");
    });
    const started = Date.now();
    const result = spawnSync("sqlite3", [db, injectionSql("ses_a", "locked", 1000)], {
      encoding: "utf8",
      timeout: 1000,
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, "a locked database must refuse the write");
    assert.match(result.stderr, /database is locked/i, "SQLite CLI exit codes differ by build; the diagnostic must identify the lock");
    assert.ok(Date.now() - started < 1000, "a locked store must fail before the bridge timeout");
  } finally {
    holder.kill("SIGTERM");
    await closed;
    fs.rmSync(dir, { recursive: true, force: true });
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
  const revision = { messages: [{ info: { role: "assistant", time: { created: 1000 } },
    parts: [{ type: "text", text: "prefix" }, { type: "tool", tool: "bash",
      state: { status: "running", input: { command: "echo final" } } }] }] };
  assert.equal(parseAudit(JSON.stringify(revision)).sourceComplete, false);
  revision.messages[0].info.time.completed = 3000;
  revision.messages[0].parts[0].text += " and conclusion";
  revision.messages[0].parts[1].state.status = "completed";
  const completed = JSON.stringify(revision);
  assert.equal(parseExportMessages(completed)[0].at, new Date(3000).toISOString());
  const audit = parseAudit(completed, new Date(2000).toISOString());
  assert.equal(audit.commands.length, 1, "completion after the mark must not lose an older message's tool result");
  assert.equal(audit.sourceComplete, true);
  assert.deepEqual(parseExportMessages("not json at all"), [], "garbage in, empty out, no throw");
  for (const invalid of ["not json", "{broken", "{}", '{"messages":[{}]}']) {
    assert.throws(() => parseExportMessages(invalid, { required: true }), { code: "BRIDGE_TRANSCRIPT_UNREADABLE" });
    assert.equal(parseAudit(invalid).sourceComplete, false);
  }
  assert.deepEqual(parseExportMessages('{"messages":[]}', { required: true }), []);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = "";
    const ref = { id: "unavailable-export" };
    assert.equal(parseProbe(ref).status, "unreadable");
    assert.throws(() => activitySince(ref), { code: "BRIDGE_TRANSCRIPT_UNREADABLE" });
    assert.throws(() => auditSince(ref), { code: "BRIDGE_TRANSCRIPT_UNREADABLE" });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("handoff shares one OpenCode export between conversation and audit without caching future handoffs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-source-snapshot-"));
  const project = path.join(root, "project"), bin = path.join(root, "bin");
  fs.mkdirSync(project); fs.mkdirSync(bin);
  const counter = path.join(root, "exports");
  const database = freshDb();
  const oldDb = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = database.db;
  fs.writeFileSync(path.join(bin, "opencode"), `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(counter)};
const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
fs.writeFileSync(file, String(n));
if (process.env.OPENCODE_DB !== ${JSON.stringify(database.db)}) {
  const {execFileSync}=require('node:child_process');
  const source=${JSON.stringify(database.db)};
  const copy=process.env.OPENCODE_DB;
  const query='SELECT count(*) FROM message;';
  const before=execFileSync('sqlite3',['-readonly',copy,query],{encoding:'utf8'});
  execFileSync('sqlite3',[source,"INSERT INTO message VALUES ('live-"+n+"','ses_snapshot',0,0,'{}');"]);
  if(execFileSync('sqlite3',['-readonly',copy,query],{encoding:'utf8'})!==before) process.exit(3);
  fs.appendFileSync(file+'.copies',copy+'\\n');
}
const id = process.argv[3];
const mismatch = fs.existsSync(file + '.mismatch') ? fs.readFileSync(file + '.mismatch', 'utf8') : '';
const document = {info:{id},messages:[{info:{sessionID:id,role:'assistant',time:{created:Date.now(),completed:Date.now()}},parts:[
{sessionID:id,type:'text',text:'export-generation-'+n},
{sessionID:id,type:'tool',tool:'bash',state:{status:'completed',input:{command:'echo export-generation-'+n},metadata:{exit:0}}}
]}]};
if (mismatch === 'session') document.info.id = 'ses_foreign';
if (mismatch === 'message') document.messages[0].info.sessionID = 'ses_foreign';
if (mismatch === 'part') document.messages[0].parts[0].sessionID = 'ses_foreign';
if (mismatch === 'missing') delete document.info;
if (mismatch === 'streaming') delete document.messages[0].info.time.completed;
console.log(JSON.stringify(document));
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
  try {
    const s = defaultState(project);
    s.activeAgent = "opencode";
    s.agents.opencode = { id: "ses_snapshot", transcriptPath: null, mark: null, idle: false };
    saveState(project, s);
    let previous = null;
    for (let turn = 0; turn < 2; turn++) {
      handoff(project, "codex", { from: "opencode", checkTarget: () => {} });
      const state = loadState(project);
      const file = safeCheckpointPath(project, state.pendingInjection.deltaFile);
      const body = fs.readFileSync(file.replace(/\.md$/, "-full.md"), "utf8");
      const generation = body.match(/export-generation-\d+/)?.[0];
      const audit = JSON.parse(fs.readFileSync(file.replace(/\.md$/, "-audit.json"), "utf8"));
      assert.ok(generation);
      assert.equal(audit.agents.opencode.commands[0].args, `echo ${generation}`);
      assert.notEqual(generation, previous, "a later handoff must read a fresh export");
      assert.equal(audit.readerErrors, undefined);
      previous = generation;
    }
    const copies = fs.readFileSync(counter + '.copies', 'utf8').trim().split('\n');
    assert.equal(copies.length, 2, "each handoff must export a fresh private SQLite snapshot");
    assert.ok(copies.every(copy => !fs.existsSync(path.dirname(copy))), "private database copies must be cleaned");
    fs.writeFileSync(counter + ".mismatch", "streaming");
    handoff(project, "codex", { from: "opencode", checkTarget: () => {} });
    assert.equal(loadState(project).pendingInjection.sources.opencode, undefined,
      "a streamed prefix cannot acknowledge the still-growing source");
    fs.unlinkSync(counter + ".mismatch");
    handoff(project, "codex", { from: "opencode", checkTarget: () => {} });
    assert.ok(loadState(project).pendingInjection.sources.opencode,
      "a completed source must become eligible for acknowledgement again");
    for (const mismatch of ["session", "message", "part", "missing"]) {
      fs.writeFileSync(counter + ".mismatch", mismatch);
      assert.throws(() => activitySince({ id: "ses_snapshot" }, null),
        { code: "BRIDGE_TRANSCRIPT_UNREADABLE" }, "foreign or unbound export must not become conversation");
      assert.throws(() => auditSince({ id: "ses_snapshot" }, null),
        { code: "BRIDGE_TRANSCRIPT_UNREADABLE" }, "foreign export must not become audit evidence");
      assert.throws(() => snapshotSource({ id: "ses_snapshot" }), { code: "BRIDGE_TRANSCRIPT_UNREADABLE" });
      handoff(project, "codex", { from: "opencode", checkTarget: () => {} });
      const state = loadState(project);
      const file = safeCheckpointPath(project, state.pendingInjection.deltaFile);
      const body = fs.readFileSync(file.replace(/\.md$/, "-full.md"), "utf8");
      assert.doesNotMatch(body, /export-generation-/);
      assert.match(fs.readFileSync(file, "utf8"), /source could not be read reliably/);
      assert.equal(state.pendingInjection.sources.opencode, undefined, "foreign evidence cannot advance delivery");
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldDb === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = oldDb;
    fs.rmSync(database.dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const execute = cp.execFileSync;
      const spawn = cp.spawn;
      cp.execFileSync = (cmd, args, options) => {
        if (cmd === 'sqlite3' && options?.stdio === 'ignore') {
          return execute(process.execPath, ['-e',
            "process.on('SIGTERM', () => {}); setTimeout(() => { require('node:fs').writeFileSync('helper-survived', 'yes'); process.exit(0); }, 1800);"
          ], { ...options, timeout: 500 });
        }
        return execute(cmd, args, options);
      };
      cp.spawn = (cmd, args, options) => cmd === 'opencode'
        ? spawn(process.execPath, ['-e', 'process.exit(0)'], options)
        : spawn(cmd, args, options);
      syncBuiltinESMExports();
      const { main } = await import(${JSON.stringify(new URL("../src/cli.mjs", import.meta.url).href)});
      await main(['opencode']);
    `], { cwd: project, env: { ...process.env }, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /timed out.*stays pending/);
    assert.equal(fs.existsSync(path.join(project, "helper-survived")), false,
      "the helper must terminate at the deadline even when it ignores SIGTERM");
    assert.deepEqual(loadState(project).pendingInjection, s.pendingInjection);
    assert.ok(fs.existsSync(safeCheckpointPath(project, s.pendingInjection.deltaFile)));
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

test("bounded discovery does not start the OpenCode server fallback", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "oc-discovery-bin-"));
  const marker = path.join(bin, "server-started");
  const previousPath = process.env.PATH;
  fs.writeFileSync(
    path.join(bin, "opencode"),
    `#!/bin/sh
if [ "$1" = "serve" ]; then
  touch ${JSON.stringify(marker)}
  sleep 5
fi
exit 1
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    assert.equal(discover("/tmp/no-open-code-session", { allowServerFallback: false, timeout: 100 }), null);
    assert.equal(fs.existsSync(marker), false, "bounded source discovery must not spawn a server fallback");
    fs.unlinkSync(path.join(bin, "opencode"));
    process.env.PATH = bin;
    const execute = childProcess.execFileSync;
    let fallback = false;
    try {
      childProcess.execFileSync = (command, ...args) => {
        if (command === "/bin/bash") { fallback = true; throw new Error("unexpected server fallback"); }
        return execute(command, ...args);
      };
      syncBuiltinESMExports();
      assert.equal(discover("/tmp/no-open-code-session", { timeout: 1000 }), null);
      assert.equal(fallback, false, "a missing executable cannot be recovered by starting its server");
    } finally { childProcess.execFileSync = execute; syncBuiltinESMExports(); }
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("fallback discovery obeys the caller timeout", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "oc-discovery-timeout-bin-"));
  const previousPath = process.env.PATH;
  fs.writeFileSync(
    path.join(bin, "opencode"),
    `#!/bin/sh
exit 1
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    const started = Date.now();
    assert.equal(discover("/tmp/no-open-code-session", { allowServerFallback: true, timeout: 100 }), null);
    assert.ok(Date.now() - started < 1000, "fallback discovery must honor the caller's hard timeout");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

for (const responds of [false, true]) {
test(`a delayed fallback server ${responds ? "is discovered and cleaned up" : "that never answers does not outlive discovery"}`, () => {
  // The real server binds its port before it can answer on it, so `curl` connects
  // and then waits. That is the shape that leaked: bash blocks inside the command
  // substitution, and a trap only runs between commands, so neither the INT/TERM
  // trap nor the EXIT trap that kills the server can fire -- and the caller's own
  // timeout cannot land either. Ten bash/curl/server triples were found alive on
  // one machine, the oldest 42 hours old and still holding its port.
  //
  // discover() is synchronous, so a regression here hangs the whole run rather
  // than failing it. The call goes into a child process so the bug surfaces as a
  // red test with a message instead of a CI timeout.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "oc-leak-bin-"));
  const pidFile = path.join(bin, "serve.pid");
  const connectedFile = path.join(bin, "connected");
  const serverScript = path.join(bin, "server.cjs");
  const runner = path.join(bin, "run-discover.mjs");
  const opencodeModule = new URL("../src/agents/opencode.mjs", import.meta.url).href;

  fs.writeFileSync(serverScript, `
const fs = require("node:fs");
const transport = require(${JSON.stringify(responds ? "node:http" : "node:net")});
const server = transport.createServer((request, response) => {
  fs.writeFileSync(${JSON.stringify(connectedFile)}, "accepted");
  ${responds ? `response.end(JSON.stringify({data: [{id: 'delayed-session', directory: '/tmp/no-open-code-session'}]}));` : ""}
});
// Fast connection refusals must not exhaust the whole startup budget before
// this real server binds. Previously two 200ms waits ended discovery too early.
setTimeout(() => server.listen(Number(process.argv[2]), "127.0.0.1"), 700);
`);
  fs.writeFileSync(
    path.join(bin, "opencode"),
    `#!/bin/sh
if [ "$1" = "serve" ]; then
  port=""
  for arg in "$@"; do
    case "$arg" in --port=*) port=\${arg#--port=} ;; esac
  done
  echo $$ > ${pidFile}
  exec "${process.execPath}" "${serverScript}" "$port"
fi
exit 1
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    runner,
    `import { discover } from ${JSON.stringify(opencodeModule)};
console.log(JSON.stringify(discover("/tmp/no-open-code-session", { allowServerFallback: true, timeout: 3000 })));
`,
  );

  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  let servePid = null;
  try {
    const res = spawnSync(process.execPath, [runner], {
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    assert.notEqual(res.signal, "SIGTERM", "discovery must honor its own timeout instead of blocking forever");
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout)?.id ?? null, responds ? "delayed-session" : null);

    // The stub records its own pid before exec, so this is the server the fallback started.
    servePid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isFinite(servePid) && servePid > 0, "the stub server should have recorded its pid");
    // Prove startup polling reached the delayed server; exiting before it binds
    // cannot stand in for either successful discovery or hung-probe cleanup.
    assert.equal(fs.readFileSync(connectedFile, "utf8"), "accepted", "a probe must reach the delayed server");

    // Cleanup may land just after the call returns; allow for it, but bound the wait.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && alive(servePid)) spawnSync("sleep", ["0.1"]);
    let processState = "";
    if (process.platform === "linux") {
      try { processState = fs.readFileSync(`/proc/${servePid}/status`, "utf8").match(/^State:\s*(.+)$/m)?.[1] ?? ""; } catch {}
    }
    assert.equal(alive(servePid), false, `the fallback server must not outlive the bounded discovery call${processState ? ` (Linux state: ${processState})` : ""}`);
  } finally {
    if (!servePid && fs.existsSync(pidFile)) servePid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (servePid && alive(servePid)) { try { process.kill(servePid, "SIGKILL"); } catch {} }
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
}

test("schemaHealth distinguishes a compatible, missing and incompatible store", () => {
  const previous = process.env.OPENCODE_HOME;
  const previousDb = process.env.OPENCODE_DB;
  const previousXdg = process.env.XDG_DATA_HOME;
  delete process.env.OPENCODE_DB;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oc-schema-none-"));
  try {
    process.env.OPENCODE_HOME = empty;
    assert.deepEqual(schemaHealth(), { status: "none", missing: [] });

    const compatible = freshDb();
    process.env.OPENCODE_HOME = compatible.dir;
    assert.deepEqual(schemaHealth(), { status: "compatible", missing: [] });
    const custom = path.join(compatible.dir, "custom.db");
    fs.renameSync(path.join(compatible.dir, "opencode.db"), custom);
    process.env.OPENCODE_DB = "custom.db";
    assert.equal(schemaHealth().status, "compatible");
    assert.equal(preResume({ id: "ses_custom" }, "context").args[0], custom);
    process.env.OPENCODE_DB = custom;
    process.env.OPENCODE_HOME = empty;
    assert.equal(schemaHealth().status, "compatible");
    assert.equal(fabricateSession(empty, "context").preResume.args[0], custom);
    process.env.OPENCODE_DB = ":memory:";
    assert.equal(schemaHealth().status, "unreadable");
    assert.equal(preResume({ id: "ses_custom" }, "context"), null);
    assert.equal(fabricateSession(empty, "context"), null);
    delete process.env.OPENCODE_DB;
    delete process.env.OPENCODE_HOME;
    process.env.XDG_DATA_HOME = empty;
    fs.mkdirSync(path.join(empty, "opencode"));
    fs.copyFileSync(custom, path.join(empty, "opencode", "opencode.db"));
    assert.equal(schemaHealth().status, "compatible");
    assert.equal(preResume({ id: "ses_custom" }, "context").args[0], path.join(empty, "opencode", "opencode.db"));
    fs.rmSync(compatible.dir, { recursive: true, force: true });

    const incompatible = fs.mkdtempSync(path.join(os.tmpdir(), "oc-schema-bad-"));
    process.env.OPENCODE_HOME = incompatible;
    execFileSync("sqlite3", [path.join(incompatible, "opencode.db"), "CREATE TABLE project (id text);"]);
    const result = schemaHealth();
    assert.equal(result.status, "incompatible");
    assert.ok(result.missing.includes("project.worktree"));
    assert.ok(result.missing.includes("session.id"));
    fs.rmSync(incompatible, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_HOME;
    else process.env.OPENCODE_HOME = previous;
    if (previousDb === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previousDb;
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previousXdg;
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
