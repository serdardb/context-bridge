import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

test("stale import recovery cannot unlink a concurrent importer's lock", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-import-stale-"));
  const project = path.join(root, "project"), source = path.join(root, "source");
  fs.mkdirSync(project); fs.mkdirSync(source);
  const env = { ...process.env, PATH: "", CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_HOME: path.join(root, "store") };
  const artifactModule = new URL("../src/artifact.mjs", import.meta.url).href;
  const stateModule = new URL("../src/state.mjs", import.meta.url).href;
  const storageModule = new URL("../src/storage.mjs", import.meta.url).href;
  const file = path.join(root, "context.cbctx");
  const ready = path.join(root, "ready"), release = path.join(root, "release"), blocked = path.join(root, "blocked"), entered = path.join(root, "entered");
  const children = [];
  const start = (script) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: project, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
    const done = new Promise((resolve) => child.once("close", (code) => resolve({ code, stderr })));
    children.push({ child, done }); return done;
  };
  const until = async (predicate) => {
    const end = Date.now() + 7000;
    while (!predicate()) { assert.ok(Date.now() < end, "import barrier timed out"); await delay(10); }
  };
  try {
    const setup = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import crypto from 'node:crypto';
      import {ensureState, writeCheckpoint, statePath, checkpointsDir} from ${JSON.stringify(stateModule)};
      import {projectIdentity} from ${JSON.stringify(storageModule)};
      import {exportArtifact} from ${JSON.stringify(artifactModule)};
      ensureState(${JSON.stringify(source)}); ensureState(process.cwd());
      writeCheckpoint(${JSON.stringify(source)}, 'main', '2026-09-17T00-00-00-000Z-claude-to-codex-full.md', 'preserve this evidence');
      exportArtifact(${JSON.stringify(source)}, ${JSON.stringify(file)});
      const key = crypto.createHash('sha256').update(JSON.stringify({lane:'main', project:projectIdentity(process.cwd()).id})).digest('hex');
      console.log(JSON.stringify({key, state:statePath(process.cwd()), checkpoints:checkpointsDir(process.cwd())}));
    `], { cwd: project, env, encoding: "utf8", timeout: 10000 });
    assert.equal(setup.status, 0, setup.stderr);
    const info = JSON.parse(setup.stdout), dir = path.join(root, "store/imports"), lock = path.join(dir, info.key + ".lock");
    fs.mkdirSync(dir);
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(dead.status, 0);
    assert.throws(() => process.kill(dead.pid, 0), { code: "ESRCH" });
    fs.writeFileSync(lock, String(dead.pid)); fs.utimesSync(lock, new Date(0), new Date(0));
    const a = start(`
      import fs from 'node:fs'; import {importArtifact} from ${JSON.stringify(artifactModule)};
      const rm = fs.rmSync;
      fs.rmSync = (candidate, ...args) => {
        if (candidate === ${JSON.stringify(lock)} && !fs.existsSync(${JSON.stringify(ready)})) {
          fs.writeFileSync(${JSON.stringify(ready)}, 'stale lock observed');
          const end = Date.now() + 10000;
          while (!fs.existsSync(${JSON.stringify(release)})) {
            if (Date.now() > end) throw new Error('release barrier timed out');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return rm(candidate, ...args);
      };
      importArtifact(${JSON.stringify(file)}, {projectDir:process.cwd(), apply:true});
    `);
    await until(() => fs.existsSync(ready));
    const b = start(`
      import fs from 'node:fs'; import {importArtifact} from ${JSON.stringify(artifactModule)};
      import {observeKernelContention} from ${JSON.stringify(new URL("./helpers/observe-kernel-contention.mjs", import.meta.url).href)};
      observeKernelContention(() => fs.writeFileSync(${JSON.stringify(blocked)}, 'kernel denied entry'));
      const rm = fs.rmSync;
      fs.rmSync = (candidate, ...args) => {
        if (candidate === ${JSON.stringify(lock)}) fs.writeFileSync(${JSON.stringify(entered)}, 'entered stale recovery');
        return rm(candidate, ...args);
      };
      const result = importArtifact(${JSON.stringify(file)}, {projectDir:process.cwd(), apply:true});
      if (!result.alreadyApplied) throw new Error('second importer must observe the committed receipt');
    `);
    await until(() => fs.existsSync(blocked) || fs.existsSync(entered));
    assert.equal(fs.existsSync(entered), false, "second importer must not overtake stale recovery");
    assert.ok(fs.existsSync(blocked));
    fs.writeFileSync(release, "continue");
    for (const result of [await a, await b]) assert.equal(result.code, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(info.state));
    assert.equal(Object.keys(state.lanes.main.artifactImports).length, 1);
    assert.equal(fs.readdirSync(info.checkpoints).length, 2);
    for (const name of fs.readdirSync(info.checkpoints)) assert.equal(fs.readFileSync(path.join(info.checkpoints, name), "utf8"), "preserve this evidence");
    assert.equal(fs.existsSync(lock), false);
    assert.ok(fs.existsSync(path.join(root, "store/locks", info.key + ".import.guard")));
  } finally {
    for (const { child, done } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
