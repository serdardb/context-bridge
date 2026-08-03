import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultState } from "../src/state.mjs";
import { buildCommand } from "../src/launcher.mjs";

// A hook delivers *context*, not a *turn*.
//
// That distinction had a cost nobody designed: Codex is handed the delta as a
// message and answers it, while Claude received the same delta as background and
// had nothing to answer, so every handoff stopped dead until a human typed
// something. The instruction "continue without waiting" could not fix it either,
// since that instruction also only arrives with a turn.
//
// These tests pin the fix and, more importantly, the two things it must not do:
// carry the delta a second time, and fire when nothing is pending.

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-kickoff-"));
  return dir;
}

function stateWith(pending) {
  const s = defaultState();
  s.agents.claude = { id: "sess-1", transcriptPath: "/tmp/sess-1.jsonl" };
  if (pending) s.pendingInjection = pending;
  return s;
}

test("a hook-injecting agent is given a turn to open when a handoff is waiting", () => {
  const { args } = buildCommand(project(), stateWith({ agent: "claude", id: "sess-1", via: "hook" }), "claude");

  const prompt = args.at(-1);
  assert.ok(typeof prompt === "string" && prompt.length > 0, "expected an opening prompt");
  assert.match(prompt, /handoff/i);
});

test("the opening prompt carries no delta, because the hook already delivered it", () => {
  const dir = project();
  const { args } = buildCommand(dir, stateWith({ agent: "claude", id: "sess-1", via: "hook" }), "claude");

  // The failure this forecloses is not a crash: it is the handoff appearing twice
  // in one conversation, once as context and once as a message, which reads as two
  // separate deliveries and invites the agent to act on it twice.
  const prompt = String(args.at(-1));
  assert.ok(prompt.length < 200, `opening prompt should be a nudge, not a payload (got ${prompt.length} chars)`);
  assert.doesNotMatch(prompt, /DELTA|Summary|Decisions/);
});

test("resuming with nothing pending does not inject a prompt", () => {
  // Running `bridge claude` by hand must not auto-submit anything. A prompt that
  // fires without a handoff would put words in the user's mouth on every resume.
  const { args } = buildCommand(project(), stateWith(null), "claude");

  assert.deepEqual(args, ["--resume", "sess-1"]);
});

test("a handoff aimed at another agent does not wake this one", () => {
  const { args } = buildCommand(project(), stateWith({ agent: "codex", id: "other", via: "hook" }), "claude");

  assert.deepEqual(args, ["--resume", "sess-1"]);
});

test("the prompt-injecting path is untouched, so nothing is delivered twice", () => {
  // Codex still receives the delta itself; the kickoff is only for agents whose
  // context arrives out of band.
  const dir = project();
  const s = defaultState();
  s.agents.codex = { id: "thread-9", transcriptPath: path.join(dir, "rollout.jsonl") };
  s.pendingInjection = { agent: "codex", id: "thread-9", via: "prompt" };

  const { args } = buildCommand(dir, s, "codex");
  assert.ok(!args.includes("A context-bridge handoff has been delivered into this session. Read it and continue the work it describes."));
});

test("a prompt-injecting Codex session gets a kickoff when its context arrived by hook", () => {
  const dir = project();
  const s = defaultState();
  s.agents.codex = { id: "thread-9", transcriptPath: path.join(dir, "rollout.jsonl") };
  s.pendingInjection = { agent: "codex", id: "thread-9", via: "hook" };

  const { args } = buildCommand(dir, s, "codex");
  assert.deepEqual(args.slice(0, 2), ["resume", "thread-9"]);
  assert.deepEqual(args.slice(2), [
    "--",
    "A context-bridge handoff has been delivered into this session. Read it and continue the work it describes.",
  ]);
});
