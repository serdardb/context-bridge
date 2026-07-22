import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGENT_IDS, adapterFor } from "../src/agents/index.mjs";
import { defaultState, saveState, loadState } from "../src/state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_BIN = path.join(ROOT, "bin", "bridge.mjs");

// The bug these exist for, found by Antigravity reading two files side by side:
// `handoff.mjs` decided which agent was handing off by reading CODEX_THREAD_ID
// first, while `hooks.mjs` already carried a long comment explaining that the
// same variable is ambient session state and inherits into every child. So a
// launcher opened inside Codex handed it to every agent it spawned, and a handoff
// from Grok packed Codex's stream and moved Codex's watermark.

test("an agent the launcher started is never mistaken for the agent that spawned it", () => {
  const project = linkedProject({ activeAgent: "grok" });
  const source = detectVia(project, "claude", {
    CONTEXT_BRIDGE_LAUNCHER: "1",
    CODEX_THREAD_ID: "019f-inherited-from-the-terminal",
  });
  assert.equal(source, "grok", "the launcher knows who it started; a leaked variable does not");
  assert.notEqual(source, "codex", "this is the leak itself, and it packed the wrong agent's history");
});

// The order is the actual fix, so it is asserted on its own: even a marker that
// IS trustworthy loses to the launcher's own record, because the record is a fact
// and every environment marker is at best an inference.
test("under the launcher, its record outranks even a legitimate marker", () => {
  const project = linkedProject({ activeAgent: "grok" });
  const source = detectVia(project, "codex", { CONTEXT_BRIDGE_LAUNCHER: "1", CLAUDECODE: "1" });
  assert.equal(source, "grok");
});

test("without a launcher, a bare session is still identified from its environment", () => {
  const project = linkedProject({ activeAgent: null });
  assert.equal(detectVia(project, "antigravity", { CLAUDECODE: "1" }), "claude");
});

// Ambient markers are the trap, so an adapter may only claim one its agent sets
// per process. Codex has none, and saying so is the honest state rather than the
// convenient one.
test("no adapter claims an inherited session variable as proof of itself", () => {
  const inherited = { CODEX_THREAD_ID: "019f-thread", GROK_HOOK_EVENT: "PreToolUse", ANTIGRAVITY_HOME: "/tmp/x" };
  for (const id of AGENT_IDS) {
    assert.equal(typeof adapterFor(id).detectHost, "function", `${id} must answer the host question`);
    assert.equal(
      adapterFor(id).detectHost(inherited),
      null,
      `${id} claimed the environment on a variable that inherits into every child`
    );
  }
});

test("Claude is claimed only by its own marker, and by nothing else", () => {
  assert.equal(adapterFor("claude").detectHost({ CLAUDECODE: "1" }), "claude");
  assert.equal(adapterFor("claude").detectHost({}), null);
});

// Belt and braces: the ordering makes the leak unreachable, and this makes the
// variable itself absent. Either alone would fix today's bug; both together mean
// a mistake in one of them is not immediately a wrong-agent handoff.
test("the launcher does not pass its own session's identity down to the child", async () => {
  const { childEnv } = await import("../src/launcher.mjs");
  const before = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = "019f-leaked";
  try {
    const env = childEnv();
    assert.equal(env.CODEX_THREAD_ID, undefined, "it inherits into every child unless we remove it");
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CONTEXT_BRIDGE_LAUNCHER, "1", "and the child must still know it was launched");
  } finally {
    if (before === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = before;
  }
});

/**
 * Runs a real handoff and reports which agent the bridge decided was speaking.
 *
 * The decision is read from the delta's own filename, `<source>-to-<target>.md`,
 * which is the bridge's own record of the pairing rather than anything the test
 * arranges. Going through the real command matters here: the leak was reachable
 * only because a process inherited an environment, and nothing short of spawning
 * one reproduces that.
 */
function detectVia(project, target, env) {
  const res = spawnSync(process.execPath, [BRIDGE_BIN, "handoff", target, "--decisions", "d", "--next", "n"], {
    cwd: project,
    encoding: "utf8",
    env: { ...clean(), ...env },
  });
  // Read through loadState: tests must not be coupled to the on-disk shape.
  const state = loadState(project);
  const rel = state.pendingInjection?.deltaFile;
  assert.ok(rel, `no handoff was prepared: ${res.stderr || res.stdout}`);
  const pairing = path.basename(rel, ".md").match(new RegExp(`(${AGENT_IDS.join("|")})-to-${target}$`));
  assert.ok(pairing, `the delta name did not record a pairing: ${rel}`);
  return pairing[1];
}

function linkedProject({ activeAgent }) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-source-"));
  const state = defaultState(project);
  state.activeAgent = activeAgent;
  for (const id of ["claude", "grok"]) {
    const transcript = path.join(project, `${id}.jsonl`);
    fs.writeFileSync(transcript, JSON.stringify(sampleRow(id)) + "\n");
    state.agents[id] = { id: `019f-${id}`, transcriptPath: transcript, mark: null, idle: false };
  }
  saveState(project, state);
  return project;
}

function sampleRow(id) {
  if (id === "claude") return { type: "user", timestamp: "2026-07-21T00:00:00Z", message: { content: "hi" } };
  return { type: "user", content: "hi" };
}

function clean() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|GROK_|CODEX_|CONTEXT_BRIDGE_)/.test(key)) delete env[key];
  }
  return env;
}
