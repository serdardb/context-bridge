import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const stateModule = new URL("../src/state.mjs", import.meta.url).href;
const storageModule = new URL("../src/storage.mjs", import.meta.url).href;
const lockModule = new URL("../src/locking.mjs", import.meta.url).href;
const artifactModule = new URL("../src/artifact.mjs", import.meta.url).href;
const cli = fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url));

for (const kind of ["registry", "state", "migration", "import"]) for (const owner of ["kernel", "pid"]) {
  test(`${kind} ${owner} contention exits without evicting the owner and succeeds after release`, { timeout: 15000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-wait-"));
    const project = path.join(root, "project"), home = path.join(root, "store");
    fs.mkdirSync(project);
    const env = { ...process.env, PATH: "", NODE_OPTIONS: "", CODEX_THREAD_ID: "", CONTEXT_BRIDGE_ADAPTERS: "",
      CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_LOCK_TIMEOUT_MS: "150" };
    let holder, closed;
    try {
      const setup = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
        import {ensureState, defaultState, statePath, writeCheckpoint} from ${JSON.stringify(stateModule)};
        import {projectIdentity} from ${JSON.stringify(storageModule)};
        import {exportArtifact} from ${JSON.stringify(artifactModule)};
        const project = process.cwd();
        if (${JSON.stringify(kind)} === 'migration') {
          projectIdentity(project, {create:true});
          fs.mkdirSync('.bridge'); fs.writeFileSync('.bridge/state.json', JSON.stringify(defaultState(project)));
        } else ensureState(project);
        const id = projectIdentity(project).id;
        const key = crypto.createHash('sha256').update(JSON.stringify({lane:'main', project:id})).digest('hex');
        if (${JSON.stringify(kind)} === 'import') {
          writeCheckpoint(project, 'main', '2026-09-17T00-00-00-000Z-claude-to-codex-full.md', 'timeout evidence');
          exportArtifact(project, ${JSON.stringify(path.join(root, "input.cbctx"))});
        }
        console.log(JSON.stringify({id, key, state:statePath(project)}));
      `], { cwd: project, env, encoding: "utf8", timeout: 5000 });
      assert.equal(setup.status, 0, setup.stderr);
      const info = JSON.parse(setup.stdout);
      const markers = {
        registry: path.join(home, "projects.json.lock"), state: info.state + ".lock",
        migration: path.join(home, "migrations", info.id + ".lock"), import: path.join(home, "imports", info.key + ".lock"),
      };
      const guards = {
        registry: path.join(home, "locks/registry.guard"), state: info.state + ".lock.guard",
        migration: path.join(home, "locks", info.id + ".migration.guard"), import: path.join(home, "locks", info.key + ".import.guard"),
      };
      const lock = owner === "kernel" ? guards[kind] : markers[kind];
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      const ready = path.join(root, "ready"), release = path.join(root, "release");
      if (owner === "kernel") {
        holder = spawn(process.execPath, ["--input-type=module", "-e", `
          import fs from 'node:fs'; import {withKernelLockSync} from ${JSON.stringify(lockModule)};
          withKernelLockSync(${JSON.stringify(lock)}, () => {
            fs.writeFileSync(${JSON.stringify(ready)}, 'held');
            const end = Date.now() + 10000;
            while (!fs.existsSync(${JSON.stringify(release)})) {
              if (Date.now() > end) throw new Error('holder barrier timed out');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
          });
        `], { env, stdio: "ignore" });
        closed = new Promise((resolve) => holder.once("close", resolve));
        const end = Date.now() + 5000;
        while (!fs.existsSync(ready)) { assert.ok(Date.now() < end && holder.exitCode === null); await delay(10); }
      } else {
        fs.writeFileSync(lock, `${process.pid}\n`);
        fs.utimesSync(lock, new Date(0), new Date(0)); // Age never justifies evicting a live/reused PID.
      }
      const lockBefore = fs.readFileSync(lock), inode = fs.statSync(lock).ino;
      const stateFile = kind === "migration" ? path.join(project, ".bridge/state.json") : info.state;
      const stateBefore = fs.readFileSync(stateFile);
      const args = kind === "import" ? ["artifact", "import", path.join(root, "input.cbctx"), "--apply"] : ["lane", "new", "experiment"];
      const run = () => spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: "utf8", timeout: 4000 });
      const refused = run();
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stdout + refused.stderr, /Lock wait timed out after 150 ms/);
      assert.doesNotMatch(refused.stdout + refused.stderr, /\n\s+at /);
      assert.deepEqual(fs.readFileSync(lock), lockBefore);
      assert.equal(fs.statSync(lock).ino, inode);
      assert.deepEqual(fs.readFileSync(stateFile), stateBefore);
      if (holder) {
        assert.equal(holder.exitCode, null);
        fs.writeFileSync(release, "release");
        assert.equal(await closed, 0);
      } else fs.unlinkSync(lock);
      const retry = run();
      assert.equal(retry.status, 0, retry.stderr);
    } finally {
      if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      if (closed) await closed;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("nested locks share their wait budget and an expired scope does not poison retries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-nested-wait-"));
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {withKernelLockSync, waitForLock} from ${JSON.stringify(lockModule)};
      process.env.CONTEXT_BRIDGE_LOCK_TIMEOUT_MS = '60';
      assert.throws(() => withKernelLockSync('outer', () => {
        waitForLock('outer');
        process.env.CONTEXT_BRIDGE_LOCK_TIMEOUT_MS = 'invalid';
        withKernelLockSync('inner', () => { for (;;) waitForLock('inner'); });
      }), {code:'BRIDGE_LOCK_TIMEOUT'});
      process.env.CONTEXT_BRIDGE_LOCK_TIMEOUT_MS = '60';
      withKernelLockSync('outer', () => withKernelLockSync('inner', () => {}));
    `], { cwd: root, encoding: "utf8", timeout: 4000 });
    assert.equal(child.status, 0, child.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
