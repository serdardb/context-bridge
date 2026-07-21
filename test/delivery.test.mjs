import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultState, saveState, loadState, checkpointsDir } from "../src/state.mjs";
import { hookBody, HOOK_DELTA_BYTES, deltaWasConsumed, hookDeliveryEligible } from "../src/delivery.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_BIN = path.join(ROOT, "bin", "bridge.mjs");

// A hook can put a delta straight into Codex's own conversation, but only if the
// user trusted hooks once and has not withdrawn it, and neither fact is readable.
// So the road is chosen in advance, recorded, and then checked afterwards.

test("a delta routed to the hook is delivered in the shape Codex reads", () => {
  const { project, deltaFile } = pendingDelta("hook", "DELTA BODY: what claude did");
  fs.writeFileSync(path.join(project, "rollout.jsonl"), "");

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start", "--agent", "codex"], {
    input: JSON.stringify({
      cwd: project,
      source: "resume",
      session_id: "019f-codex",
      transcript_path: path.join(project, "rollout.jsonl"),
    }),
    encoding: "utf8",
    env: cleanEnv(),
  });

  assert.equal(res.status, 0);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(payload.hookSpecificOutput.additionalContext, /DELTA BODY/);
  assert.equal(loadState(project).pendingInjection, null, "a delivered delta is no longer pending");
  assert.ok(fs.existsSync(path.join(project, deltaFile + ".consumed")), "the rename is what makes it exactly once");
});

test("a second hook run delivers nothing, because the first one already claimed it", () => {
  const { project } = pendingDelta("hook", "DELTA BODY");
  fs.writeFileSync(path.join(project, "rollout.jsonl"), "");
  const run = () =>
    spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start", "--agent", "codex"], {
      input: JSON.stringify({ cwd: project, source: "resume", session_id: "019f-codex", transcript_path: path.join(project, "rollout.jsonl") }),
      encoding: "utf8",
      env: cleanEnv(),
    });

  assert.match(run().stdout, /DELTA BODY/);
  assert.equal(run().stdout, "", "the delta must not arrive twice");
});

// The two roads are exclusive by construction. Injecting through a hook while the
// resume command also carries the delta would repeat it word for word.
test("a delta routed to the hook never rides in the resume command as well", async () => {
  const { project } = pendingDelta("hook", "DELTA BODY");
  const { buildCommand } = await import("../src/launcher.mjs");
  const { args } = buildCommand(project, loadState(project), "codex", []);
  assert.ok(!args.join(" ").includes("DELTA BODY"), "the hook owns this one");
  assert.equal(loadState(project).pendingInjection?.via, "hook", "and the pending delta is still waiting for it");
});

test("a delta routed to the prompt still rides in the resume command", async () => {
  const { project } = pendingDelta("prompt", "DELTA BODY");
  const { buildCommand } = await import("../src/launcher.mjs");
  const { args } = buildCommand(project, loadState(project), "codex", []);
  assert.ok(args.join(" ").includes("DELTA BODY"), "nothing else is going to deliver it");
});

// Eligibility is not proof. Hooks that were never run here, or were run long ago,
// say nothing about whether trust is still granted today.
test("hook delivery is only considered when hooks are installed and have run recently", () => {
  const never = hookDeliveryEligible("codex", { hookSeen: null });
  assert.equal(never, false, "a hook that never ran here is not evidence of anything");

  const ancient = hookDeliveryEligible("codex", { hookSeen: "2020-01-01T00:00:00.000Z" });
  assert.equal(ancient, false, "a stamp from years ago says nothing about today");

  assert.equal(hookDeliveryEligible("grok", { hookSeen: new Date().toISOString() }), false, "Grok has no hook delivery at all");
});

// Whatever is trimmed has to stay reachable, or the trim becomes a quiet loss.
test("an oversized delta is trimmed and always names the file holding the rest", () => {
  const long = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
  const body = hookBody(long, ".bridge/checkpoints/x-full.md");
  assert.ok(Buffer.byteLength(body) <= HOOK_DELTA_BYTES, "it has to fit the budget it claims");
  assert.match(body, /trimmed to fit/);
  assert.match(body, /x-full\.md/, "the rest must be findable");

  const short = hookBody("two words", ".bridge/checkpoints/x-full.md");
  assert.doesNotMatch(short, /trimmed to fit/, "a delta that fits is not announced as cut");
  assert.match(short, /x-full\.md/);
});

// Consumption renames the file, so the disk is the truth even when a hook and the
// launcher raced to write state.
test("consumption is read from the file on disk, not from what state remembers", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-consumed-"));
  fs.mkdirSync(checkpointsDir(project), { recursive: true });
  const rel = path.join(".bridge", "checkpoints", "d.md");
  fs.writeFileSync(path.join(project, rel), "delta");

  assert.equal(deltaWasConsumed(project, { deltaFile: rel }), false);
  fs.renameSync(path.join(project, rel), path.join(project, rel + ".consumed"));
  assert.equal(deltaWasConsumed(project, { deltaFile: rel }), true);
});

function pendingDelta(via, body) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-delivery-"));
  fs.mkdirSync(checkpointsDir(project), { recursive: true });
  const name = "2026-07-21T09-00-00-000Z-claude-to-codex.md";
  const rel = path.join(".bridge", "checkpoints", name);
  fs.writeFileSync(path.join(project, rel), body);
  fs.writeFileSync(path.join(project, rel.replace(".md", "-full.md")), "the untrimmed version");

  const state = defaultState(project);
  state.agents.codex = {
    id: "019f-codex",
    transcriptPath: path.join(project, "rollout.jsonl"),
    mark: null,
    idle: false,
    hookSeen: new Date().toISOString(),
  };
  state.pendingInjection = { agent: "codex", id: "019f-codex", via, deltaFile: rel, createdAt: new Date().toISOString(), sources: {} };
  saveState(project, state);
  return { project, deltaFile: rel };
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|GROK_|CODEX_)/.test(key)) delete env[key];
  }
  return env;
}

// Codex's Stop hook already reports the end of a turn, so the launcher no longer
// has to infer it by re-reading a 3MB transcript twice a second looking for a
// vendor-specific completion record.
test("a turn that the hook reported as ended needs no transcript read at all", async () => {
  const { turnHasEnded } = await import("../src/launcher.mjs");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-idle-"));
  const rollout = path.join(project, "rollout.jsonl");
  fs.writeFileSync(rollout, ""); // deliberately empty: parsing would say "not idle"

  const state = defaultState(project);
  state.agents.codex = { id: "019f-x", transcriptPath: rollout, mark: null, idle: true };
  const pending = { target: "grok", ready: true, requestedAt: new Date().toISOString() };

  assert.equal(turnHasEnded(project, state, "codex", pending), true, "the marker is the answer");
});

// Hooks do not run until they are trusted. A launcher that listened only for the
// marker would wait for a switch that can never come.
test("without a marker the transcript still decides, either way", async () => {
  const { turnHasEnded } = await import("../src/launcher.mjs");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-idle-fallback-"));
  const rollout = path.join(project, "rollout.jsonl");
  fs.writeFileSync(rollout, "");

  const state = defaultState(project);
  state.agents.codex = { id: "019f-x", transcriptPath: rollout, mark: null, idle: false };
  const pending = { target: "grok", ready: true, requestedAt: "2026-07-21T09:00:00.000Z" };
  assert.equal(turnHasEnded(project, state, "codex", pending), false, "nothing has finished yet");

  fs.writeFileSync(
    rollout,
    JSON.stringify({ timestamp: "2026-07-21T09:00:01.000Z", type: "event_msg", payload: { type: "task_complete" } }) + "\n"
  );
  assert.equal(turnHasEnded(project, state, "codex", pending), true, "the transcript answers when the hook cannot");
});

test("an agent with no linked session is never assumed to have finished", async () => {
  const { turnHasEnded } = await import("../src/launcher.mjs");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-idle-unlinked-"));
  const state = defaultState(project);
  const pending = { target: "grok", ready: true, requestedAt: new Date().toISOString() };
  assert.equal(turnHasEnded(project, state, "codex", pending), false);
});
