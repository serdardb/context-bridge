import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { kernelLockHealth } from "../src/locking.mjs";
import { defaultState } from "../src/state.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));

test("short writes preserve complete registry, migration, state and import owner stamps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-short-stamps-"));
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { migrateLegacyStorage } from './src/storage.mjs';
      import { defaultState, mutateState, writeCheckpoint } from './src/state.mjs';
      import { composeFullContext } from './src/delta.mjs';
      import { exportArtifact, importArtifact } from './src/artifact.mjs';
      const root = ${JSON.stringify(root)}, project = path.join(root, 'project');
      fs.mkdirSync(path.join(project, '.bridge'), { recursive: true });
      fs.writeFileSync(path.join(project, '.bridge/state.json'), JSON.stringify(defaultState(project)));
      const open = fs.openSync, write = fs.writeSync, close = fs.closeSync;
      const descriptors = new Map(), stamps = [], shortened = new Set();
      fs.openSync = (file, ...args) => {
        const fd = open(file, ...args);
        if (typeof file === 'string' && file.endsWith('.lock') && args[0] === 'wx') descriptors.set(fd, file);
        return fd;
      };
      fs.writeSync = (fd, data, ...args) => {
        if (!descriptors.has(fd)) return write(fd, data, ...args);
        shortened.add(descriptors.get(fd));
        if (typeof data === 'string') return write(fd, Buffer.from(data), 0, 1);
        return write(fd, data, args[0], Math.min(1, args[1]), args[2]);
      };
      fs.closeSync = fd => {
        const file = descriptors.get(fd);
        if (file) { stamps.push({ file, text: fs.readFileSync(file, 'utf8') }); descriptors.delete(fd); }
        return close(fd);
      };
      migrateLegacyStorage(project);
      mutateState(project, () => {});
      writeCheckpoint(project, 'main', '2026-09-18T00-00-00-000Z-claude-to-codex-full.md',
        composeFullContext({ fromAgent: 'claude', summary: 'Preserve complete owner metadata', sources: [], decisions: [], work: [], next: [] }));
      const artifact = path.join(root, 'context.cbctx');
      exportArtifact(project, artifact);
      importArtifact(artifact, { projectDir: project, apply: true });
      for (const name of ['projects.json.lock', 'migrations', 'state.json.lock', 'imports'])
        assert.ok(stamps.some(({ file }) => shortened.has(file) && file.split(path.sep).includes(name)), 'missing short-write injection: ' + name);
      for (const { text } of stamps)
        assert.equal(text.trim().split(/\\s+/)[0], String(process.pid), 'a successful short write must not truncate the owner');
    `], { cwd: repo, env: { ...process.env, CONTEXT_BRIDGE_HOME: path.join(root, "home"), CONTEXT_BRIDGE_STORAGE: "" },
      encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native health probes actual acquisition and release without a project", () => {
  const report = kernelLockHealth();
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.platform, process.platform);
  assert.equal(report.arch, process.arch);
});

test("a stalled native backend cannot hang diagnostics", { timeout: 15000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-native-stall-"));
  try {
    fs.copyFileSync(path.join(repo, "src/locking.mjs"), path.join(root, "locking.mjs"));
    fs.copyFileSync(path.join(repo, "src/publication.mjs"), path.join(root, "publication.mjs"));
    fs.mkdirSync(path.join(root, "node_modules/koffi"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/koffi/index.js"),
      'module.exports = { load() { for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } };');
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import {kernelLockHealth} from './locking.mjs'; console.log(JSON.stringify(kernelLockHealth()));`], {
      cwd: root, env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.code, "BRIDGE_LOCK_PROBE_TIMEOUT");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native acquisition errors retain errno without leaking a stack", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-native-error-"));
  try {
    fs.copyFileSync(path.join(repo, "src/locking.mjs"), path.join(root, "locking.mjs"));
    fs.copyFileSync(path.join(repo, "src/publication.mjs"), path.join(root, "publication.mjs"));
    fs.mkdirSync(path.join(root, "node_modules/koffi"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/koffi/index.js"),
      'module.exports = { load: () => ({func: () => () => -1}), errno: () => 13, os: {errno: {EINTR: 4, EAGAIN: 11, EWOULDBLOCK: 35}} };');
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import {kernelLockHealth} from './locking.mjs'; console.log(JSON.stringify(kernelLockHealth()));`], {
      cwd: root, env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.code, "BRIDGE_LOCK_FAILED");
    assert.equal(report.nativeCode, 13);
    assert.equal(report.operation, "kernel-lock:acquire");
    assert.equal(report.stack, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("diagnostics refuse missing native locking and changed migration evidence without destroying stores", { timeout: 60000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-native-missing-"));
  const install = path.join(root, "install"), home = path.join(root, "home");
  const store = path.join(root, "store"), project = path.join(root, "project");
  for (const dir of [install, home, store, project]) fs.mkdirSync(dir);
  for (const name of ["src", "bin", "package.json"]) fs.cpSync(path.join(repo, name), path.join(install, name), { recursive: true });
  // Two ready agents make a missing runtime the ONLY reason doctor/verify fail.
  // They are local contract fixtures, never real model calls or credentials.
  const modules = ["first", "second"].map((id) => {
    const file = path.join(install, `${id}.mjs`);
    fs.writeFileSync(file, `
      import * as base from './src/agents/claude.mjs';
      import { defineAdapter } from './src/adapter-sdk.mjs';
      export default defineAdapter({ ...base, id: '${id}', displayName: '${id}',
        discover: () => null,
        discoveryProbe: () => ({ status: 'none', examined: 0, recognised: 0 }),
        health: () => ({ version: 'fixture', ready: true, auth: { ok: true, via: 'fixture', account: null }, extras: [], installHint: 'fixture' }),
        smokeCommand: () => ({ cmd: process.execPath, args: ['-e', 'console.log("bridge-ok")'] })
      });
    `);
    return file;
  });
  const manifest = path.join(root, "adapters.json");
  fs.writeFileSync(manifest, JSON.stringify({ apiVersion: 1, modules }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"),
    CONTEXT_BRIDGE_HOME: store, CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_ADAPTERS: manifest,
    NODE_PATH: "", NODE_OPTIONS: "", CODEX_THREAD_ID: "", PATH: "" };
  const run = (...args) => spawnSync(process.execPath, [path.join(install, "bin/bridge.mjs"), ...args], {
    cwd: project, env, encoding: "utf8", timeout: 15000,
  });
  try {
    // The copy has the real source, with dependencies initially available.
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(install, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    for (const command of ["doctor", "verify"]) {
      const healthy = run(command, "--json");
      assert.equal(healthy.status, 0, healthy.stderr + healthy.stdout);
      assert.equal(JSON.parse(healthy.stdout).bridge.locking.ok, true);
    }
    fs.unlinkSync(path.join(install, "node_modules"));
    for (const command of ["doctor", "verify"]) {
      const broken = run(command, "--json");
      assert.equal(broken.status, 1, broken.stderr + broken.stdout);
      const report = JSON.parse(broken.stdout);
      assert.equal(report.bridge.locking.ok, false);
      assert.equal(report.bridge.locking.code, "BRIDGE_LOCK_UNAVAILABLE");
      assert.equal(report.routes['first->second'].configured, true);
      if (command === "verify") assert.ok(report.verify.failures.some((f) => f.includes("native locking")));
    }
    const human = run("doctor");
    assert.equal(human.status, 1);
    assert.match(human.stdout, /Native locking/);
    assert.match(human.stdout, /unavailable/);

    for (const legacy of [false, true]) {
      let state, personal;
      if (legacy) {
        fs.mkdirSync(path.join(project, ".bridge"));
        state = Buffer.from(JSON.stringify(defaultState(project)));
        personal = Buffer.from("user-owned content\n");
        fs.writeFileSync(path.join(project, ".bridge/state.json"), state);
        fs.writeFileSync(path.join(project, ".bridge/personal.txt"), personal);
      }
      for (const args of [["status", "--json"], ["storage", "plan", "--json"]]) {
        const read = run(...args);
        assert.equal(read.status, 0, read.stderr);
        assert.doesNotThrow(() => JSON.parse(read.stdout));
      }
      const mutation = run("lane", "new", "experiment");
      assert.equal(mutation.status, 1);
      assert.match(mutation.stderr, /Native locking is unavailable/);
      assert.ok(mutation.stderr.includes(`${process.platform}/${process.arch}`));
      assert.match(mutation.stderr, /optional dependencies/);
      assert.match(mutation.stderr, /next: bridge doctor --json/);
      assert.doesNotMatch(mutation.stderr, /Require stack|\n\s+at /);
      assert.ok(!mutation.stderr.includes(install));
      assert.deepEqual(fs.readdirSync(store), [], "refusal must not create registry, staging or backups");
      assert.deepEqual(fs.readdirSync(project), legacy ? [".bridge"] : []);
      if (legacy) {
        assert.deepEqual(fs.readdirSync(path.join(project, ".bridge")).sort(), ["personal.txt", "state.json"]);
        assert.deepEqual(fs.readFileSync(path.join(project, ".bridge/state.json")), state);
        assert.deepEqual(fs.readFileSync(path.join(project, ".bridge/personal.txt")), personal);
      }
    }
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(install, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const migrated = run("storage", "migrate", "--json");
    assert.equal(migrated.status, 0, migrated.stderr + migrated.stdout);
    const { retired } = JSON.parse(migrated.stdout);
    assert.equal(run("doctor", "--json").status, 0, "healthy completed migration must not make diagnostics fail");
    fs.appendFileSync(path.join(retired, "state.json"), "\nlate old-writer append");
    for (const command of ["doctor", "verify"]) {
      const report = run(command, "--json");
      assert.equal(report.status, 1, report.stderr + report.stdout);
      const data = JSON.parse(report.stdout);
      assert.equal(data.bridge.locking.ok, true);
      assert.match(data.bridge.storage.error, /Retired originals changed/);
      assert.equal(data.routes["first->second"].configured, true, "agent configuration is not the failing gate");
      assert.ok(!data.agents.first.smoke, "storage failure must not spend a model call");
    }
    assert.match(run("doctor").stdout, /Storage error:.*Retired originals changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
