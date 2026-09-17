import test from "node:test";
import { ensureRuntimeStore } from "../src/storage.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { bridgeDir } from "../src/state.mjs";
import { loadConfig, saveArgs, clearArgs, savedArgs, resolveArgs, isDangerous } from "../src/config.mjs";

test("concurrent config clear and save preserve the other agent in Git-less global storage", { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-race-"));
  const project = path.join(root, "project"); fs.mkdirSync(project);
  const env = { ...process.env, CONTEXT_BRIDGE_HOME: path.join(root, "runtime"), CONTEXT_BRIDGE_STORAGE: "", PATH: "" };
  const configModule = new URL("../src/config.mjs", import.meta.url).href;
  const stateModule = new URL("../src/state.mjs", import.meta.url).href;
  const setup = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {saveArgs} from ${JSON.stringify(configModule)};
    import {bridgeDir} from ${JSON.stringify(stateModule)};
    saveArgs(process.cwd(),'claude',['--model','original']); console.log(bridgeDir(process.cwd()));
  `], { cwd: project, env, encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);
  const file = path.join(setup.stdout.trim(), "config.json");
  const ready = path.join(root, "ready"), release = path.join(root, "release");
  const blocked = path.join(root, "blocked"), done = path.join(root, "done");
  const children = [];
  t.after(async () => {
    for (const { child, close } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await close;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const start = (body) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs'; import {saveArgs,clearArgs} from ${JSON.stringify(configModule)};
      ${body}
    `], { cwd: project, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
    const close = new Promise((resolve) => child.once("close", (code) => resolve({ code, stderr })));
    children.push({ child, close }); return close;
  };
  const until = async (predicate) => {
    const deadline = Date.now() + 7000;
    while (!predicate()) { assert.ok(Date.now() < deadline, "fixture barrier timed out"); await delay(10); }
  };
  const a = start(`
    const read=fs.readFileSync, open=fs.openSync; let reads=0, configFd;
    fs.openSync=function(name,...args){const fd=open.call(fs,name,...args);
      if(name===${JSON.stringify(file)})configFd=fd; return fd;};
    fs.readFileSync=function(name,...args){const result=read.call(fs,name,...args);
      if((name===${JSON.stringify(file)} || (typeof name==='number' && name===configFd)) && ++reads===2){
        fs.writeFileSync(${JSON.stringify(ready)},'ready');
        const end=Date.now()+7000;
        while(!fs.existsSync(${JSON.stringify(release)})){ if(Date.now()>end)throw new Error('release timed out'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); }
      } return result;};
    clearArgs(process.cwd(),'claude');
  `);
  await until(() => fs.existsSync(ready));
  const b = start(`
    import {observeKernelContention} from ${JSON.stringify(new URL("./helpers/observe-kernel-contention.mjs", import.meta.url).href)};
    observeKernelContention(() => fs.writeFileSync(${JSON.stringify(blocked)}, 'kernel waiting'));
    const open=fs.openSync;
    fs.openSync=function(name,...args){try{return open.call(fs,name,...args);}catch(error){
      if(String(name).endsWith('state.json.lock') && error.code==='EEXIST')fs.writeFileSync(${JSON.stringify(blocked)},'waiting'); throw error;}};
    saveArgs(process.cwd(),'codex',['--model','new']); fs.writeFileSync(${JSON.stringify(done)},'done');
  `);
  await until(() => fs.existsSync(blocked) || fs.existsSync(done));
  fs.writeFileSync(release, "go");
  for (const result of [await a, await b]) assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.agents.claude, undefined);
  assert.deepEqual(config.agents.codex.args, ["--model", "new"]);
  assert.deepEqual(fs.readdirSync(project), []);
});

test("unreadable config is not silently interpreted as empty", (t) => {
  const stat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    if (String(file).endsWith("config.json")) throw Object.assign(new Error("private details"), { code: "EACCES" });
    return stat.call(fs, file, ...args);
  });
  const project = fresh();
  assert.throws(() => loadConfig(project), error => {
    assert.equal(error.code, "BRIDGE_CONFIG_UNREADABLE");
    assert.equal(error.cause?.code, "EACCES");
    return true;
  });
});

test("a failed config flush preserves saved arguments and releases the writer lock", (t) => {
  const project = fresh();
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  saveArgs(project, "claude", ["--model", "previous"]);
  const file = path.join(bridgeDir(project), "config.json");
  const before = fs.readFileSync(file);
  const mock = t.mock.method(fs, "fsyncSync", () => { throw Object.assign(new Error("config flush failed"), { code: "EIO" }); });
  assert.throws(() => saveArgs(project, "codex", ["--model", "new"]), /config flush failed/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(bridgeDir(project), "state.json.lock")), false);
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes(".tmp-")), false);
  mock.mock.restore();
  saveArgs(project, "codex", ["--model", "new"]);
  assert.deepEqual(savedArgs(loadConfig(project), "claude"), ["--model", "previous"]);
  assert.deepEqual(savedArgs(loadConfig(project), "codex"), ["--model", "new"]);
});

test("expected bridge errors carry diagnostic context without changing their message", async () => {
  const { BridgeError } = await import("../src/util.mjs");
  const error = new BridgeError("cannot continue", {
    code: "fixture-failure",
    operation: "test operation",
    path: ".bridge/state.json",
    nextCommand: "bridge doctor",
  });
  assert.equal(error.message, "cannot continue");
  assert.deepEqual(
    { code: error.code, operation: error.operation, path: error.path, nextCommand: error.nextCommand },
    { code: "fixture-failure", operation: "test operation", path: ".bridge/state.json", nextCommand: "bridge doctor" }
  );
});

test("debug records redact content, secrets and personal paths", async () => {
  const { debugRecord } = await import("../src/util.mjs");
  const record = debugRecord("handoff", {
    prompt: "private conversation",
    token: "sk-live-secret",
    transcriptPath: "/Users/serdar/private/session.jsonl",
    operation: "prepare handoff",
    count: 3,
  });
  assert.equal(record.prompt, "[redacted]");
  assert.equal(record.token, "[redacted]");
  assert.equal(record.transcriptPath, "[redacted]");
  assert.equal(record.operation, "prepare handoff");
  assert.equal(record.count, 3);
});

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
  ensureRuntimeStore(project);
  fs.writeFileSync(path.join(bridgeDir(project), "config.json"), "{ not json");
  assert.throws(() => loadConfig(project), /not valid JSON/);
  const file = path.join(bridgeDir(project), "config.json");
  for (const value of [null, [], { version: 2, agents: {} }, { agents: [] }, { agents: { codex: { args: [null] } } }]) {
    const raw = JSON.stringify(value);
    fs.writeFileSync(file, raw);
    assert.throws(() => loadConfig(project), { expected: true });
    assert.throws(() => saveArgs(project, "codex", ["--model", "example"]), { expected: true });
    assert.throws(() => clearArgs(project, "codex"), { expected: true });
    assert.equal(fs.readFileSync(file, "utf8"), raw, "refusal preserves even unsupported future configuration");
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, metadata: { keep: true }, agents: {} }));
  saveArgs(project, "codex", ["--model", "example"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).metadata, { keep: true });
  const outside = path.join(project, "external-config.json");
  const raw = JSON.stringify({ version: 1, agents: { codex: { args: ["--model", "external-private-marker"] } } });
  fs.writeFileSync(outside, raw);
  for (const kind of ["symlink", "hardlink", "directory"]) {
    fs.rmSync(file, { recursive: true });
    if (kind === "symlink") fs.symlinkSync(outside, file);
    else if (kind === "hardlink") fs.linkSync(outside, file);
    else fs.mkdirSync(file);
    assert.throws(() => loadConfig(project), { code: "BRIDGE_CONFIG_UNREADABLE" });
    assert.throws(() => saveArgs(project, "codex", ["--model", "replacement"]), { code: "BRIDGE_CONFIG_UNREADABLE" });
    assert.throws(() => clearArgs(project, "codex"), { code: "BRIDGE_CONFIG_UNREADABLE" });
    const result = spawnSync(process.execPath, [path.resolve("bin/bridge.mjs"), "args"], {
      cwd: project, encoding: "utf8", env: process.env,
    });
    assert.equal(result.status, 1, kind);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("external-private-marker"));
    assert.equal(fs.readFileSync(outside, "utf8"), raw);
    if (kind === "symlink") fs.unlinkSync(file);
    else fs.rmSync(file, { recursive: true });
    fs.writeFileSync(file, "{}");
  }
  fs.unlinkSync(outside);
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

// Codex merges every hook source rather than letting one replace another, so the
// only wrong move when writing ours is discarding somebody else's.
test("installing Codex hooks preserves whatever was already in the file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexhome-"));
  fs.writeFileSync(
    path.join(home, "hooks.json"),
    JSON.stringify({
      description: "the user's own file",
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo theirs" }] }] },
    })
  );

  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const codex = await import(`../src/agents/codex.mjs?hooks=${home}`);
    codex.installHooks();
    const after = JSON.parse(fs.readFileSync(path.join(home, "hooks.json"), "utf8"));
    assert.equal(after.description, "the user's own file");
    assert.equal(after.hooks.SessionStart.length, 2, "theirs and ours, not ours alone");
    assert.match(after.hooks.SessionStart[0].hooks[0].command, /echo theirs/);

    codex.installHooks();
    const twice = JSON.parse(fs.readFileSync(path.join(home, "hooks.json"), "utf8"));
    assert.equal(twice.hooks.SessionStart.length, 2, "installing again must not pile up duplicates");
    for (const invalid of ['{"unfinished":', 'null', '[]', '{"hooks":{"SessionStart":{}}}', '{"hooks":{"SessionStart":[{"hooks":{}}]}}']) {
      fs.writeFileSync(path.join(home, "hooks.json"), invalid);
      assert.throws(() => codex.installHooks(), { code: "BRIDGE_CODEX_HOOKS_INVALID", expected: true });
      assert.equal(fs.readFileSync(path.join(home, "hooks.json"), "utf8"), invalid, "invalid user configuration must survive installation unchanged");
      const health = codex.installedHooks();
      assert.ok(health.error);
      assert.equal(health.present.length, 0);
      assert.equal(health.missing.length, 3);
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
