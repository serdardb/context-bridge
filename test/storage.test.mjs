import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  PROJECT_ID_KEY,
  gitProjectId,
  gitRoot,
  legacyBridgeDir,
  pathLocator,
  projectIdentity,
  projectStoreDir,
  runtimePath,
  storageHome,
  planLegacyMigration,
  adoptProject,
} from "../src/storage.mjs";
import { bridgeDir, checkpointsDir, defaultState, emptyLane, ensureState, loadState, writeCheckpoint, saveState, mutateState, mutateProject, statePath } from "../src/state.mjs";
import { loadConfig, saveConfig } from "../src/config.mjs";
import { latestManifest, writeManifest } from "../src/audit.mjs";
import { pruneCheckpoints } from "../src/clean.mjs";
import { recoverPreparations } from "../src/preparation.mjs";
const LEGACY_CHECKPOINT = "2026-09-16T00-00-00-000Z-claude-to-codex.md";

test("stalled optional Git probes cannot prevent local identity and have no surviving probe process", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-git-stall-"));
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const trace = path.join(root, "pids"), expired = path.join(root, "expired");
  // A real process ignores TERM; its self-exit keeps a broken guard bounded.
  fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const fs = require('node:fs');
if (process.env.PROBE_MODE === 'config' && process.argv.includes('--show-toplevel')) {
  console.log(process.env.PROBE_PROJECT); process.exit(0);
}
fs.appendFileSync(process.env.PROBE_TRACE, String(process.pid) + '\\n');
process.on('SIGTERM', () => {});
setTimeout(() => { fs.writeFileSync(process.env.PROBE_EXPIRED, 'timeout guard missing'); process.exit(1); }, 6000);
`, { mode: 0o700 });
  try {
    for (const mode of ["root", "config", "metadata"]) {
      const project = path.join(root, mode); fs.mkdirSync(project);
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import {projectIdentity, gitMetadata} from ${JSON.stringify(new URL("../src/storage.mjs", import.meta.url).href)};
        if (${JSON.stringify(mode)} === 'metadata') {
          assert.deepEqual(gitMetadata(process.cwd()), { branch: null, sha: null });
        } else {
          const identity = projectIdentity(process.cwd(), { create: true });
          assert.equal(identity.kind, 'local');
          assert.match(identity.id, /^[0-9a-f-]{36}$/);
        }
      `], { cwd: project, encoding: "utf8", timeout: 18000, env: {
        ...process.env, PATH: bin, CONTEXT_BRIDGE_HOME: path.join(root, "home"), CONTEXT_BRIDGE_STORAGE: "",
        PROBE_MODE: mode, PROBE_PROJECT: project, PROBE_TRACE: trace, PROBE_EXPIRED: expired,
      } });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(fs.existsSync(expired), false, "the optional probe must be terminated before its own fallback timer");
      assert.deepEqual(fs.readdirSync(project), []);
    }
    const pids = fs.readFileSync(trace, "utf8").trim().split("\n").map(Number);
    assert.equal(pids.length, 4);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (fs.existsSync(trace)) for (const value of fs.readFileSync(trace, "utf8").trim().split("\n")) {
      try { process.kill(Number(value), "SIGKILL"); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const pauseAt of ["first-read", "upgrade-write"]) {
  test(`schema upgrade preserves a concurrent writer paused at ${pauseAt}`, { timeout: 20000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-upgrade-race-"));
    const project = path.join(root, "project"); fs.mkdirSync(project);
    const env = { ...process.env, PATH: "", CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_HOME: path.join(root, "home") };
    const stateModule = new URL("../src/state.mjs", import.meta.url).href;
    const utilModule = new URL("../src/util.mjs", import.meta.url).href;
    const setup = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {ensureState,statePath} from ${JSON.stringify(stateModule)};
      ensureState(process.cwd()); console.log(statePath(process.cwd()));
    `], { cwd: project, env, encoding: "utf8" });
    assert.equal(setup.status, 0, setup.stderr);
    const file = setup.stdout.trim();
    const original = JSON.stringify({ version: 4, project, agents: {}, knownBy: {}, git: {} });
    fs.writeFileSync(file, original);
    const ready = path.join(root, "ready"), release = path.join(root, "release");
    const blocked = path.join(root, "blocked"), done = path.join(root, "done");
    const children = [];
    t.after(async () => {
      for (const { child, closed } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const start = (body) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import fs from 'node:fs'; import {loadState,mutateState} from ${JSON.stringify(stateModule)};
        import {writeJsonAtomic} from ${JSON.stringify(utilModule)};
        ${body}
      `], { cwd: project, env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
      const closed = new Promise((resolve) => child.once("close", (code) => resolve({ code, stderr })));
      children.push({ child, closed }); return closed;
    };
    const until = async (predicate) => {
      const deadline = Date.now() + 7000;
      while (!predicate()) { assert.ok(Date.now() < deadline, "fixture barrier timed out"); await delay(10); }
    };
    const a = start(`
      const pause = () => {
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        const deadline = Date.now() + 7000;
        while (!fs.existsSync(${JSON.stringify(release)})) {
          if (Date.now() > deadline) throw new Error('release timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      };
      const read = fs.readFileSync; let first = true;
      fs.readFileSync = (name, ...args) => {
        const value = read(name, ...args);
        if (${pauseAt === "first-read"} && name === ${JSON.stringify(file)} && first) { first = false; pause(); }
        return value;
      };
      loadState(process.cwd(), { write: (name, value) => {
        if (${pauseAt === "upgrade-write"}) pause();
        writeJsonAtomic(name, value);
      } });
    `);
    await until(() => fs.existsSync(ready));
    const b = start(`
      import {observeKernelContention} from ${JSON.stringify(new URL("./helpers/observe-kernel-contention.mjs", import.meta.url).href)};
      observeKernelContention(() => fs.writeFileSync(${JSON.stringify(blocked)}, 'kernel waiting'));
      const open = fs.openSync;
      fs.openSync = (name, ...args) => {
        try { return open(name, ...args); } catch (error) {
          if (name === ${JSON.stringify(file + ".lock")} && error.code === 'EEXIST') fs.writeFileSync(${JSON.stringify(blocked)}, 'waiting');
          throw error;
        }
      };
      mutateState(process.cwd(), 'main', (state) => { state.concurrentMarker = 'retained'; });
      fs.writeFileSync(${JSON.stringify(done)}, 'done');
    `);
    await until(() => fs.existsSync(blocked) || fs.existsSync(done));
    fs.writeFileSync(release, "go");
    for (const result of [await a, await b]) assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(file)).concurrentMarker, "retained");
    assert.equal(fs.readFileSync(file + ".v4.backup", "utf8"), original);
    assert.equal(fs.existsSync(file + ".lock"), false);
    assert.deepEqual(fs.readdirSync(project), []);
  });
}

test("all global state writers require a verified schema backup and reject future state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-schema-backup-"));
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { ensureState, statePath, loadState, mutateState, mutateProject, saveState, defaultState, STATE_VERSION }
        from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
      for (const writer of ['load', 'ensure', 'lane', 'project', 'save']) {
        for (const mode of ['io-error', 'conflict', 'symlink', 'matching', 'future']) {
          const project = path.join(${JSON.stringify(root)}, writer + '-' + mode);
          fs.mkdirSync(project);
          ensureState(project);
          const file = statePath(project), backup = file + '.v4.backup';
          const original = JSON.stringify({ version: mode === 'future' ? STATE_VERSION + 1 : 4,
            project, agents: {}, knownBy: {}, git: {}, marker: 'preserve me' });
          fs.writeFileSync(file, original);
          if (mode === 'matching') fs.writeFileSync(backup, original);
          if (mode === 'conflict') fs.writeFileSync(backup, 'a different original');
          const outside = path.join(${JSON.stringify(root)}, writer + '-outside');
          if (mode === 'symlink') { fs.writeFileSync(outside, original); fs.symlinkSync(outside, backup); }
          const link = fs.linkSync;
          fs.linkSync = (source, target) => {
            if (mode === 'io-error' && target === backup) throw Object.assign(new Error('backup I/O'), { code: 'EIO' });
            return link(source, target);
          };
          let invoked = false;
          const fn = () => { invoked = true; };
          const operation = () => ({
            load: () => loadState(project), ensure: () => ensureState(project),
            lane: () => mutateState(project, 'main', fn),
            project: () => mutateProject(project, fn), save: () => saveState(project, defaultState(project)),
          })[writer]();
          try {
            if (mode === 'matching') {
              operation();
              assert.equal(JSON.parse(fs.readFileSync(file)).version, STATE_VERSION);
              assert.equal(fs.readFileSync(backup, 'utf8'), original);
            } else {
              assert.throws(operation, mode === 'future' ? /newer/ : mode === 'io-error' ? /backup I.O/ : /backup does not match/);
              assert.equal(invoked, false);
              assert.equal(fs.readFileSync(file, 'utf8'), original);
              if (mode === 'io-error') assert.equal(fs.existsSync(backup), false);
              if (mode === 'conflict') assert.equal(fs.readFileSync(backup, 'utf8'), 'a different original');
              if (mode === 'symlink') assert.equal(fs.readFileSync(outside, 'utf8'), original);
              if (mode !== 'future') assert.equal(loadState(project, { readOnly: true }).version, STATE_VERSION);
            }
          } finally { fs.linkSync = link; }
          assert.equal(fs.existsSync(file + '.lock'), false);
          if (mode === 'io-error') {
            operation();
            assert.equal(fs.readFileSync(backup, 'utf8'), original);
          }
          assert.deepEqual(fs.readdirSync(project), []);
        }
      }
    `], { encoding: "utf8", timeout: 20000, env: {
      ...process.env, PATH: "", CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_HOME: path.join(root, "home"),
    } });
    assert.equal(child.status, 0, child.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unreadable global state is never bootstrapped or mutated as an empty project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-unreadable-state-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { ensureState, statePath, loadState, mutateState, mutateProject, withProjectStateReadLock }
        from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
      const project = ${JSON.stringify(project)};
      ensureState(project);
      const file = statePath(project), original = fs.readFileSync(file);
      const read = fs.readFileSync, access = fs.accessSync;
      const fail = () => { throw Object.assign(new Error('fixture secret must not leak'), { code: 'EACCES' }); };
      fs.readFileSync = (name, ...args) => name === file ? fail() : read(name, ...args);
      fs.accessSync = (name, ...args) => name === file ? fail() : access(name, ...args);
      let invoked = false;
      for (const operation of [
        () => loadState(project), () => loadState(project, { readOnly: true }),
        () => ensureState(project),
        () => mutateState(project, 'main', () => { invoked = true; }),
        () => mutateProject(project, () => { invoked = true; }),
        () => withProjectStateReadLock(project, () => { invoked = true; }),
      ]) assert.throws(operation, /Bridge state could not be read/);
      assert.equal(invoked, false, 'no callback can proceed from unknown state');
      fs.readFileSync = read; fs.accessSync = access;
      assert.deepEqual(fs.readFileSync(file), original);
      assert.equal(fs.existsSync(file + '.lock'), false);
      assert.ok(loadState(project));
    `], { encoding: "utf8", timeout: 10000, env: {
      ...process.env, PATH: "", CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_HOME: path.join(root, "home"),
    } });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(fs.readdirSync(project), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed registry and migration lock stamping releases the lock and permits retry", () => {
  for (const kind of ["registry", "migration"]) {
    for (const failure of ["write", "close"]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-stamp-failure-"));
      const project = path.join(root, "project");
      const home = path.join(root, "home");
      fs.mkdirSync(project);
      try {
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
          import assert from 'node:assert/strict';
          import fs from 'node:fs';
          import path from 'node:path';
          import { projectIdentity, migrateLegacyStorage } from ${JSON.stringify(new URL("../src/storage.mjs", import.meta.url).href)};
          import { defaultState } from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
          const project = ${JSON.stringify(project)}, home = ${JSON.stringify(home)};
          const kind = ${JSON.stringify(kind)}, failure = ${JSON.stringify(failure)};
          let lock;
          if (kind === 'migration') {
            const identity = projectIdentity(project, { create: true });
            lock = path.join(home, 'migrations', identity.id + '.lock');
            fs.mkdirSync(path.join(project, '.bridge'));
            fs.writeFileSync(path.join(project, '.bridge', 'state.json'), JSON.stringify(defaultState(project)));
          } else lock = path.join(home, 'projects.json.lock');
          const open = fs.openSync, write = fs.writeSync, close = fs.closeSync;
          let descriptor, injected = false;
          const injectedError = Object.assign(new Error('lock stamp failed'), { code: 'EIO' });
          fs.openSync = (file, ...args) => {
            const fd = open(file, ...args);
            if (file === lock) descriptor = fd;
            return fd;
          };
          fs.writeSync = (fd, ...args) => {
            if (fd === descriptor && failure === 'write' && !injected) {
              injected = true;
              write(fd, 'partial');
              throw injectedError;
            }
            return write(fd, ...args);
          };
          fs.closeSync = (fd) => {
            if (fd === descriptor && failure === 'close' && !injected) {
              injected = true;
              throw injectedError;
            }
            return close(fd);
          };
          const operation = () => kind === 'registry'
            ? projectIdentity(project, { create: true }) : migrateLegacyStorage(project);
          assert.throws(operation, (error) => error === injectedError);
          assert.equal(injected, true);
          assert.equal(fs.existsSync(lock), false, 'failed acquisition must release its exclusive lock');
          assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
          if (kind === 'migration') assert.ok(fs.existsSync(path.join(project, '.bridge', 'state.json')));
          fs.openSync = open; fs.writeSync = write; fs.closeSync = close;
          operation();
          assert.equal(fs.existsSync(lock), false);
          if (kind === 'migration') assert.equal(fs.existsSync(path.join(project, '.bridge')), false);
        `], { encoding: "utf8", timeout: 10000, env: {
          ...process.env, CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "", PATH: "",
        } });
        assert.equal(child.status, 0, `${kind}/${failure}: ${child.stderr}`);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test("journal staging from an abruptly exited real writer is cleaned only after group protection is resolved", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-journal-stage-"));
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = path.join(root, "home");
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    for (const published of [false, true]) {
      const project = path.join(root, String(published));
      fs.mkdirSync(project);
      ensureState(project);
      const original = fs.readFileSync(statePath(project));
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import fs from 'node:fs';
        import { beginPreparation } from ${JSON.stringify(new URL("../src/preparation.mjs", import.meta.url).href)};
        const link = fs.linkSync;
        fs.linkSync = (...args) => {
          if (${published}) link(...args);
          process.exit(79);
        };
        beginPreparation(${JSON.stringify(project)}, 'main', ${JSON.stringify(LEGACY_CHECKPOINT.slice(0, -3))},
          { '.md': 'delta', '-full.md': 'complete' });
      `], { encoding: "utf8", env: { ...process.env, PATH: "", CONTEXT_BRIDGE_STORAGE: "" } });
      assert.equal(child.status, 79, child.stderr);
      const dir = checkpointsDir(project);
      const temporary = fs.readdirSync(dir).find((name) => name.includes(".tmp-"));
      assert.ok(temporary?.startsWith("..handoff-"));
      const preview = pruneCheckpoints(project, { staging: true, dryRun: true });
      assert.equal(preview.deletedStagingFiles, published ? 0 : 1);
      assert.ok(fs.existsSync(path.join(dir, temporary)));
      if (published) {
        assert.equal(pruneCheckpoints(project, { staging: true }).deletedStagingFiles, 0);
        recoverPreparations(project, "main");
      }
      const live = temporary.replace(/\.tmp-\d+-/, `.tmp-${process.pid}-`);
      fs.writeFileSync(path.join(dir, live), "live journal writer");
      assert.equal(pruneCheckpoints(project, { staging: true }).deletedStagingFiles, 1);
      assert.equal(fs.existsSync(path.join(dir, temporary)), false);
      assert.equal(fs.readFileSync(path.join(dir, live), "utf8"), "live journal writer");
      assert.deepEqual(fs.readFileSync(statePath(project)), original);
      assert.deepEqual(fs.readdirSync(project), []);
    }
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real staging cleanup previews, scopes lanes and preserves live or uncertain owners", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-staging-clean-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = path.join(root, "home");
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  const kill = process.kill;
  try {
    ensureState(project);
    mutateProject(project, (s) => { s.lanes.feature = emptyLane(); });
    const state = fs.readFileSync(statePath(project));
    const staging = {};
    for (const lane of ["main", "feature"]) {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import fs from 'node:fs';
        import { writeCheckpoint } from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
        const write = fs.writeFileSync;
        fs.writeFileSync = (file, ...args) => {
          if (typeof file !== 'number') return write(file, ...args);
          write(file, 'partial'); process.exit(79);
        };
        writeCheckpoint(${JSON.stringify(project)}, ${JSON.stringify(lane)}, ${JSON.stringify(LEGACY_CHECKPOINT)}, 'complete context');
      `], { encoding: "utf8", env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "" } });
      assert.equal(child.status, 79, child.stderr);
      staging[lane] = path.join(checkpointsDir(project, lane), fs.readdirSync(checkpointsDir(project, lane))[0]);
    }
    const dir = checkpointsDir(project, "main");
    const live = path.join(dir, `.${LEGACY_CHECKPOINT}.tmp-${process.pid}-00000000-0000-4000-8000-000000000000`);
    fs.writeFileSync(live, "live writer");
    fs.writeFileSync(path.join(dir, "unknown.tmp"), "user file");
    const link = `${staging.main.slice(0, -1)}${staging.main.endsWith("1") ? "2" : "1"}`;
    fs.symlinkSync(live, link);
    writeCheckpoint(project, "main", LEGACY_CHECKPOINT, "retained complete evidence");
    const before = fs.readdirSync(dir).sort();
    process.kill = () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); };
    assert.equal(pruneCheckpoints(project, { staging: true, lane: "main", dryRun: true }).deletedStagingFiles, 0);
    process.kill = kill;
    const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url)), "clean", ...args], {
      cwd: project, encoding: "utf8", env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "", PATH: "" },
    });
    const preview = cli("--staging", "--lane", "main", "--dry-run");
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Would delete 1 abandoned staging files/);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
    const apply = cli("--staging", "--lane", "main");
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /Deleted 1 abandoned staging files/);
    assert.equal(fs.existsSync(staging.main), false);
    assert.equal(fs.existsSync(staging.feature), true);
    assert.equal(fs.readFileSync(live, "utf8"), "live writer");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(dir, LEGACY_CHECKPOINT), "utf8"), "retained complete evidence");
    assert.equal(fs.readFileSync(path.join(dir, "unknown.tmp"), "utf8"), "user file");
    assert.equal(cli("--staging").status, 0);
    assert.equal(fs.existsSync(staging.feature), false);
    assert.equal(cli("--staging", "--all").status, 1);
    assert.deepEqual(fs.readFileSync(statePath(project)), state);
    assert.deepEqual(fs.readdirSync(project), []);
  } finally {
    process.kill = kill;
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("partial evidence writes are never published, including abrupt process exit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-partial-evidence-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = path.join(root, "home");
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  const write = fs.writeFileSync;
  try {
    ensureState(project);
    const dir = checkpointsDir(project, "main");
    for (const kind of ["checkpoint", "audit"]) {
      const stem = "2026-09-16T00-00-00-000Z-claude-to-codex";
      let injected = false;
      fs.writeFileSync = (file, ...args) => {
        if (typeof file !== "number") return write(file, ...args);
        injected = true;
        write(file, "partial");
        throw Object.assign(new Error("injected partial write"), { code: "ENOSPC" });
      };
      try {
        assert.throws(() => kind === "checkpoint"
          ? writeCheckpoint(project, "main", `${stem}.md`, "complete context")
          : writeManifest(project, "main", stem, { complete: true }), /injected partial write/);
      } finally { fs.writeFileSync = write; }
      assert.equal(injected, true);
      assert.deepEqual(fs.readdirSync(dir), [], "caught write failure must remove its staging file");
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import fs from 'node:fs';
        import { writeCheckpoint } from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
        import { writeManifest } from ${JSON.stringify(new URL("../src/audit.mjs", import.meta.url).href)};
        const write = fs.writeFileSync;
        fs.writeFileSync = (file, ...args) => {
          if (typeof file !== 'number') return write(file, ...args);
          write(file, 'partial'); process.exit(79);
        };
        if (${JSON.stringify(kind)} === 'checkpoint')
          writeCheckpoint(${JSON.stringify(project)}, 'main', ${JSON.stringify(`${stem}.md`)}, 'complete context');
        else writeManifest(${JSON.stringify(project)}, 'main', ${JSON.stringify(stem)}, {complete: true});
      `], { encoding: "utf8", env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "" } });
      assert.equal(result.status, 79, result.stderr);
      const files = fs.readdirSync(dir);
      assert.equal(files.length, 1);
      assert.match(files[0], /^\..+\.tmp-\d+-[a-f0-9-]+$/);
      assert.equal(fs.readFileSync(path.join(dir, files[0]), "utf8"), "partial");
      if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
      fs.unlinkSync(path.join(dir, files[0]));
    }
    assert.deepEqual(fs.readdirSync(project), []);
  } finally {
    fs.writeFileSync = write;
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("evidence names cannot escape their lane or initialize storage on invalid input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-evidence-name-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  fs.mkdirSync(project);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    for (const name of ["../escaped", "", ".", "..", "../../lanes/other/checkpoints/escaped", "/absolute", "nested/file", "nested\\file", "bad\0name", null, 42]) {
      assert.throws(() => writeCheckpoint(project, "main", name, "must not be written"), /checkpoint filename/);
      assert.throws(() => writeManifest(project, "main", name, { value: "must not be written" }), /checkpoint filename/);
      assert.equal(fs.existsSync(home), false, `invalid name initialized storage: ${JSON.stringify(name)}`);
      assert.deepEqual(fs.readdirSync(project), []);
    }
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two processes creating one evidence filename have exactly one winner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-evidence-race-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = path.join(root, "home");
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    ensureState(project);
    for (const kind of ["checkpoint", "audit"]) {
      const stem = "2026-09-16T00-00-00-000Z-claude-to-codex";
      const children = ["first payload", "second payload"].map((content) => {
        const script = `
          import { writeCheckpoint } from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
          import { writeManifest } from ${JSON.stringify(new URL("../src/audit.mjs", import.meta.url).href)};
          process.send('ready');
          process.once('message', () => {
            try {
              if (${JSON.stringify(kind)} === 'checkpoint')
                writeCheckpoint(${JSON.stringify(project)}, 'main', ${JSON.stringify(`${stem}.md`)}, ${JSON.stringify(content)});
              else writeManifest(${JSON.stringify(project)}, 'main', ${JSON.stringify(stem)}, { content: ${JSON.stringify(content)} });
              process.exit(0);
            } catch (error) { console.error(error.code); process.exit(error.code === 'EEXIST' ? 2 : 1); }
          });`;
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "" }, stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let stderr = "";
        child.stderr.on("data", (data) => { stderr += data; });
        const ready = new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
        const done = new Promise((resolve, reject) => {
          child.once("close", (code) => resolve({ code, content, stderr })); child.once("error", reject);
        });
        return { child, ready, done };
      });
      await Promise.all(children.map(({ ready }) => ready));
      for (const { child } of children) child.send("write");
      const results = await Promise.all(children.map(({ done }) => done));
      assert.deepEqual(results.map(({ code }) => code).sort(), [0, 2], JSON.stringify(results));
      const winner = results.find(({ code }) => code === 0);
      const file = path.join(checkpointsDir(project, "main"), kind === "checkpoint" ? `${stem}.md` : `${stem}-audit.json`);
      const actual = fs.readFileSync(file, "utf8");
      assert.equal(kind === "checkpoint" ? actual : JSON.parse(actual).content, winner.content);
    }
    assert.deepEqual(fs.readdirSync(project), []);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint and audit creation never overwrites existing evidence or follows a leaf symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-exclusive-evidence-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = path.join(root, "home");
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    ensureState(project);
    const stem = "2026-09-16T00-00-00-000Z-claude-to-codex";
    const dir = checkpointsDir(project, "main");
    const outside = path.join(root, "unrelated.txt");
    fs.writeFileSync(outside, "unrelated content");
    for (const kind of ["delta", "audit"]) {
      const name = kind === "delta" ? `${stem}.md` : `${stem}-audit.json`;
      const file = path.join(dir, name);
      const write = () => kind === "delta"
        ? writeCheckpoint(project, "main", name, "replacement")
        : writeManifest(project, "main", stem, { replacement: true });
      write();
      const original = fs.readFileSync(file);
      assert.throws(write, { code: "EEXIST" });
      assert.deepEqual(fs.readFileSync(file), original);
      fs.unlinkSync(file);
      fs.symlinkSync(outside, file);
      assert.throws(write);
      assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(outside, "utf8"), "unrelated content");
    }
    assert.deepEqual(fs.readdirSync(project), []);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a route-budget rejection after migration preserves a real pending handoff byte for byte", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-migrated-refusal-"));
  const project = path.join(root, "workspace");
  fs.mkdirSync(project);
  const home = path.join(root, "runtime");
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = home;
  process.env.CONTEXT_BRIDGE_STORAGE = "project";
  const bin = path.resolve("bin/bridge.mjs");
  const env = { ...process.env, CONTEXT_BRIDGE_STORAGE: "", CODEX_HOME: path.join(root, "codex"), PATH: "" };
  try {
    const transcript = path.join(root, "claude.jsonl");
    fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: "2026-09-16T00:00:00.000Z",
      message: { content: "This work must remain available when the next handoff is refused." } }) + "\n");
    const s = defaultState(project);
    s.activeAgent = "claude";
    s.agents.claude = { id: "claude-fixture", transcriptPath: transcript, mark: null, idle: false };
    s.agents.codex = { id: "codex-fixture", transcriptPath: null, mark: null, idle: false, hookSeen: new Date().toISOString() };
    saveState(project, s);
    // Model a published legacy store, which predates stable kernel guards.
    // This fixture has no writer/contender; never remove a live product guard.
    fs.unlinkSync(path.join(project, ".bridge", "state.json.lock.guard"));
    delete process.env.CONTEXT_BRIDGE_STORAGE;
    ensureState(project);
    const hooks = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import {installHooks} from ${JSON.stringify(pathToFileURL(path.resolve("src/agents/codex.mjs")).href)}; installHooks();`],
    { env, encoding: "utf8" });
    assert.equal(hooks.status, 0, hooks.stderr);
    const run = (summary) => spawnSync(process.execPath, [bin, "handoff", "codex", "--from", "claude", "--summary", summary],
      { cwd: project, env, encoding: "utf8" });
    const first = run("Retain the existing work and its audit while preparing the next step.");
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const pending = loadState(project).pendingInjection;
    assert.equal(pending.via, "hook", "the exact road check must be reachable, not just the 12KB ceiling");
    const snapshot = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => [entry.name, entry.isDirectory() ? snapshot(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), "base64")]);
    const before = snapshot(home);
    const files = fs.readdirSync(checkpointsDir(project));
    assert.equal(files.length, 3, "the first real command must create delta, context and audit evidence");
    const rejected = run("x".repeat(10 * 1024));
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr + rejected.stdout, /Shorten it yourself/);
    assert.deepEqual(snapshot(home), before, "rejection must not mutate state, registry, backups or evidence");
    assert.deepEqual(loadState(project).pendingInjection, pending);
    assert.deepEqual(fs.readdirSync(project), []);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("after legacy migration CLI retention respects lane scope and protects entire pending groups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-migrated-retention-"));
  const project = path.join(root, "workspace");
  const home = path.join(root, "runtime");
  fs.mkdirSync(project);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = home;
  process.env.CONTEXT_BRIDGE_STORAGE = "project";
  try {
    const s = defaultState(project);
    s.lanes.feature = emptyLane();
    saveState(project, s);
    const expected = {};
    for (const lane of ["main", "feature"]) {
      expected[lane] = {};
      for (const [index, kind] of [[1, "pending"], [2, "old"]]) {
        const stem = `2026-01-0${index}T00-00-00-000Z-claude-to-codex`;
        for (const suffix of [kind === "old" ? ".md.consumed" : ".md", "-full.md", "-audit.json"]) {
          const name = stem + suffix;
          const content = JSON.stringify({ lane, kind, suffix });
          const rel = writeCheckpoint(project, lane, name, content);
          expected[lane][name] = content;
          if (kind === "pending" && suffix === ".md") {
            s.lanes[lane].pendingInjection = { agent: "codex", deltaFile: rel };
            if (lane === "feature") s.lanes.feature.pendingHandoff = { target: "codex", ready: true };
          }
        }
      }
    }
    saveState(project, s);
    // Historical source bytes must not include a modern test-only lock artifact.
    fs.unlinkSync(path.join(project, ".bridge", "state.json.lock.guard"));
    delete process.env.CONTEXT_BRIDGE_STORAGE;
    ensureState(project);
    assert.equal(fs.existsSync(path.join(project, ".bridge")), false);
    const stateBefore = fs.readFileSync(statePath(project));
    const contents = (lane) => Object.fromEntries(fs.readdirSync(checkpointsDir(project, lane)).sort()
      .map((name) => [name, fs.readFileSync(path.join(checkpointsDir(project, lane), name), "utf8")]));
    const clean = (...args) => {
      const res = spawnSync(process.execPath, [path.resolve("bin/bridge.mjs"), "clean", ...args], {
        cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" },
      });
      assert.equal(res.status, 0, res.stderr + res.stdout);
      assert.deepEqual(fs.readFileSync(statePath(project)), stateBefore, "retention must not rewrite lane state");
      assert.deepEqual(fs.readdirSync(project), []);
    };
    clean("--all", "--lane", "feature", "--dry-run");
    for (const lane of ["main", "feature"]) assert.deepEqual(contents(lane), expected[lane]);
    clean("--all", "--lane", "feature");
    assert.deepEqual(contents("main"), expected.main, "another lane's groups are outside the selected prune scope");
    const pendingOnly = (lane) => Object.fromEntries(Object.entries(expected[lane]).filter(([name]) => name.startsWith("2026-01-01")));
    assert.deepEqual(contents("feature"), pendingOnly("feature"), "pending outgoing handoff protects delta, context and audit");
    clean("--all");
    for (const lane of ["main", "feature"]) assert.deepEqual(contents(lane), pendingOnly(lane));
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real clones and worktrees stay isolated while symlink and case aliases share only the same filesystem project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-identity-matrix-"));
  const original = path.join(root, "Project");
  const clone = path.join(root, "clone");
  const worktree = path.join(root, "worktree");
  const alias = path.join(root, "alias");
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = path.join(root, "global");
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    fs.mkdirSync(original);
    git(original, "init", "-q");
    git(original, "-c", "user.name=Bridge Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    git(original, "config", "--local", PROJECT_ID_KEY, "same-advisory-marker");
    git(root, "clone", "-q", original, clone);
    git(clone, "config", "--local", PROJECT_ID_KEY, "same-advisory-marker");
    git(original, "worktree", "add", "--detach", worktree, "HEAD");
    fs.symlinkSync(original, alias);
    for (const [dir, marker] of [[original, "original"], [clone, "clone"], [worktree, "worktree"]]) {
      ensureState(dir);
      mutateState(dir, "main", (state) => { state.marker = marker; });
    }
    const identities = [original, clone, worktree].map((dir) => projectIdentity(dir).id);
    assert.equal(new Set(identities).size, 3, "shared Git marker/repository objects do not merge project identities");
    assert.equal(projectIdentity(alias).id, identities[0]);
    assert.equal(loadState(alias).marker, "original");
    mutateState(alias, "main", (state) => { state.marker = "via alias"; });
    assert.equal(loadState(original).marker, "via alias");
    assert.equal(loadState(clone).marker, "clone");
    assert.equal(loadState(worktree).marker, "worktree");
    const lower = path.join(root, "project");
    if (fs.existsSync(lower)) {
      assert.equal(projectIdentity(lower).id, identities[0], "case-insensitive alias shares identity");
    } else {
      fs.mkdirSync(lower);
      ensureState(lower);
      assert.notEqual(projectIdentity(lower).id, identities[0], "case-sensitive distinct directory stays distinct");
    }
    for (const dir of [original, clone, worktree]) assert.equal(fs.existsSync(path.join(dir, ".bridge")), false);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignore cleanup requires explicit apply, preserves unrelated bytes and does not require Git", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ignore-cleanup-"));
  const home = path.join(root, "global");
  const file = path.join(root, ".gitignore");
  const original = "# user rules\r\n.bridge/\r\nnode_modules/\r\n/.bridge\r\n**/.bridge/\r\n!.bridge/keep\r\nfinal-without-newline";
  const run = (...flags) => spawnSync(process.execPath, [path.resolve("bin/bridge.mjs"), "storage", "cleanup-ignore", "--json", ...flags], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: "", CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "" },
  });
  try {
    fs.writeFileSync(file, original);
    const preview = run();
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(JSON.parse(preview.stdout).matches, [{ line: 2, rule: ".bridge/" }, { line: 4, rule: "/.bridge" }]);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    fs.mkdirSync(path.join(root, ".bridge"));
    const blocked = run("--apply");
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(JSON.parse(blocked.stdout).blocked, /still exists/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    fs.rmdirSync(path.join(root, ".bridge"));
    const applied = run("--apply");
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).applied, true);
    assert.equal(fs.readFileSync(file, "utf8"), "# user rules\r\nnode_modules/\r\n**/.bridge/\r\n!.bridge/keep\r\nfinal-without-newline");
    assert.equal(JSON.parse(run("--apply").stdout).applied, false);
    assert.deepEqual(fs.readdirSync(root), [".gitignore"], "no Git directory, runtime registry or temporary files");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("ignore cleanup refuses symlinks and non-UTF-8 content without changing either", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ignore-unsafe-"));
  const file = path.join(root, ".gitignore");
  const target = path.join(root, "outside");
  const run = () => spawnSync(process.execPath, [path.resolve("bin/bridge.mjs"), "storage", "cleanup-ignore", "--apply"], {
    cwd: root, encoding: "utf8",
  });
  try {
    fs.writeFileSync(target, ".bridge/\nprivate\n");
    fs.symlinkSync(target, file);
    const linked = run();
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /symlinked/);
    assert.equal(fs.readFileSync(target, "utf8"), ".bridge/\nprivate\n");
    fs.unlinkSync(file);
    const bytes = Buffer.from([0xff, 0x0a, ...Buffer.from(".bridge/\n")]);
    fs.writeFileSync(file, bytes);
    const invalid = run();
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /non-UTF-8/);
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("migration refuses live, uncertain and unstamped legacy state locks without creating global data", () => {
  const storageUrl = pathToFileURL(path.resolve("src/storage.mjs")).href;
  for (const [owner, probeError] of [
    [`${process.pid} 2026-09-16T00:00:00Z`, null], ["", null], ["unreadable owner", null],
    ...["EPERM", "EIO", "EINVAL"].map((code) => [`${process.pid} 2026-09-16T00:00:00Z`, code]),
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-locked-migration-"));
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const legacy = path.join(project, ".bridge");
    fs.mkdirSync(legacy, { recursive: true });
    const original = JSON.stringify(defaultState(project));
    fs.writeFileSync(path.join(legacy, "state.json"), original);
    fs.writeFileSync(path.join(legacy, "state.json.lock"), owner);
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { migrateLegacyStorage, planLegacyMigration } from ${JSON.stringify(storageUrl)};
        if (${JSON.stringify(probeError)}) process.kill = () => {
          throw Object.assign(new Error('process probe failed'), { code: ${JSON.stringify(probeError)} });
        };
        assert.match(planLegacyMigration(${JSON.stringify(project)}).blockers.join(' '), /live or unknown writer/);
        assert.throws(() => migrateLegacyStorage(${JSON.stringify(project)}), /live or unknown writer/);
      `], { encoding: "utf8", env: { ...process.env, CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "" } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(home), false);
      assert.equal(fs.readFileSync(path.join(legacy, "state.json"), "utf8"), original);
      assert.equal(fs.readFileSync(path.join(legacy, "state.json.lock"), "utf8"), owner);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("a state mutation waits through uncertain owner probes before recovering a dead lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-uncertain-owner-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { ensureState, statePath, mutateState, loadState } from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
      const project = ${JSON.stringify(project)};
      ensureState(project);
      const lock = statePath(project) + '.lock';
      fs.writeFileSync(lock, '123 fixture-owner');
      const original = fs.readFileSync(statePath(project));
      let probes = 0;
      const kill = process.kill;
      process.kill = (pid, signal) => {
        if (pid !== 123) return kill(pid, signal);
        probes++;
        assert.equal(fs.readFileSync(lock, 'utf8'), '123 fixture-owner');
        assert.deepEqual(fs.readFileSync(statePath(project)), original);
        throw Object.assign(new Error('probe'), { code: probes <= 3 ? 'EIO' : 'ESRCH' });
      };
      mutateState(project, 'main', (state) => {
        assert.equal(probes, 4, 'uncertainty must not allow the mutation to acquire the lock');
        state.ownerProbeVerified = true;
      });
      assert.equal(loadState(project).ownerProbeVerified, true);
      assert.equal(fs.existsSync(lock), false);
    `], { encoding: "utf8", timeout: 10000, env: {
      ...process.env, CONTEXT_BRIDGE_HOME: path.join(root, "home"), CONTEXT_BRIDGE_STORAGE: "", PATH: "",
    } });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(fs.readdirSync(project), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a dead legacy writer's lock is backed up and removed without blocking global mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-dead-writer-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const legacy = path.join(project, ".bridge");
  fs.mkdirSync(legacy, { recursive: true });
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" });
  assert.equal(exited.status, 0);
  const stamp = `${exited.pid} 2026-09-16T00:00:00Z`;
  fs.writeFileSync(path.join(legacy, "state.json"), JSON.stringify(defaultState(project)));
  fs.writeFileSync(path.join(legacy, "state.json.lock"), stamp);
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { mutateState, loadState } from ${JSON.stringify(pathToFileURL(path.resolve("src/state.mjs")).href)};
      mutateState(${JSON.stringify(project)}, 'main', (s) => { s.marker = 'after migration'; });
      assert.equal(loadState(${JSON.stringify(project)}).marker, 'after migration');
    `], { encoding: "utf8", timeout: 10000, env: { ...process.env, CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(legacy), false);
    const backups = fs.readdirSync(path.join(home, "migrations"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(home, "migrations", backups[0].name, "state.json.lock"), "utf8"), stamp);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("every direct state writer prepares global storage before choosing its write and lock paths", () => {
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  for (const writer of ["save", "lane", "project"]) {
    for (const legacyState of [false, true]) {
      if (writer === "project" && !legacyState) continue;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-direct-state-"));
      const project = path.join(root, "project");
      const home = path.join(root, "home");
      const legacy = path.join(project, ".bridge");
      fs.mkdirSync(project);
      process.env.CONTEXT_BRIDGE_HOME = home;
      delete process.env.CONTEXT_BRIDGE_STORAGE;
      try {
        const state = defaultState(project);
        if (legacyState) {
          fs.mkdirSync(path.join(legacy, "checkpoints"), { recursive: true });
          state.lanes.main.pendingHandoff = { target: "codex", deltaFile: `.bridge/checkpoints/${LEGACY_CHECKPOINT}` };
          fs.writeFileSync(path.join(legacy, "state.json"), JSON.stringify(state));
          fs.writeFileSync(path.join(legacy, "checkpoints", LEGACY_CHECKPOINT), "preserve pending evidence");
        }
        if (writer === "save") { state.marker = writer; saveState(project, state); }
        else if (writer === "lane") mutateState(project, "main", (s) => { s.marker = writer; });
        else mutateProject(project, (s) => { s.marker = writer; });
        const store = projectStoreDir(project);
        assert.equal(loadState(project).marker, writer);
        assert.equal(fs.existsSync(legacy), false, `${writer} must not write or lock the project tree`);
        assert.equal(fs.existsSync(path.join(store, "state.json.lock")), false);
        assert.equal(fs.readdirSync(path.join(home, "projects")).length, 1, "no provisional path-hash store");
        if (legacyState) {
          assert.deepEqual(loadState(project).pendingHandoff, state.lanes.main.pendingHandoff);
          assert.equal(fs.readFileSync(path.join(store, "checkpoints", LEGACY_CHECKPOINT), "utf8"), "preserve pending evidence");
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
        else process.env.CONTEXT_BRIDGE_HOME = oldHome;
        if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
        else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
      }
    }
  }
});

test("migration refuses a live legacy launcher before registering or copying a project", () => {
  const storageUrl = pathToFileURL(path.resolve("src/storage.mjs")).href;
  for (const registration of [{ launcher: { pid: process.pid } }, { launchers: { [process.pid]: { lane: "main" } } }]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-live-migrate-"));
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const legacy = path.join(project, ".bridge");
    fs.mkdirSync(legacy, { recursive: true });
    const contents = JSON.stringify({ ...defaultState(project), ...registration });
    fs.writeFileSync(path.join(legacy, "state.json"), contents);
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { migrateLegacyStorage, planLegacyMigration } from ${JSON.stringify(storageUrl)};
        assert.match(planLegacyMigration(${JSON.stringify(project)}).blockers.join(' '), /running launcher/);
        assert.throws(() => migrateLegacyStorage(${JSON.stringify(project)}), /running launcher/);
      `], { encoding: "utf8", env: { ...process.env, CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "" } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(home), false, "refusal must precede registry and backup creation");
      assert.equal(fs.readFileSync(path.join(legacy, "state.json"), "utf8"), contents);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("migration recovers after every observed copy, publication and unlink boundary", { timeout: 60000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-migration-boundaries-"));
  const storageUrl = new URL("../src/storage.mjs", import.meta.url).href;
  let boundaries = null;
  try {
    for (let boundary = 0; boundaries === null || boundary <= boundaries; boundary++) {
      const project = path.join(root, `case-${boundary}`);
      const home = path.join(root, `home-${boundary}`);
      const legacy = path.join(project, ".bridge");
      fs.mkdirSync(path.join(legacy, "checkpoints"), { recursive: true });
      const state = defaultState(project);
      const deltaFile = `.bridge/checkpoints/${LEGACY_CHECKPOINT}`;
      state.lanes.main.pendingInjection = { agent: "codex", id: "native-session", deltaFile, via: "prompt" };
      state.lanes.main.pendingHandoff = { target: "codex", deltaFile };
      const serialized = JSON.stringify(state);
      fs.writeFileSync(path.join(legacy, "state.json"), serialized);
      fs.writeFileSync(path.join(legacy, "checkpoints", LEGACY_CHECKPOINT), "exact pending delta");
      const env = { ...process.env, CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "", PATH: "" };
      delete env.CONTEXT_BRIDGE_ADAPTERS;
      const run = (source) => spawnSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8", timeout: 10000 });
      const interrupted = run(`
        import fs from 'node:fs';
        import { migrateLegacyStorage } from ${JSON.stringify(storageUrl)};
        let count = 0;
        const operations = [];
        for (const name of ['copyFileSync', 'renameSync', 'unlinkSync']) {
          const original = fs[name];
          fs[name] = (...args) => {
            const result = original(...args);
            operations.push(name);
            if (++count === ${boundary}) process.exit(79);
            return result;
          };
        }
        migrateLegacyStorage(${JSON.stringify(project)});
        console.log(JSON.stringify({ count, operations }));
      `);
      if (boundary === 0) {
        assert.equal(interrupted.status, 0, interrupted.stderr);
        const report = JSON.parse(interrupted.stdout);
        boundaries = report.count;
        t.diagnostic(`Exercising ${boundaries} real process-exit boundaries; dead-owner lock grace is simulated.`);
        assert.ok(boundaries > 5 && boundaries < 100, "fixture must exercise a bounded real migration");
        assert.deepEqual([...new Set(report.operations)].sort(), ["copyFileSync", "renameSync", "unlinkSync"]);
      } else {
        assert.equal(interrupted.status, 79, `boundary ${boundary}: ${interrupted.stderr}`);
        // Recovery intentionally waits 15 seconds for an unstamped lock. Model
        // elapsed grace only after the real child has exited, never for a live owner.
        const ageLocks = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) ageLocks(file);
            else if (entry.isFile() && entry.name.endsWith(".lock")) {
              assert.equal(Number(fs.readFileSync(file, "utf8").trim()), interrupted.pid);
              assert.throws(() => process.kill(interrupted.pid, 0), { code: "ESRCH" });
              fs.utimesSync(file, new Date(0), new Date(0));
            }
          }
        };
        ageLocks(home);
      }
      const retried = run(`
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        import { migrateLegacyStorage, projectStoreDir } from ${JSON.stringify(storageUrl)};
        migrateLegacyStorage(${JSON.stringify(project)});
        const store = projectStoreDir(${JSON.stringify(project)});
        assert.equal(fs.readFileSync(store + '/state.json', 'utf8'), ${JSON.stringify(serialized)});
        assert.equal(fs.readFileSync(store + '/checkpoints/' + ${JSON.stringify(LEGACY_CHECKPOINT)}, 'utf8'), 'exact pending delta');
        assert.equal(migrateLegacyStorage(${JSON.stringify(project)}), false);
      `);
      assert.equal(retried.status, 0, `retry at boundary ${boundary}: ${retried.stderr}`);
      assert.equal(fs.existsSync(legacy), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("copy-stage process exits preserve the original pending handoff and recover on retry", () => {
  const storageUrl = pathToFileURL(path.resolve("src/storage.mjs")).href;
  const stateUrl = pathToFileURL(path.resolve("src/state.mjs")).href;
  for (const [point, alter] of [["target-copy", false], ["target-installed", false], ["backup-copy", false], ["backup-installed", false], ["target-copy", true]]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-copy-crash-"));
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    const legacy = path.join(project, ".bridge");
    fs.mkdirSync(path.join(legacy, "checkpoints"), { recursive: true });
    const state = defaultState(project);
    const deltaFile = `.bridge/checkpoints/${LEGACY_CHECKPOINT}`;
    state.lanes.main.pendingInjection = { agent: "codex", id: "pending-target", deltaFile, via: "prompt" };
    state.lanes.main.pendingHandoff = { target: "codex", deltaFile };
    const serialized = JSON.stringify(state);
    fs.writeFileSync(path.join(legacy, "state.json"), serialized);
    fs.writeFileSync(path.join(legacy, "checkpoints", LEGACY_CHECKPOINT), "pending evidence");
    const env = { ...process.env, CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "", PATH: "" };
    const run = (source) => spawnSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8" });
    try {
      const crash = run(`
        import fs from 'node:fs';
        import path from 'node:path';
        import { migrateLegacyStorage } from ${JSON.stringify(storageUrl)};
        const point = ${JSON.stringify(point)};
        const copy = fs.copyFileSync;
        fs.copyFileSync = function(source, target) {
          copy.call(fs, source, target);
          if (point === 'target-copy' && target.includes(path.sep + 'projects' + path.sep)) process.exit(79);
          if (point === 'backup-copy' && target.includes(path.sep + 'migrations' + path.sep)) process.exit(79);
        };
        const rename = fs.renameSync;
        fs.renameSync = function(source, target) {
          rename.call(fs, source, target);
          if (point === 'target-installed' && source.includes('.migrating-') && target.includes(path.sep + 'projects' + path.sep)) process.exit(79);
          if (point === 'backup-installed' && source.includes('.migrating-') && target.includes(path.sep + 'migrations' + path.sep)) process.exit(79);
        };
        migrateLegacyStorage(${JSON.stringify(project)});
      `);
      assert.equal(crash.status, 79, `${point}: ${crash.stderr}`);
      assert.equal(fs.readFileSync(path.join(legacy, "state.json"), "utf8"), serialized);
      assert.equal(fs.readFileSync(path.join(legacy, "checkpoints", LEGACY_CHECKPOINT), "utf8"), "pending evidence");
      const registry = JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf8"));
      const id = Object.keys(registry.projects)[0];
      const stages = [path.join(home, "projects"), path.join(home, "migrations")]
        .flatMap((dir) => fs.readdirSync(dir).filter((name) => name.includes(".migrating-")).map((name) => path.join(dir, name)));
      assert.equal(stages.length, point.endsWith("copy") ? 1 : 0);
      if (alter) fs.writeFileSync(path.join(stages[0], "user-note.txt"), "keep this changed staging file");
      const liveStage = path.join(home, "projects", `${id}.migrating-${process.pid}-123`);
      fs.mkdirSync(liveStage);
      fs.writeFileSync(path.join(liveStage, "state.json"), serialized);
      const linkedStage = path.join(home, "projects", `${id}.migrating-${crash.pid}-456`);
      fs.symlinkSync(project, linkedStage);
      const preview = run(`import { planLegacyMigration } from ${JSON.stringify(storageUrl)};
        console.log(JSON.stringify(planLegacyMigration(${JSON.stringify(project)})));`);
      assert.equal(preview.status, 0, preview.stderr);
      const plan = JSON.parse(preview.stdout);
      assert.deepEqual(plan.staging.removable, alter ? [] : stages);
      assert.ok(plan.staging.retained.some((entry) => entry.path === liveStage && /still alive/.test(entry.reason)));
      assert.ok(plan.staging.retained.some((entry) => entry.path === linkedStage && /not a regular staging directory/.test(entry.reason)));
      if (alter) assert.ok(plan.staging.retained.some((entry) => entry.path === stages[0] && /not verified duplicates/.test(entry.reason)));
      for (const stage of stages) assert.equal(fs.existsSync(stage), true, "preview cannot remove staging");
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(path.join(home, "migrations", `${id}.lock`), old, old);
      const resumed = run(`
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        import { ensureState, safeCheckpointPath } from ${JSON.stringify(stateUrl)};
        const s = ensureState(${JSON.stringify(project)});
        assert.deepEqual(s.pendingInjection, ${JSON.stringify(state.lanes.main.pendingInjection)});
        assert.deepEqual(s.pendingHandoff, ${JSON.stringify(state.lanes.main.pendingHandoff)});
        assert.equal(fs.readFileSync(safeCheckpointPath(${JSON.stringify(project)}, s.pendingInjection.deltaFile), 'utf8'), 'pending evidence');
      `);
      assert.equal(resumed.status, 0, `${point}: ${resumed.stderr}`);
      assert.equal(fs.existsSync(legacy), false);
      for (const stage of stages) assert.equal(fs.existsSync(stage), alter, "only verified abandoned copies may be removed");
      assert.equal(fs.readFileSync(path.join(liveStage, "state.json"), "utf8"), serialized);
      assert.equal(fs.lstatSync(linkedStage).isSymbolicLink(), true);
      assert.equal(fs.statSync(project).isDirectory(), true);
      if (alter) assert.equal(fs.readFileSync(path.join(stages[0], "user-note.txt"), "utf8"), "keep this changed staging file");
      const after = run(`import { planLegacyMigration } from ${JSON.stringify(storageUrl)};
        console.log(JSON.stringify(planLegacyMigration(${JSON.stringify(project)})));`);
      assert.equal(after.status, 0, after.stderr);
      const afterPlan = JSON.parse(after.stdout);
      assert.equal(afterPlan.needed, false);
      assert.equal(afterPlan.staging.retained.length, alter ? 3 : 2, "retained copies stay visible after migration");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("migration resumes after the process dies during legacy cleanup and refuses changed leftovers", () => {
  const moduleUrl = pathToFileURL(path.resolve("src/storage.mjs")).href;
  for (const [point, changed] of [["first", false], ["first", true], ["last", false], ["removed-root", false]]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-migration-crash-"));
    const project = path.join(root, "project");
    const legacy = path.join(project, ".bridge");
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(legacy, "checkpoints"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "state.json"), '{"marker":"original state"}');
    fs.writeFileSync(path.join(legacy, "checkpoints", LEGACY_CHECKPOINT), "evidence");
    const env = { ...process.env, CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "" };
    const run = (source) => spawnSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8" });
    try {
      const crash = run(`
        import fs from 'node:fs';
        import { migrateLegacyStorage } from ${JSON.stringify(moduleUrl)};
        const unlink = fs.unlinkSync;
        fs.unlinkSync = function(file) {
          unlink.call(fs, file);
          if (${JSON.stringify(point)} === 'first' && String(file).startsWith(${JSON.stringify(legacy + path.sep)})) process.exit(79);
          if (${JSON.stringify(point)} === 'last' && file === ${JSON.stringify(path.join(legacy, "state.json"))}) process.exit(79);
        };
        const rmdir = fs.rmdirSync;
        fs.rmdirSync = function(file) {
          rmdir.call(fs, file);
          if (${JSON.stringify(point)} === 'removed-root' && file === ${JSON.stringify(legacy)}) process.exit(79);
        };
        migrateLegacyStorage(${JSON.stringify(project)});
      `);
      assert.equal(crash.status, 79, crash.stderr);
      assert.equal(fs.existsSync(path.join(legacy, "checkpoints", LEGACY_CHECKPOINT)), false);
      const registry = JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf8"));
      const id = Object.keys(registry.projects)[0];
      const journal = path.join(home, "migrations", `${id}.json`);
      assert.equal(fs.existsSync(journal), true);
      // The dead child's lock is deliberately aged past the stale-owner grace.
      const lock = path.join(home, "migrations", `${id}.lock`);
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(lock, old, old);
      if (changed) fs.writeFileSync(path.join(legacy, "state.json"), '{"marker":"new user state"}');
      const snapshot = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) =>
        [entry.name, entry.isDirectory() ? snapshot(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name)).toString("hex")]);
      const before = snapshot(root);
      const preview = spawnSync(process.execPath, [path.resolve("bin/bridge.mjs"), "storage", "plan", "--json"], {
        env, cwd: project, encoding: "utf8",
      });
      const plan = JSON.parse(preview.stdout);
      assert.equal(preview.status, changed ? 1 : 0, preview.stderr + preview.stdout);
      assert.equal(plan.needed, true);
      assert.equal(plan.recovery.action, "finish-source-cleanup");
      if (changed) assert.match(plan.blockers.join(" "), /changed before removal/);
      else {
        assert.deepEqual(plan.blockers, []);
        assert.deepEqual(plan.removedEntries, point === "first" ? ["state.json"] : []);
      }
      assert.deepEqual(snapshot(root), before, "preview must not finish cleanup, remove locks or change the journal");
      const resumed = run(`import { migrateLegacyStorage } from ${JSON.stringify(moduleUrl)};
        migrateLegacyStorage(${JSON.stringify(project)});`);
      if (changed) {
        assert.notEqual(resumed.status, 0);
        assert.match(resumed.stderr, /changed before removal/);
        assert.equal(fs.readFileSync(path.join(legacy, "state.json"), "utf8"), '{"marker":"new user state"}');
        assert.equal(fs.existsSync(journal), true);
      } else {
        assert.equal(resumed.status, 0, resumed.stderr);
        assert.equal(fs.existsSync(legacy), false);
        assert.equal(fs.existsSync(journal), false);
      }
      assert.equal(fs.readFileSync(path.join(home, "projects", id, "state.json"), "utf8"), '{"marker":"original state"}');
      assert.equal(fs.readFileSync(path.join(home, "projects", id, "checkpoints", LEGACY_CHECKPOINT), "utf8"), "evidence");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

function tempProject(git = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-storage-"));
  if (git) {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Bridge Test"]);
  }
  return dir;
}

test("a global project-store symlink cannot read, write or prune another project's state", () => {
  const first = tempProject(false);
  const second = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-store-alias-"));
  process.env.CONTEXT_BRIDGE_HOME = runtimeHome;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    ensureState(first);
    ensureState(second);
    const firstStore = projectStoreDir(first);
    const secondStore = projectStoreDir(second);
    const filename = "2020-01-01T00-00-00-000Z-claude-to-codex.md";
    writeCheckpoint(second, "main", filename, "second project evidence");
    const stateBefore = fs.readFileSync(path.join(secondStore, "state.json"), "utf8");
    fs.renameSync(firstStore, `${firstStore}-preserved`);
    fs.symlinkSync(secondStore, firstStore);
    assert.throws(() => loadState(first), /Unsafe bridge project storage directory/);
    assert.throws(() => writeCheckpoint(first, "main", filename, "overwritten"), /Unsafe bridge project storage directory/);
    assert.equal(pruneCheckpoints(first, { all: true }).deletedFiles, 0);
    assert.equal(fs.readFileSync(path.join(secondStore, "state.json"), "utf8"), stateBefore);
    assert.equal(fs.readFileSync(path.join(secondStore, "checkpoints", filename), "utf8"), "second project evidence");
    fs.unlinkSync(firstStore);
    fs.renameSync(`${firstStore}-preserved`, firstStore);
    const projectsRoot = path.join(runtimeHome, "projects");
    fs.renameSync(projectsRoot, `${projectsRoot}-preserved`);
    fs.symlinkSync(`${projectsRoot}-preserved`, projectsRoot);
    assert.throws(() => ensureState(first), /Unsafe bridge project storage directory/);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
  }
});

test("registry project ids cannot escape the global projects directory", () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-registry-path-"));
  process.env.CONTEXT_BRIDGE_HOME = runtimeHome;
  try {
    projectIdentity(project, { create: true });
    const file = path.join(runtimeHome, "projects.json");
    const registry = JSON.parse(fs.readFileSync(file, "utf8"));
    const record = Object.values(registry.projects)[0];
    record.id = "../../outside";
    fs.writeFileSync(file, JSON.stringify(registry));
    assert.throws(() => projectStoreDir(project), /Global bridge registry is invalid/);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
  }
});

test("migration plan is read-only through the CLI even without Git installed", () => {
  const project = tempProject(false);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-plan-"));
  const runtimeHome = path.join(sandbox, "runtime");
  const legacy = path.join(project, ".bridge");
  fs.mkdirSync(legacy);
  const original = JSON.stringify(defaultState(project));
  fs.writeFileSync(path.join(legacy, "state.json"), original);
  fs.writeFileSync(path.join(legacy, "personal.txt"), "keep this");
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "bridge.mjs"), "storage", "plan", "--json"], {
    cwd: project, encoding: "utf8",
    env: { ...process.env, PATH: "", CONTEXT_BRIDGE_HOME: runtimeHome, CONTEXT_BRIDGE_STORAGE: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.needed, true);
  assert.equal(plan.createsIdentity, true);
  assert.equal(plan.target, null, "a read-only plan must not invent the future UUID");
  assert.deepEqual(plan.removedEntries, ["state.json"]);
  assert.deepEqual(plan.retainedEntries, ["personal.txt"]);
  assert.equal(plan.files.length, 2);
  assert.equal(plan.bytes, Buffer.byteLength(original) + 9);
  assert.deepEqual(plan.blockers, []);
  assert.equal(fs.readFileSync(path.join(legacy, "state.json"), "utf8"), original);
  assert.equal(fs.readFileSync(path.join(legacy, "personal.txt"), "utf8"), "keep this");
  assert.equal(fs.existsSync(runtimeHome), false);
});

test("explicit adoption reconnects a different-inode directory without Git or changing stored evidence", () => {
  const source = tempProject(false);
  const moved = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-adopt-home-"));
  process.env.CONTEXT_BRIDGE_HOME = runtimeHome;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    ensureState(source);
    const identity = projectIdentity(source);
    const store = projectStoreDir(source);
    writeCheckpoint(source, "main", "2026-09-16T00-00-00-000Z-claude-to-codex.md", "preserved evidence");
    const originalState = fs.readFileSync(path.join(store, "state.json"), "utf8");
    // A different inode models copy-and-remove moves across filesystems; retain
    // the fixture directory elsewhere so the test cannot accidentally reuse it.
    fs.renameSync(source, `${source}-retired`);
    assert.notEqual(projectIdentity(moved).fileIdentity, identity.fileIdentity);
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "bridge.mjs"), "project", "adopt", identity.id, "--json"], {
      cwd: moved, encoding: "utf8",
      env: { ...process.env, PATH: "", CONTEXT_BRIDGE_STORAGE: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).id, identity.id);
    assert.equal(projectStoreDir(moved), store);
    assert.equal(fs.readFileSync(path.join(store, "state.json"), "utf8"), originalState);
    assert.equal(fs.readFileSync(path.join(checkpointsDir(moved), "2026-09-16T00-00-00-000Z-claude-to-codex.md"), "utf8"), "preserved evidence");
    assert.equal(loadState(moved).version, 5);
    assert.deepEqual(fs.readdirSync(moved), []);
    const registry = fs.readFileSync(path.join(runtimeHome, "projects.json"), "utf8");
    assert.equal(adoptProject(moved, identity.id).id, identity.id);
    assert.equal(fs.readFileSync(path.join(runtimeHome, "projects.json"), "utf8"), registry, "repeating adoption must be a no-op");
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
  }
});

test("adoption refuses live originals, registered targets and legacy state without changing the registry", () => {
  const source = tempProject(false);
  const target = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  process.env.CONTEXT_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-adopt-refusal-"));
  try {
    const id = projectIdentity(source, { create: true }).id;
    const registryPath = path.join(storageHome(), "projects.json");
    let before = fs.readFileSync(registryPath, "utf8");
    assert.throws(() => adoptProject(target, id), /previous project directory still exists/);
    assert.equal(fs.readFileSync(registryPath, "utf8"), before);
    fs.renameSync(source, `${source}-retired`);
    fs.mkdirSync(path.join(target, ".bridge"));
    fs.writeFileSync(path.join(target, ".bridge", "state.json"), "independent state");
    assert.throws(() => adoptProject(target, id), /legacy bridge state/);
    assert.equal(fs.readFileSync(registryPath, "utf8"), before);
    fs.renameSync(path.join(target, ".bridge"), path.join(target, "saved-state"));
    projectIdentity(target, { create: true });
    before = fs.readFileSync(registryPath, "utf8");
    assert.throws(() => adoptProject(target, id), /already registered/);
    assert.equal(fs.readFileSync(registryPath, "utf8"), before);
    assert.throws(() => adoptProject(target, "../../other"), /requires a project UUID/);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
  }
});

test("migration plan reports content conflicts and symlinks without changing either store", () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  process.env.CONTEXT_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-plan-conflict-"));
  try {
    const legacy = path.join(project, ".bridge");
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, "state.json"), '{"marker":"legacy"}');
    const target = projectStoreDir(project, { createIdentity: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "state.json"), "global");
    const registry = fs.readFileSync(path.join(storageHome(), "projects.json"), "utf8");
    const plan = planLegacyMigration(project);
    assert.equal(plan.target, target);
    assert.match(plan.blockers.join(" "), /different contents/);
    fs.symlinkSync(target, path.join(legacy, "outside"));
    assert.match(planLegacyMigration(project).blockers.join(" "), /symlinked/);
    assert.equal(fs.readFileSync(path.join(storageHome(), "projects.json"), "utf8"), registry);
    assert.equal(fs.readFileSync(path.join(legacy, "state.json"), "utf8"), '{"marker":"legacy"}');
    assert.equal(fs.readFileSync(path.join(target, "state.json"), "utf8"), "global");
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
  }
});

test("a Git project is locatable without creating a project-root .bridge", () => {
  const project = tempProject();
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  try {
    const identity = projectIdentity(project);
    assert.equal(identity.kind, "path-locator", "read-only discovery must not mutate Git config");
    assert.equal(identity.portable, false);
    assert.equal(fs.existsSync(legacyBridgeDir(project)), false);
    assert.equal(projectStoreDir(project), path.join(home, "projects", identity.id));
    assert.equal(runtimePath(project, "state.json"), path.join(home, "projects", identity.id, "state.json"));
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
  }
});

test("production storage keeps state and checkpoints outside the project tree", () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldStorage = process.env.CONTEXT_BRIDGE_STORAGE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-production-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    const before = fs.readdirSync(project).sort();
    ensureState(project);
    const rel = writeCheckpoint(project, "main", "2026-09-16T00-00-00-000Z-claude-to-codex.md", "context");
    assert.equal(rel, path.join(".bridge", "checkpoints", "2026-09-16T00-00-00-000Z-claude-to-codex.md"));
    assert.equal(fs.existsSync(path.join(project, ".bridge")), false);
    assert.deepEqual(fs.readdirSync(project).sort(), before, "first use must not add project files or a Git ignore rule");
    assert.equal(fs.existsSync(path.join(bridgeDir(project), "state.json")), true);
    assert.equal(fs.readFileSync(path.join(checkpointsDir(project), path.basename(rel)), "utf8"), "context");
    assert.equal(loadState(project).version, 5);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldStorage === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldStorage;
  }
});

test("doctor JSON exposes storage diagnostics without creating project files", () => {
  const project = tempProject(false);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-doctor-storage-home-"));
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "bridge.mjs"), "doctor", "--json"], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "" },
  });
  assert.ok([0, 1].includes(result.status), result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.bridge.storage.mode, "global");
  assert.equal(report.bridge.storage.gitOptional, true);
  assert.equal(fs.existsSync(path.join(project, ".bridge")), false);
});

test("direct config writes use global storage without touching the project", () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldStorage = process.env.CONTEXT_BRIDGE_STORAGE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    saveConfig(project, { version: 1, agents: { codex: { args: ["--full-auto"] } } });
    assert.equal(fs.existsSync(path.join(project, ".bridge")), false);
    assert.deepEqual(loadConfig(project).agents.codex.args, ["--full-auto"]);
    assert.equal(fs.existsSync(path.join(projectStoreDir(project), "config.json")), true);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldStorage === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldStorage;
  }
});

test("production audit manifests are written and read from global storage", () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldStorage = process.env.CONTEXT_BRIDGE_STORAGE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-audit-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    const rel = writeManifest(project, "main", "2026-09-16T00-00-00-000Z-claude-to-codex", {
      manifestVersion: 1, source: "claude", target: "codex", agents: {},
    });
    assert.equal(fs.existsSync(path.join(project, rel)), false);
    assert.deepEqual(latestManifest(project).manifest, {
      manifestVersion: 1, source: "claude", target: "codex", agents: {},
    });
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldStorage === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldStorage;
  }
});

test("a direct production checkpoint write registers the project before writing", () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldStorage = process.env.CONTEXT_BRIDGE_STORAGE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-direct-checkpoint-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    writeCheckpoint(project, "main", "2026-09-16T00-00-00-000Z-claude-to-codex.md", "direct");
    const registered = projectStoreDir(project, { createIdentity: true });
    assert.equal(fs.readFileSync(path.join(registered, "checkpoints", "2026-09-16T00-00-00-000Z-claude-to-codex.md"), "utf8"), "direct");
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldStorage === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldStorage;
  }
});

test("direct writes migrate legacy storage before adding new global data", () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldStorage = process.env.CONTEXT_BRIDGE_STORAGE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-direct-migrate-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    const legacy = path.join(project, ".bridge");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "state.json"), JSON.stringify(defaultState(project), null, 2));
    fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({ version: 1, agents: {} }));
    saveConfig(project, { version: 1, agents: { codex: { args: ["--full-auto"] } } });
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.existsSync(path.join(projectStoreDir(project), "config.json")), true);
    assert.deepEqual(loadConfig(project).agents.codex.args, ["--full-auto"]);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldStorage === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldStorage;
  }
});

test("CLI lane creation works in a Git-less project without a project-root store", () => {
  const project = tempProject(false);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cli-home-"));
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "bridge.mjs"), "lane", "new", "feature"], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(project, ".bridge")), false);
  assert.equal(fs.existsSync(path.join(home, "projects")), true);
  assert.match(result.stdout, /feature/);
});

for (const withGit of [false, true]) test(`a registered project survives a same-filesystem move (${withGit ? "Git fixture" : "no Git"})`, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-move-"));
  const project = tempProject(withGit);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  const before = projectIdentity(project, { create: true });
  const moved = path.join(parent, "moved");
  fs.renameSync(project, moved);
  const canonicalMoved = fs.realpathSync.native(moved);
  assert.equal(gitRoot(moved), withGit ? canonicalMoved : null);
  assert.deepEqual(projectIdentity(moved), {
    kind: "local",
    id: before.id,
    root: canonicalMoved,
    portable: false,
    fileIdentity: projectIdentity(moved).fileIdentity,
  });
  assert.notEqual(pathLocator(moved), before.id);
  if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
  else process.env.CONTEXT_BRIDGE_HOME = oldHome;
});

test("two clones without a marker have distinct provisional locators", () => {
  const a = tempProject();
  const b = tempProject();
  assert.notEqual(projectIdentity(a).id, projectIdentity(b).id);
  assert.equal(gitProjectId(a), null);
  assert.equal(gitProjectId(b), null);
});

test("a non-Git project has a path locator and no fake Git identity", () => {
  const project = tempProject(false);
  const identity = projectIdentity(project);
  assert.equal(identity.kind, "path-locator");
  assert.equal(identity.portable, false);
  assert.equal(identity.root, fs.realpathSync.native(project));
  assert.match(identity.id, /^[0-9a-f]{32}$/);
});

test("project identity still works when Git is unavailable", () => {
  const project = tempProject(false);
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "storage.mjs")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { projectIdentity } from ${JSON.stringify(moduleUrl)};
    const identity = projectIdentity(${JSON.stringify(project)});
    if (identity.kind !== "path-locator" || identity.portable !== false) process.exit(2);
  `], { encoding: "utf8", env: { ...process.env, PATH: "" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("legacy project-local storage migrates to global storage without Git", () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldStorage = process.env.CONTEXT_BRIDGE_STORAGE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-migrate-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    const legacy = path.join(project, ".bridge");
    fs.mkdirSync(path.join(legacy, "checkpoints"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "state.json"), JSON.stringify(defaultState(project), null, 2));
    fs.writeFileSync(path.join(legacy, "checkpoints", LEGACY_CHECKPOINT), "old checkpoint");
    const state = ensureState(project);
    assert.equal(state.version, 5);
    assert.equal(fs.existsSync(legacy), false, "successful migration removes only the old bridge directory");
    assert.equal(fs.existsSync(path.join(project, ".git")), false);
    assert.equal(fs.existsSync(path.join(projectStoreDir(project), "state.json")), true);
    assert.equal(fs.readFileSync(path.join(projectStoreDir(project), "checkpoints", LEGACY_CHECKPOINT), "utf8"), "old checkpoint");
    assert.equal(fs.readdirSync(path.join(home, "migrations")).length, 1, "the old tree remains recoverable globally");
    assert.equal(loadState(project)?.version, 5);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldStorage === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldStorage;
  }
});

test("migration preserves unknown legacy entries instead of deleting them", () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldStorage = process.env.CONTEXT_BRIDGE_STORAGE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-migrate-unknown-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    const legacy = path.join(project, ".bridge");
    fs.mkdirSync(path.join(legacy, "checkpoints"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "state.json"), JSON.stringify(defaultState(project)));
    fs.writeFileSync(path.join(legacy, "checkpoints", LEGACY_CHECKPOINT), "old");
    fs.writeFileSync(path.join(legacy, "user-owned.txt"), "do not delete");
    fs.mkdirSync(path.join(legacy, "checkpoints", "empty-user-folder"));
    const nested = ["checkpoints/research.txt", "lanes/feature/checkpoints/scratch.txt", "logs/personal.log"];
    for (const name of nested) {
      fs.mkdirSync(path.dirname(path.join(legacy, name)), { recursive: true });
      fs.writeFileSync(path.join(legacy, name), "user evidence");
    }
    assert.deepEqual(planLegacyMigration(project).retainedEntries.sort(), [...nested, "user-owned.txt"].sort());
    ensureState(project);
    assert.equal(fs.readFileSync(path.join(legacy, "user-owned.txt"), "utf8"), "do not delete");
    assert.equal(fs.existsSync(path.join(projectStoreDir(project), "state.json")), true);
    const backups = fs.readdirSync(path.join(home, "migrations"));
    assert.equal(ensureState(project).version, 5, "preserved files must not trigger another migration");
    saveConfig(project, { version: 1, agents: { codex: { args: ["--full-auto"] } } });
    assert.deepEqual(loadConfig(project).agents.codex.args, ["--full-auto"]);
    assert.deepEqual(fs.readdirSync(path.join(home, "migrations")), backups);
    for (const name of nested) assert.equal(fs.readFileSync(path.join(legacy, name), "utf8"), "user evidence");
    assert.equal(fs.statSync(path.join(legacy, "checkpoints", "empty-user-folder")).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(legacy, "checkpoints", LEGACY_CHECKPOINT)), false);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldStorage === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldStorage;
  }
});

test("concurrent migration leaves one complete global store and no partial source removal", async () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldStorage = process.env.CONTEXT_BRIDGE_STORAGE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-migrate-race-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    const legacy = path.join(project, ".bridge");
    fs.mkdirSync(path.join(legacy, "checkpoints"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "state.json"), JSON.stringify(defaultState(project)));
    fs.writeFileSync(path.join(legacy, "checkpoints", LEGACY_CHECKPOINT), "old");
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "src", "storage.mjs")).href;
    const script = `import { migrateLegacyStorage } from ${JSON.stringify(moduleUrl)}; migrateLegacyStorage(${JSON.stringify(project)});`;
    const env = { ...process.env, CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "" };
    const run = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => resolve({ status, stderr }));
    });
    const [a, b] = await Promise.all([run(), run()]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(fs.readFileSync(path.join(projectStoreDir(project), "checkpoints", LEGACY_CHECKPOINT), "utf8"), "old");
    assert.equal(fs.existsSync(path.join(legacy, "state.json")), false);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldStorage === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldStorage;
  }
});

test("a corrupt global registry fails closed instead of selecting a new identity", () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-corrupt-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  try {
    fs.writeFileSync(path.join(storageHome(), "projects.json"), "{not valid json");
    assert.throws(
      () => projectIdentity(project),
      /Global bridge registry could not be read.*Refusing to select a new project identity/
    );
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
  }
});

test("migration refuses conflicting global contents without deleting legacy data", () => {
  const project = tempProject(false);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldStorage = process.env.CONTEXT_BRIDGE_STORAGE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-conflict-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    const legacy = path.join(project, ".bridge");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "state.json"), '{"marker":"legacy"}');
    const target = projectStoreDir(project, { createIdentity: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "state.json"), "different global state");
    assert.throws(() => ensureState(project), /different contents/);
    assert.equal(fs.readFileSync(path.join(legacy, "state.json"), "utf8"), '{"marker":"legacy"}');
    assert.equal(fs.readFileSync(path.join(target, "state.json"), "utf8"), "different global state");
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldStorage === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldStorage;
  }
});
