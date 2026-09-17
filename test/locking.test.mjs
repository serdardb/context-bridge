import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { withKernelLockSync } from "../src/locking.mjs";

test("kernel guard survives callback failure, rejects unsafe files and refuses recursion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-kernel-lock-"));
  const lock = path.join(root, "guard");
  try {
    assert.throws(() => withKernelLockSync(lock, () => { throw new Error("callback failed"); }), /callback failed/);
    assert.ok(fs.existsSync(lock), "guard identity must persist after release");
    const ino = fs.statSync(lock).ino;
    withKernelLockSync(lock, () => {
      assert.throws(() => withKernelLockSync(lock, () => {}), /Recursive kernel lock/);
    });
    assert.equal(fs.statSync(lock).ino, ino);
    const alias = path.join(root, "alias");
    fs.linkSync(lock, alias);
    assert.throws(() => withKernelLockSync(lock, () => assert.fail("hardlinked guard entered")), /Unsafe kernel lock/);
    fs.unlinkSync(alias);
    if (process.platform !== "win32") {
      fs.symlinkSync(lock, alias);
      assert.throws(() => withKernelLockSync(alias, () => assert.fail("symlink guard entered")), /Unsafe kernel lock/);
    }
    withKernelLockSync(lock, () => {});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("kernel guard recovers from a real killed owner without replacing its file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-kernel-kill-"));
  const lock = path.join(root, "guard"), ready = path.join(root, "ready");
  const module = new URL("../src/locking.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import {withKernelLockSync} from ${JSON.stringify(module)};
    withKernelLockSync(${JSON.stringify(lock)}, () => {
      fs.writeFileSync(${JSON.stringify(ready)}, 'held');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
    });
  `], {stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready)) {
      assert.ok(Date.now() < deadline && child.exitCode === null, stderr || 'holder failed to start');
      await delay(10);
    }
    const inode = fs.statSync(lock).ino;
    const contender = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import {observeKernelContention} from ${JSON.stringify(new URL('./helpers/observe-kernel-contention.mjs', import.meta.url).href)};
      import {withKernelLockSync} from ${JSON.stringify(module)};
      observeKernelContention(() => process.exit(0));
      withKernelLockSync(${JSON.stringify(lock)}, () => process.exit(2));
    `], {stdio: ['ignore', 'ignore', 'pipe']});
    let error = ''; contender.stderr.on('data', data => { error += data; });
    const result = new Promise(resolve => contender.once('close', code => resolve(code)));
    const timer = setTimeout(() => contender.kill('SIGKILL'), 5000);
    try { assert.equal(await result, 0, error); } finally { clearTimeout(timer); }
    child.kill('SIGKILL');
    await closed;
    withKernelLockSync(lock, () => assert.equal(fs.statSync(lock).ino, inode));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("stale state recovery cannot overtake another writer and both updates survive", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-stale-kernel-"));
  const project = path.join(root, "project"); fs.mkdirSync(project);
  const env = { ...process.env, PATH: "", CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_HOME: path.join(root, "home") };
  const stateModule = new URL("../src/state.mjs", import.meta.url).href;
  const ready = path.join(root, "ready"), release = path.join(root, "release"), blocked = path.join(root, "blocked");
  const bEntered = path.join(root, "b-entered");
  const children = [];
  const start = (body) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs'; import {mutateState} from ${JSON.stringify(stateModule)};
      const waitFor = file => {
        const end = Date.now() + 10000;
        while (!fs.existsSync(file)) {
          if (Date.now() > end) throw new Error('barrier timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      };
      ${body}
    `], { cwd: project, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", data => { stderr += data; });
    const closed = new Promise(resolve => child.once("close", code => resolve({code, stderr})));
    children.push({child, closed}); return closed;
  };
  const until = async predicate => {
    const end = Date.now() + 7000;
    while (!predicate()) {
      assert.ok(Date.now() < end, "writer failed to reach barrier");
      await delay(10);
    }
  };
  try {
    const setup = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {ensureState,statePath} from ${JSON.stringify(stateModule)};
      ensureState(process.cwd()); console.log(statePath(process.cwd()));
    `], {cwd: project, env, encoding: "utf8", timeout: 10000});
    assert.equal(setup.status, 0, setup.stderr);
    const file = setup.stdout.trim(), lock = file + ".lock";
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(dead.status, 0);
    assert.throws(() => process.kill(dead.pid, 0), {code: "ESRCH"});
    fs.writeFileSync(lock, String(dead.pid));
    const a = start(`
      const rename = fs.renameSync;
      fs.renameSync = (source, destination) => {
        if (source === ${JSON.stringify(lock)}) {
          fs.writeFileSync(${JSON.stringify(ready)}, 'stale observed');
          waitFor(${JSON.stringify(release)});
        }
        return rename(source, destination);
      };
      mutateState(process.cwd(), 'main', state => { state.writerA = true; });
    `);
    await until(() => fs.existsSync(ready));
    const b = start(`
      import {observeKernelContention} from ${JSON.stringify(new URL("./helpers/observe-kernel-contention.mjs", import.meta.url).href)};
      observeKernelContention(() => fs.writeFileSync(${JSON.stringify(blocked)}, 'kernel denied ownership'));
      mutateState(process.cwd(), 'main', state => {
        fs.writeFileSync(${JSON.stringify(bEntered)}, 'entered');
        state.writerB = true;
      });
    `);
    // Observe actual kernel denial, not a guessed delay while B may not be running.
    await until(() => fs.existsSync(blocked) || fs.existsSync(bEntered));
    assert.equal(fs.existsSync(bEntered), false, "B must not recover the PID lock while A owns the kernel guard");
    assert.ok(fs.existsSync(blocked));
    fs.writeFileSync(release, "resume");
    for (const result of [await a, await b]) assert.equal(result.code, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(file));
    assert.equal(state.writerA, true);
    assert.equal(state.writerB, true);
    assert.equal(fs.existsSync(lock), false);
    assert.ok(fs.existsSync(lock + ".guard"));
    assert.deepEqual(fs.readdirSync(project), []);
  } finally {
    for (const {child, closed} of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    fs.rmSync(root, {recursive: true, force: true});
  }
});
