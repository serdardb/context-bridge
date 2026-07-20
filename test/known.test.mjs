import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handoff } from "../src/handoff.mjs";
import { appendFinalWords } from "../src/launcher.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultState, saveState, loadState, knownMark, commitKnown } from "../src/state.mjs";

const BRIDGE_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "bridge.mjs");

const GROK_ID = "019f8000-aaaa-7bbb-8ccc-ddddeeee0001";

test("a chain carries what the target missed from EVERY agent, labelled by source", async () => {
  // Claude talks to Grok, Grok works, then Grok hands to Codex. Codex has seen
  // neither, so it must receive both streams, not just Grok's.
  const { project } = fixture();
  const s = loadState(project);
  // Claude spoke, then handed to Grok: Grok knows Claude up to that point.
  s.knownBy = { grok: { claude: "2026-07-20T10:00:00.000Z" } };
  s.activeAgent = "grok";
  saveState(project, s);

  const out = handoff(project, "codex", { from: "grok", checkTarget: () => {} });
  assert.match(out, /including catch-up from Claude Code/);

  const after = loadState(project);
  const delta = fs.readFileSync(path.join(project, after.pendingInjection.deltaFile), "utf8");
  assert.match(delta, /From Claude Code/, "Claude's side must be attributed");
  assert.match(delta, /From Grok/, "Grok's side must be attributed");
  assert.match(delta, /claude decided the architecture/, "what Claude said reaches Codex through Grok");
  assert.match(delta, /grok found the bug/);
});

test("what a target already received is not sent to it twice", async () => {
  const { project } = fixture();
  const s = loadState(project);
  s.activeAgent = "grok";
  saveState(project, s);

  handoff(project, "codex", { from: "grok", checkTarget: () => {} });
  // The delta is delivered: the matrix records what it carried.
  const mid = loadState(project);
  commitKnown(mid, mid.pendingInjection);
  mid.pendingInjection = null;
  saveState(project, mid);

  assert.ok(knownMark(mid, "codex", "claude"), "Claude's stream is marked as packed for Codex");
  assert.ok(knownMark(mid, "codex", "grok"), "Grok's stream is marked as packed for Codex");

  const out = handoff(project, "codex", { from: "grok", checkTarget: () => {} });
  const delta = fs.readFileSync(path.join(project, loadState(project).pendingInjection.deltaFile), "utf8");
  assert.doesNotMatch(delta, /claude decided the architecture/, "already-delivered material is not resent");
  assert.doesNotMatch(out, /catch-up/);
});

test("closing words move the packed mark, so they are delivered once and only once", async () => {
  const { project, grokChat } = fixture();
  const s = loadState(project);
  s.activeAgent = "grok";
  saveState(project, s);

  handoff(project, "codex", { from: "grok", checkTarget: () => {} });
  // The turn ends after the handoff, exactly as it does in real use.
  fs.appendFileSync(grokChat, JSON.stringify({ type: "assistant", content: "grok's closing verdict" }) + "\n");
  appendFinalWords(project, loadState(project), "grok");

  const withClosing = loadState(project);
  const delta = fs.readFileSync(path.join(project, withClosing.pendingInjection.deltaFile), "utf8");
  assert.match(delta, /grok's closing verdict/);

  // Deliver, then hand off again: the closing verdict must not come back.
  commitKnown(withClosing, withClosing.pendingInjection);
  withClosing.pendingInjection = null;
  saveState(project, withClosing);
  handoff(project, "codex", { from: "grok", checkTarget: () => {} });
  const second = fs.readFileSync(path.join(project, loadState(project).pendingInjection.deltaFile), "utf8");
  assert.doesNotMatch(second, /grok's closing verdict/, "the matrix moved with the closing words");
});

test("the official import seeds the matrix, so the return does not hand Claude its own words", async () => {
  const { project } = fixture();
  const s = loadState(project);
  s.agents.codex = { id: null, transcriptPath: null, mark: null, idle: false };
  s.activeAgent = "claude";
  saveState(project, s);

  handoff(project, "codex", {
    from: "claude",
    checkTarget: () => {},
    transfer: () => ({ threadId: "imported-thread" }),
  });
  const after = loadState(project);
  assert.ok(knownMark(after, "codex", "claude"), "the imported conversation counts as already seen");
});

/** A project where Claude and Grok have both spoken and Codex has heard nothing. */
function fixture() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-known-")));
  const grokHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-known-grok-")));
  const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-known-codex-")));
  process.env.GROK_HOME = grokHome;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_THREAD_ID;

  const claudeTranscript = path.join(project, "claude.jsonl");
  fs.writeFileSync(
    claudeTranscript,
    [
      { timestamp: "2026-07-20T09:00:00.000Z", type: "user", message: { content: "start the work" } },
      {
        timestamp: "2026-07-20T09:00:01.000Z",
        type: "assistant",
        message: { content: [{ type: "text", text: "claude decided the architecture" }] },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
  );

  const grokDir = path.join(grokHome, "sessions", encodeURIComponent(project), GROK_ID);
  fs.mkdirSync(grokDir, { recursive: true });
  fs.writeFileSync(
    path.join(grokDir, "summary.json"),
    JSON.stringify({ info: { id: GROK_ID, cwd: project }, updated_at: "2026-07-20T11:00:00.000Z" })
  );
  const grokChat = path.join(grokDir, "chat_history.jsonl");
  fs.writeFileSync(grokChat, JSON.stringify({ type: "assistant", content: "grok found the bug" }) + "\n");
  fs.writeFileSync(
    path.join(grokDir, "events.jsonl"),
    JSON.stringify({ ts: "2026-07-20T11:00:00.000Z", type: "turn_ended", outcome: "completed" }) + "\n"
  );

  const s = defaultState(project);
  s.agents.claude = { id: "claude-1", transcriptPath: claudeTranscript, mark: null, idle: false };
  s.agents.grok = { id: GROK_ID, transcriptPath: grokChat, mark: null, idle: false };
  s.agents.codex = { id: "codex-1", transcriptPath: path.join(project, "codex.jsonl"), mark: null, idle: false };
  fs.writeFileSync(path.join(project, "codex.jsonl"), "");
  saveState(project, s);
  return { project, grokChat, claudeTranscript };
}

test("a launcher that cannot read the state file says so instead of waiting forever", async () => {
  // Real incident: a launcher started before STATE_VERSION 4 kept polling a v4
  // file, loadState threw on every tick, the catch swallowed it, and a pending
  // handoff simply never fired. Silence was indistinguishable from "nothing to do".
  const { statePath } = await import("../src/state.mjs");
  const { project } = fixture();
  fs.writeFileSync(statePath(project), JSON.stringify({ version: 99, agents: {} }));

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "status"], { cwd: project, encoding: "utf8" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /newer than this bridge understands/);
});
