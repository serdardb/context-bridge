import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeJsonl } from "../src/probe.mjs";
import { ADAPTERS, AGENT_IDS, adapterFor } from "../src/agents/index.mjs";
import { collect } from "../src/doctor.mjs";
import { defaultState, saveState } from "../src/state.mjs";

// The bug this whole tier exists for: an agent renames a field in its own
// session format, the bridge silently produces empty deltas, and doctor keeps
// printing green because the binary is still installed and still logged in.
test("a renamed vendor field is reported as a mismatch, not as success", () => {
  const p = write("drift.jsonl", rows(200, { kind: "user", ts: "2026-07-21T00:00:00Z" }));
  const res = probeJsonl(p, (r) => r.type === "user" && !!r.timestamp);
  assert.equal(res.status, "mismatch");
  assert.equal(res.known, 0);
  assert.equal(res.rows, 200, "the rows are there; it is our reading of them that broke");
});

test("an empty session is readable, because having said nothing is not a failure", () => {
  const res = probeJsonl(write("empty.jsonl", ""), () => true);
  assert.equal(res.status, "readable");
  assert.equal(res.rows, 0);
});

test("a torn write is partial, not fatal: the parser reads past the bad line", () => {
  const good = JSON.stringify({ type: "user", timestamp: "2026-07-21T00:00:00Z" });
  const res = probeJsonl(write("torn.jsonl", `${good}\n{ half-written`), (r) => r.type === "user");
  assert.equal(res.status, "partial");
  assert.equal(res.known, 1);
  assert.equal(res.malformed, 1);
});

test("a missing transcript is missing, and a missing path is not a crash", () => {
  assert.equal(probeJsonl(path.join(os.tmpdir(), "nope-does-not-exist.jsonl"), () => true).status, "missing");
  assert.equal(probeJsonl(null, () => true).status, "missing");
});

test("a predicate that throws is survivable — a throwing probe would be worse than a blind one", () => {
  const p = write("hostile.jsonl", rows(3, { type: "user" }));
  const res = probeJsonl(p, () => {
    throw new Error("unexpected shape");
  });
  assert.equal(res.status, "mismatch", "nothing was recognised, which is the honest verdict");
});

test("every registered adapter implements the canary, including any added later", () => {
  for (const id of AGENT_IDS) {
    assert.equal(typeof adapterFor(id).parseProbe, "function", `${id} must be probeable`);
  }
});

test("each adapter recognises its own real record shape and rejects a foreign one", () => {
  const samples = {
    claude: { type: "user", timestamp: "2026-07-21T00:00:00Z", message: { content: "hi" } },
    codex: { type: "event_msg", timestamp: "2026-07-21T00:00:00Z", payload: { type: "user_message", message: "hi" } },
    grok: { type: "user", content: "hi" },
  };
  for (const id of AGENT_IDS) {
    const own = probeOne(id, samples[id]);
    assert.equal(own.status, "readable", `${id} must recognise its own rows`);
    const foreign = probeOne(id, { totally: "unrelated", shape: 1 });
    assert.equal(foreign.status, "mismatch", `${id} must not accept an unknown shape as fine`);
  }
});

// A fresh project has no linked session. Reporting that as a fault would train
// people to ignore the row, which defeats the point of adding it at all.
test("doctor on a fresh project reports no session, never a failure", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-fresh-"));
  const r = collect(project);
  for (const id of AGENT_IDS) {
    const status = r.agents[id].session.status;
    assert.ok(status === "none" || status === "readable", `${id} reported ${status} on a fresh project`);
    assert.notEqual(status, "mismatch");
    assert.notEqual(status, "missing");
  }
  for (const route of Object.values(r.routes)) {
    assert.equal(route.sessionWarning, null, "a fresh project must not carry session warnings");
  }
});

test("route lines say CONFIGURED, because shallow checks cannot prove an agent works", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-labels-"));
  for (const route of Object.values(collect(project).routes)) {
    assert.match(route.status, /^(CONFIGURED|NOT CONFIGURED)$/);
    assert.doesNotMatch(route.status, /READY/, "READY overclaimed: it read as proof the switch works");
  }
});

function probeOne(id, row) {
  const p = write(`${id}-sample.jsonl`, JSON.stringify(row));
  const ref = { transcriptPath: p, eventsPath: p };
  const { messages, ...shape } = ADAPTERS[id].parseProbe(ref);
  return shape;
}

function rows(n, row) {
  return Array.from({ length: n }, () => JSON.stringify(row)).join("\n");
}

function write(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-probe-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

// Found in review by Grok, and it is the exact failure this tier was built to
// prevent: a project linked to a session whose files are gone reported "none",
// the wording reserved for fresh projects. The calm wording hid the fault.
test("a linked session that cannot be resolved is missing, not a fresh project", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-orphan-"));
  const state = defaultState(project);
  state.agents.grok = {
    id: "019f0000-0000-0000-0000-000000000000",
    transcriptPath: path.join(project, "gone", "chat_history.jsonl"),
    mark: null,
    idle: false,
  };
  saveState(project, state);

  const r = collect(project);
  assert.equal(r.agents.grok.session.status, "missing");
  assert.notEqual(r.agents.grok.session.status, "none", "a broken link must not read as a fresh project");
});

test("an unreadable linked session takes its routes off green and the exit code with it", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-broken-"));
  const transcript = path.join(project, "session.jsonl");
  // A vendor rename: the rows are all still there, not one is a shape we know.
  fs.writeFileSync(transcript, rows(50, { kind: "user", ts: "2026-07-21T00:00:00Z" }));

  const state = defaultState(project);
  state.agents.claude = { id: "6972877f-0000-0000-0000-000000000001", transcriptPath: transcript, mark: null, idle: false };
  saveState(project, state);

  const r = collect(project);
  assert.equal(r.agents.claude.session.status, "mismatch");
  for (const [name, route] of Object.entries(r.routes)) {
    if (!name.includes("claude")) continue;
    assert.equal(route.configured, false, `${name} must not stay green over an unreadable session`);
    assert.equal(route.status, "SESSION UNREADABLE");
    assert.match(route.sessionWarning ?? "", /claude/);
  }
});

test("the missing file is named, because Grok keeps two and only one may be gone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-two-"));
  const chat = path.join(dir, "chat_history.jsonl");
  fs.writeFileSync(chat, JSON.stringify({ type: "user", content: "hi" }));
  const res = ADAPTERS.grok.parseProbe({ transcriptPath: chat, eventsPath: path.join(dir, "events.jsonl") });
  assert.equal(res.status, "missing");
  assert.equal(res.detail, "events.jsonl", "naming the transcript would send people to the wrong file");
});
