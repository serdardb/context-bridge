import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { splitLauncherArgs, filterAgentArgs } from "../src/agentargs.mjs";
import { buildCommand } from "../src/launcher.mjs";
import { defaultState, saveState, checkpointsDir } from "../src/state.mjs";

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
    assert.match(res.stdout, new RegExp(`Forwarding to claude: ${flag}`), `${flag} must not be intercepted`);
    assert.doesNotMatch(res.stdout, /Switch agents\. Not context\.\n\nUsage:/, "bridge help must not appear");
  }
});

test("--help and --version still belong to the bridge with no agent named", () => {
  assert.match(runBridge(["--version"]).stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.match(runBridge(["--help"]).stdout, /Usage:/);
});

test("a valueless flag typed before the agent name is still forwarded", () => {
  const res = runBridge(["--dangerously-skip-permissions", "claude"]);
  assert.match(res.stdout, /Forwarding to claude: --dangerously-skip-permissions/);
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
  assert.match(res.stdout, /bridge claude --model opus/);
});

function runBridge(args) {
  const project = makeProject();
  return spawnSync(process.execPath, [path.join(ROOT, "bin", "bridge.mjs"), ...args], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, PATH: "/nonexistent" }, // agents unreachable: we only assert on bridge's own output
  });
}

function makeProject() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-args-")));
}

// The duplication this pins was found by running the real command rather than a
// test: saving wrote the flag into the config and then also counted it as typed,
// so the very launch that saved it passed the flag twice.
test("the launch that saves a flag does not also pass it twice", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dup-"));
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, "bin", "bridge.mjs"), "codex", "--dangerously-bypass-approvals-and-sandbox", "--cb-save-args"],
    // PATH is emptied so the agent itself never starts; the launcher still prints
    // what it would have forwarded, which is the whole point of the check.
    { cwd: project, encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } }
  );
  const forwarding = res.stdout.split("\n").find((line) => line.includes("Forwarding to codex"));
  assert.ok(forwarding, `expected a forwarding line, got:\n${res.stdout}${res.stderr}`);
  const count = forwarding.split("--dangerously-bypass-approvals-and-sandbox").length - 1;
  assert.equal(count, 1, `the flag must appear once, got: ${forwarding}`);
});
