import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { splitLauncherArgs, filterAgentArgs } from "../src/agentargs.mjs";
import { buildCommand } from "../src/launcher.mjs";
import { defaultState, saveState, loadState, checkpointsDir } from "../src/state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("agent flags pass through verbatim, including values and repeated flags", () => {
  const args = [
    "--dangerously-skip-permissions",
    "--model",
    "claude-fable-5",
    "-d",
    "api,hooks",
    "--disallowedTools",
    "Bash(git *)",
    "Edit",
    "--json-schema",
    '{"type":"object"}',
  ];
  assert.deepEqual(splitLauncherArgs(args).agentArgs, args);
  assert.deepEqual(filterAgentArgs("claude", args), { kept: args, dropped: [] });
});

test("the --cb-* namespace is reserved and rejected instead of silently dropped", () => {
  assert.throws(() => splitLauncherArgs(["--cb-nonsense"]), /reserved for context-bridge/);
  assert.doesNotThrow(() => splitLauncherArgs(["--cbor"]));
});

test("the bridge's own flags are claimed rather than forwarded to the agent", () => {
  // --cb-save-args is a flag about the flags, so handing it to the agent would
  // make the agent fail on an argument it never defined.
  const save = splitLauncherArgs(["--dangerously-skip-permissions", "--cb-save-args"]);
  assert.deepEqual(save.agentArgs, ["--dangerously-skip-permissions"]);
  assert.equal(save.bridgeFlags.saveArgs, true);

  const clear = splitLauncherArgs(["--cb-clear-args"]);
  assert.deepEqual(clear.agentArgs, []);
  assert.equal(clear.bridgeFlags.clearArgs, true);
});

test("claude session-control flags are dropped with a reason, values included", () => {
  const { kept, dropped } = filterAgentArgs("claude", [
    "--model",
    "opus",
    "-c",
    "--resume",
    "other-session-id",
    "--fork-session",
    "--no-session-persistence",
  ]);
  assert.deepEqual(kept, ["--model", "opus"]);
  assert.deepEqual(
    dropped.filter((d) => !d.isValue).map((d) => d.arg),
    ["-c", "--resume", "--fork-session", "--no-session-persistence"]
  );
  assert.ok(dropped.some((d) => d.arg === "other-session-id" && d.isValue), "flag values go with the flag");
  assert.match(dropped[0].why, /linked session/);
});

test("codex resume-control flags are dropped, safe flags survive", () => {
  const { kept, dropped } = filterAgentArgs("codex", [
    "--last",
    "-C",
    "/tmp/elsewhere",
    "--model",
    "gpt-5.5",
    "--sandbox",
    "workspace-write",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  assert.deepEqual(kept, [
    "--model",
    "gpt-5.5",
    "--sandbox",
    "workspace-write",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  assert.deepEqual(
    dropped.filter((d) => !d.isValue).map((d) => d.arg),
    ["--last", "-C"]
  );
  // Reproduced live: `codex resume --last <id> "prompt"` fails to parse.
  assert.match(dropped[0].why, /--last together with the delta prompt/);
});

test("--flag=value form is dropped as one token", () => {
  const { kept, dropped } = filterAgentArgs("codex", ["--cd=/tmp/elsewhere", "--model=gpt-5.5"]);
  assert.deepEqual(kept, ["--model=gpt-5.5"]);
  assert.deepEqual(dropped.map((d) => d.arg), ["--cd=/tmp/elsewhere"]);
});

test("buildCommand puts the bridge's own --resume last so it wins", () => {
  const project = makeProject();
  const s = defaultState(project);
  s.agents.claude.id = "linked-session";
  const { cmd, args } = buildCommand(project, s, "claude", ["--dangerously-skip-permissions"]);
  assert.equal(cmd, "claude");
  assert.deepEqual(args, ["--dangerously-skip-permissions", "--resume", "linked-session"]);
});

test("buildCommand shields the codex delta behind -- so variadic flags cannot swallow it", () => {
  const project = makeProject();
  fs.mkdirSync(checkpointsDir(project), { recursive: true });
  fs.writeFileSync(path.join(checkpointsDir(project), "delta.md"), "[Bridge Context Update]");

  const s = defaultState(project);
  s.agents.codex.id = "linked-thread";
  s.pendingInjection = {
    agent: "codex",
    id: "linked-thread",
    deltaFile: path.join(".bridge", "checkpoints", "delta.md"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  saveState(project, s);

  const { cmd, args } = buildCommand(project, s, "codex", ["-i", "shot.png"]);
  assert.equal(cmd, "codex");
  assert.deepEqual(args, ["resume", "linked-thread", "-i", "shot.png", "--", "[Bridge Context Update]"]);
});

test("--help and --version reach the agent once an agent is named", () => {
  for (const flag of ["--help", "--version"]) {
    const res = runBridge(["claude", flag]);
    assert.deepEqual(res.agentArgs, [flag], `${flag} must not be intercepted`);
    assert.doesNotMatch(res.stdout, /Switch agents\. Not context\.\n\nUsage:/, "bridge help must not appear");
  }
});

test("--help and --version still belong to the bridge with no agent named", () => {
  assert.match(runBridge(["--version"]).stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.match(runBridge(["--help"]).stdout, /Usage:/);
});

test("a valueless flag typed before the agent name is still forwarded", () => {
  const res = runBridge(["--dangerously-skip-permissions", "claude"]);
  assert.deepEqual(res.agentArgs, ["--dangerously-skip-permissions"]);
  assert.match(res.stdout, /change approval or sandbox permissions/);
});

test("a value-taking flag before the agent name errors instead of losing the value", () => {
  // The bridge cannot know which agent flags take values, so 'claude-fable-5'
  // reads as the command. Better to say so than to guess or drop it.
  const res = runBridge(["--model", "claude-fable-5", "claude"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /name the agent first/);
});

test("a stray flag value without an agent name explains itself", () => {
  const res = runBridge(["--model", "opus"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /name the agent first/);
  assert.match(res.stdout, /bridge claude <agent arguments>/);
  assert.doesNotMatch(res.stdout + res.stderr, /opus/);
});

function runBridge(args, project = makeProject()) {
  if (args[0] === "codex" && !loadState(project)) {
    const state = defaultState(project);
    state.agents.codex.id = "fixture-thread";
    saveState(project, state);
  }
  const bin = path.join(project, "fixture-bin");
  fs.mkdirSync(bin, { recursive: true });
  const capture = path.join(project, "argv.json");
  fs.rmSync(capture, { force: true });
  for (const agent of ["claude", "codex"]) {
    fs.writeFileSync(path.join(bin, agent), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  }
  const res = spawnSync(process.execPath, [path.join(ROOT, "bin", "bridge.mjs"), ...args], {
    cwd: project,
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, PATH: bin },
  });
  assert.ifError(res.error);
  res.agentArgs = fs.existsSync(capture) ? JSON.parse(fs.readFileSync(capture, "utf8")) : null;
  return res;
}

function makeProject() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-args-")));
}

// The duplication this pins was found by running the real command rather than a
// test: saving wrote the flag into the config and then also counted it as typed,
// so the very launch that saved it passed the flag twice.
test("the launch that saves a flag does not also pass it twice", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dup-"));
  const res = runBridge(["codex", "--dangerously-bypass-approvals-and-sandbox", "--cb-save-args"], project);
  assert.deepEqual(res.agentArgs, ["resume", "fixture-thread", "--dangerously-bypass-approvals-and-sandbox"], res.stdout + res.stderr);
});

test("bridge output hides arbitrary argument values while the child receives them unchanged", () => {
  const project = makeProject();
  const secrets = ["PRIVATE_SEPARATE", "PRIVATE_INLINE", "PRIVATE_URL", "PRIVATE_POSITIONAL", "PRIVATE_PERMISSION"];
  const args = ["--api-key", secrets[0], `--custom=${secrets[1]}`, `https://user:${secrets[2]}@example.invalid/`, secrets[3], `--sandbox=${secrets[4]}`];
  const launch = runBridge(["codex", ...args, "--cb-save-args"], project);
  assert.deepEqual(launch.agentArgs, ["resume", "fixture-thread", ...args], launch.stdout + launch.stderr);
  for (const secret of secrets) assert.ok(!(launch.stdout + launch.stderr).includes(secret), "private argument leaked into bridge output");
  const status = runBridge(["status"], project);
  assert.match(status.stdout, /6 arguments \(values hidden\)/);
  const clear = runBridge(["codex", "--cb-clear-args"], project);
  assert.deepEqual(clear.agentArgs, ["resume", "fixture-thread"]);
  for (const result of [launch, status, clear]) {
    for (const secret of secrets) assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
  for (const tail of [["--cd=PRIVATE_CONFLICT"], ["--cd=PRIVATE_CONFLICT", "--cb-save-args"], ["--cb-PRIVATE_CONFLICT"]]) {
    const result = runBridge(["codex", ...tail]);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_CONFLICT/);
  }
});

// Enforcement reads each adapter's own conflictFlags, not a second table that can
// drift from it. A duplicate table here once did drift: OpenCode's declared
// conflicts were half-enforced and Grok's and Antigravity's, seven and four
// flags that break the bridge's session link, were not enforced at all. This
// walks every agent and proves the first flag it declares is actually dropped.
test("every agent's own declared conflict flags are the ones enforced", async () => {
  const { AGENT_IDS, adapterFor } = await import("../src/agents/index.mjs");
  for (const agent of AGENT_IDS) {
    const rules = adapterFor(agent).conflictFlags ?? [];
    assert.ok(rules.length, `${agent} declares no conflict flags to enforce`);
    for (const rule of rules) {
      const flag = rule.flags[0];
      // The flag alone, so a `required`/`optional` value rule cannot swallow a
      // probe arg placed after it and confuse the assertion.
      const dropped = filterAgentArgs(agent, [flag]).dropped;
      assert.ok(
        dropped.some((d) => d.arg === flag),
        `${agent} ${flag} is declared a conflict but not enforced`
      );
    }
    // And an unrelated flag is never touched.
    assert.deepEqual(filterAgentArgs(agent, ["--a-flag-the-bridge-does-not-manage"]).kept, [
      "--a-flag-the-bridge-does-not-manage",
    ]);
  }
});
