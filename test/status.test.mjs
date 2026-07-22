import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultState, saveState, loadState } from "../src/state.mjs";

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "bridge.mjs");

// What this output used to be: every agent's progress printed as its raw
// watermark. Watermarks are opaque by design, so the same column held an ISO
// instant for Claude, a JSON object for Grok and a bare integer for Antigravity,
// under a heading that said "synced" and answered none of what a person asks.
// These tests hold the shape that replaced it.

test("the opaque watermark never reaches the default view", () => {
  const project = fixture();
  const out = status(project);
  assert.doesNotMatch(out, /\{"rows"/, "Grok's compound mark is an internal, not a thing to show somebody");
  assert.doesNotMatch(out, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, "a raw ISO stamp is not an answer to any question");
  assert.doesNotMatch(out, /019f7c56-95b8/, "session ids belong to debugging, not to a status line");
});

test("everything hidden by default is still there under --debug", () => {
  const project = fixture();
  const out = status(project, ["--debug"]);
  assert.match(out, /019f-codex/, "the id has to remain reachable for whoever is actually debugging");
  assert.match(out, /mark/, "and so does the watermark it was hiding");
});

// The question the old output could not answer: who handed to whom, and when.
// The answer was already on disk in the checkpoint filenames and never read.
test("the switch history is recovered from the checkpoints themselves", () => {
  const project = fixture();
  const out = status(project);
  assert.match(out, /Recent switches/);
  assert.match(out, /Claude Code\s+→ Codex/, "a switch has a direction and it has to be visible");
  assert.match(out, /Codex\s+→ Claude Code/);
});

test("an agent's progress is a plain duration, not a watermark", () => {
  const project = fixture();
  const out = status(project);
  assert.match(out, /handed off .+ ago|has never handed off/, "read without arithmetic or vendor knowledge");
});

test("the agent you are in is named as such, not left to be inferred", () => {
  const project = fixture();
  assert.match(status(project), /You are in\s+Codex/);
  assert.match(status(project), /you are here/);
});

// A matrix where every cell reads the same on a healthy project buries the one
// cell that does not. Only the gap is worth a line.
test("only pairs that have never exchanged anything are mentioned", () => {
  const project = fixture();
  const out = status(project);
  assert.match(out, /Not yet shared/);
  assert.match(out, /has never received/);
  assert.doesNotMatch(out, /caught up with/, "the full matrix was exact and unreadable");
});

test("a project where everyone is up to date says nothing about sharing", () => {
  const project = fixture();
  // Through loadState and saveState: a test that hand-writes the file is a test
  // coupled to where the fields happen to live today.
  const s = loadState(project);
  // Everyone has seen everyone: there is no gap left to report.
  s.knownBy = { claude: { codex: "x" }, codex: { claude: "x" } };
  delete s.agents.grok;
  delete s.agents.antigravity;
  saveState(project, s);
  assert.doesNotMatch(status(project), /Not yet shared/, "silence is the right report when there is nothing missing");
});

function status(project, extra = []) {
  const res = spawnSync(process.execPath, [BRIDGE, "status", ...extra], { cwd: project, encoding: "utf8" });
  return res.stdout;
}

/** A project mid-flow: Claude and Codex have switched, Grok never met Antigravity. */
function fixture() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-status-")));
  const s = defaultState(project);
  s.activeAgent = "codex";
  for (const [id, mark] of [
    ["claude", "2026-07-22T07:29:48.124Z"],
    ["codex", "2026-07-22T07:31:13.120Z"],
    ["grok", { rows: 637, ts: "2026-07-21T11:57:20.831Z" }],
    ["antigravity", 237],
  ]) {
    const transcript = path.join(project, `${id}.jsonl`);
    fs.writeFileSync(transcript, "");
    s.agents[id] = { id: id === "codex" ? "019f-codex" : `${id}-1`, transcriptPath: transcript, mark, idle: false };
  }
  // Grok has heard from nobody: the one real gap in an otherwise synced project.
  s.knownBy = {
    claude: { codex: "x", grok: "x", antigravity: "x" },
    codex: { claude: "x", grok: "x", antigravity: "x" },
    grok: { claude: "x", codex: "x" },
    antigravity: { claude: "x", codex: "x", grok: "x" },
  };
  saveState(project, s);

  const checkpoints = path.join(project, ".bridge", "checkpoints");
  fs.mkdirSync(checkpoints, { recursive: true });
  for (const name of [
    "2026-07-22T07-19-19-498Z-codex-to-claude.md.consumed",
    "2026-07-22T07-29-41-089Z-claude-to-codex.md.consumed",
    "2026-07-22T07-29-41-089Z-claude-to-codex-full.md",
  ]) {
    fs.writeFileSync(path.join(checkpoints, name), "x");
  }
  return project;
}

// Caught by Serdar reading the first version: it printed only the time, and
// dropped the date for anything from today. You do not read this only on the
// day you switched — come back after two days and a line saying 10:31 is
// indistinguishable from this morning. A timestamp you cannot place is worse
// than none, because it gets believed. So every line carries its date.
test("every switch says which day it happened, not just the hour", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-when-")));
  const s = defaultState(project);
  s.activeAgent = "claude";
  for (const id of ["claude", "codex"]) {
    const transcript = path.join(project, `${id}.jsonl`);
    fs.writeFileSync(transcript, "");
    s.agents[id] = { id: `${id}-1`, transcriptPath: transcript, mark: null, idle: false };
  }
  saveState(project, s);

  const checkpoints = path.join(project, ".bridge", "checkpoints");
  fs.mkdirSync(checkpoints, { recursive: true });
  const stamp = (d) => d.toISOString().replace(/:/g, "-").replace(".", "-");
  const now = new Date();
  fs.writeFileSync(path.join(checkpoints, `${stamp(now)}-claude-to-codex.md`), "x");
  fs.writeFileSync(path.join(checkpoints, `${stamp(new Date(now - 2 * 86400000))}-codex-to-claude.md`), "x");

  const lines = status(project)
    .split("\n")
    .filter((l) => /→/.test(l));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /\d{2} \w{3} \d{2}:\d{2}/, `a line without its day cannot be placed: ${JSON.stringify(line)}`);
  }
  // One column for the arrows, whatever the stamps are.
  assert.equal(lines[0].indexOf("→"), lines[1].indexOf("→"), "a ragged column is how a list stops being scannable");
});

// The two halves of this project meeting each other: status derives its history
// from checkpoint filenames, and retention deletes those checkpoints. After a
// prune the first version said an agent "has never handed off" — not incomplete
// but false, about an agent that had handed off many times. Absence of evidence
// reported as evidence of absence, which is the failure this codebase keeps
// finding. The state knew all along: a mark is only ever set by handing off.
test("an agent whose switch records were pruned is not called one that never switched", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pruned-")));
  const s = defaultState(project);
  s.activeAgent = "claude";
  for (const id of ["claude", "codex"]) {
    const transcript = path.join(project, `${id}.jsonl`);
    fs.writeFileSync(transcript, "");
    // Codex carries a mark: it has handed off, whatever the disk still shows.
    s.agents[id] = { id: `${id}-1`, transcriptPath: transcript, mark: id === "codex" ? "2026-07-20T10:00:00.000Z" : null, idle: false };
  }
  saveState(project, s);
  fs.mkdirSync(path.join(project, ".bridge", "checkpoints"), { recursive: true }); // pruned bare

  const out = status(project);
  assert.doesNotMatch(out, /Codex\s+has never handed off/, "that is a false statement, not a gap");
  assert.match(out, /handed off before the kept history/, "say what is actually true: it happened, the record is gone");
});

test("a trimmed switch list says it was trimmed", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-trimmed-")));
  const s = defaultState(project);
  s.activeAgent = "claude";
  for (const id of ["claude", "codex"]) {
    const transcript = path.join(project, `${id}.jsonl`);
    fs.writeFileSync(transcript, "");
    s.agents[id] = { id: `${id}-1`, transcriptPath: transcript, mark: "2026-07-20T10:00:00.000Z", idle: false };
  }
  saveState(project, s);

  // One switch survives; Codex's own are gone, so the list is bounded by
  // retention rather than by what happened.
  const checkpoints = path.join(project, ".bridge", "checkpoints");
  fs.mkdirSync(checkpoints, { recursive: true });
  fs.writeFileSync(path.join(checkpoints, "2026-07-22T09-00-00-000Z-claude-to-codex.md"), "x");

  assert.match(status(project), /no longer kept/, "a trimmed history must not read as the whole of one");
});

// Found in review, and it is the same shape as the bug it was meant to fix: the
// notice sat inside the block that renders the switch list, so it appeared when
// the history was partly trimmed and vanished when pruning took all of it. It
// said least exactly where there was least to see. My own two tests missed it
// because one checked only the agent row and the other left a checkpoint alive.
test("a history pruned to nothing still says it was pruned", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-allgone-")));
  const s = defaultState(project);
  s.activeAgent = "claude";
  for (const id of ["claude", "codex"]) {
    const transcript = path.join(project, `${id}.jsonl`);
    fs.writeFileSync(transcript, "");
    s.agents[id] = { id: `${id}-1`, transcriptPath: transcript, mark: "2026-07-20T10:00:00.000Z", idle: false };
  }
  saveState(project, s);
  fs.mkdirSync(path.join(project, ".bridge", "checkpoints"), { recursive: true }); // every one gone

  const out = status(project);
  assert.match(out, /no longer kept/, "with nothing left to show, saying why matters more, not less");
  assert.match(out, /Recent switches/, "and the heading has to be there for the line to belong to anything");
});

test("a project that has genuinely never switched says nothing about pruning", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-virgin-")));
  const s = defaultState(project);
  s.activeAgent = "claude";
  const transcript = path.join(project, "claude.jsonl");
  fs.writeFileSync(transcript, "");
  // Linked, but no mark: it has never handed off, so nothing was ever pruned.
  s.agents.claude = { id: "claude-1", transcriptPath: transcript, mark: null, idle: false };
  saveState(project, s);

  const out = status(project);
  assert.doesNotMatch(out, /no longer kept/, "nothing was lost, so claiming loss would be its own false statement");
});
