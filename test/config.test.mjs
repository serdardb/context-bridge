import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveArgs, clearArgs, savedArgs, resolveArgs, isDangerous } from "../src/config.mjs";

// The need is a moment, not a preference: you are working with approvals on and
// then decide, now, that this agent should stop asking. So flags are typed when
// the moment arrives and only become permanent when you say so.

test("a fresh project has no saved flags and does not mind", () => {
  const project = fresh();
  assert.deepEqual(loadConfig(project).agents, {});
  assert.deepEqual(savedArgs(loadConfig(project), "codex"), []);
});

test("saving is per agent, and a saved flag is used by later launches", () => {
  const project = fresh();
  saveArgs(project, "codex", ["--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(savedArgs(loadConfig(project), "codex"), ["--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(savedArgs(loadConfig(project), "claude"), [], "one agent's decision is not another's");
  assert.deepEqual(resolveArgs(project, "codex").all, ["--dangerously-bypass-approvals-and-sandbox"]);
});

test("what is typed now comes last, so the moment overrides the default", () => {
  const project = fresh();
  saveArgs(project, "codex", ["--model", "gpt-5"]);
  const { all } = resolveArgs(project, "codex", ["--model", "gpt-5.5"]);
  assert.deepEqual(all, ["--model", "gpt-5", "--model", "gpt-5.5"], "the CLI takes the last occurrence");
});

// A saved flag with no way to unsay it is a trap, which is why clearing exists
// and why `bridge status` lists what is saved.
test("clearing says what it removed, and clearing nothing is not an error", () => {
  const project = fresh();
  saveArgs(project, "grok", ["--some-flag"]);
  assert.deepEqual(clearArgs(project, "grok"), ["--some-flag"]);
  assert.deepEqual(savedArgs(loadConfig(project), "grok"), []);
  assert.deepEqual(clearArgs(project, "grok"), [], "clearing twice is harmless");
});

test("saving nothing is refused, because an empty save reads as a mistake", () => {
  const project = fresh();
  assert.throws(() => saveArgs(project, "codex", []), /Nothing to save/);
});

test("an unknown agent is refused by name", () => {
  const project = fresh();
  assert.throws(() => saveArgs(project, "gemini", ["--x"]), /Unknown agent/);
  assert.throws(() => clearArgs(project, "gemini"), /Unknown agent/);
});

// The refusal belongs where the flag is written, not at spawn time, when the
// reason would be far away from the cause.
test("a flag that would break the session link cannot be saved at all", () => {
  const project = fresh();
  assert.throws(() => saveArgs(project, "claude", ["--fork-session"]), /break the bridge's session link/);
  assert.throws(() => saveArgs(project, "codex", ["--last"]), /break the bridge's session link/);
  assert.deepEqual(savedArgs(loadConfig(project), "claude"), [], "nothing is written when the save is refused");
});

test("a corrupt config complains instead of silently discarding saved flags", () => {
  const project = fresh();
  fs.mkdirSync(path.join(project, ".bridge"), { recursive: true });
  fs.writeFileSync(path.join(project, ".bridge", "config.json"), "{ not json");
  assert.throws(() => loadConfig(project), /not valid JSON/);
});

// Changing the model and bypassing every approval both arrive through the same
// door, and only one of them should shout on the way in.
test("only the flags that change what an agent may do without asking are loud", () => {
  for (const arg of ["--dangerously-skip-permissions", "--yolo", "--full-auto", "--sandbox=danger-full-access"]) {
    assert.equal(isDangerous(arg), true, `${arg} must be announced`);
  }
  for (const arg of ["--model", "gpt-5.5", "--verbose", "--resume"]) {
    assert.equal(isDangerous(arg), false, `${arg} is ordinary and must stay quiet`);
  }
});

function fresh() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-"));
}
