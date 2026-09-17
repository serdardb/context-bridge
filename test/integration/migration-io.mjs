// Opt-in fault matrix for the real global migration, not the unit-test loop.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateLegacyStorage, projectStoreDir } from "../../src/storage.mjs";
import { defaultState } from "../../src/state.mjs";

const self = fileURLToPath(import.meta.url);
const worker = process.argv[2] === "--worker";
if (worker) {
  const project = process.argv[3], fault = Number(process.argv[4]);
  const legacy = path.join(project, ".bridge");
  const expected = fs.readFileSync(path.join(legacy, "state.json"));
  const methods = ["mkdirSync", "openSync", "writeFileSync", "writeSync"];
  const originals = Object.fromEntries(methods.map((name) => [name, fs[name]]));
  const close = fs.closeSync;
  const descriptors = new Set();
  const operations = [];
  let injected = false, failure;
  const managed = (p) => typeof p === "string" &&
    [project, process.env.CONTEXT_BRIDGE_HOME].some((root) => p === root || p.startsWith(root + path.sep));
  fs.closeSync = (fd) => { const result = close(fd); descriptors.delete(fd); return result; };
  for (const name of methods) {
    fs[name] = (...args) => {
      const flags = args[1];
      const writing = name !== "openSync" || (typeof flags === "string"
        ? /[wa+]/.test(flags)
        : !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)));
      const selected = writing && (typeof args[0] === "number" ? descriptors.has(args[0]) : managed(args[0]));
      if (selected) {
        operations.push(name);
        if (operations.length === fault) {
          injected = true;
          throw Object.assign(new Error("injected migration I/O failure"), { code: "ENOSPC" });
        }
      }
      const result = originals[name](...args);
      if (name === "openSync" && managed(args[0])) descriptors.add(result);
      return result;
    };
  }
  try { migrateLegacyStorage(project); } catch (error) { failure = error; }
  finally {
    for (const name of methods) fs[name] = originals[name];
    fs.closeSync = close;
  }
  if (fault === 0) assert.ifError(failure);
  else assert.ok(injected, `fault ${fault} was not reached`);

  // At least one original copy must survive even before any recovery runs.
  const copies = [];
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, item.name);
      if (item.isDirectory()) scan(p);
      else if (item.isFile() && item.name === "state.json") copies.push(fs.readFileSync(p));
    }
  };
  scan(project);
  scan(process.env.CONTEXT_BRIDGE_HOME);
  assert.ok(copies.some((bytes) => bytes.equals(expected)), "failure must preserve original state before retry");
  migrateLegacyStorage(project);
  const store = projectStoreDir(project);
  assert.deepEqual(fs.readFileSync(path.join(store, "state.json")), expected);
  assert.equal(fs.readFileSync(path.join(store, "checkpoints", "2026-09-18T00-00-00-000Z-claude-to-codex.md"), "utf8"), "pending context\n");
  assert.equal(fs.readFileSync(path.join(legacy, "user-owned.txt"), "utf8"), "do not remove\n");
  assert.equal(fs.existsSync(path.join(legacy, "state.json")), false);
  assert.equal(migrateLegacyStorage(project), false, "second retry must be a no-op");
  console.log(JSON.stringify({ fault, operations, refused: !!failure, recovered: true }));
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-migration-io-"));
  let count = 0;
  try {
    for (let fault = 0; fault <= count; fault++) {
      const project = path.join(root, `project-${fault}`), home = path.join(root, `home-${fault}`);
      const legacy = path.join(project, ".bridge");
      fs.mkdirSync(path.join(legacy, "checkpoints"), { recursive: true });
      const deltaFile = ".bridge/checkpoints/2026-09-18T00-00-00-000Z-claude-to-codex.md";
      const state = defaultState(project);
      state.lanes.main.pendingInjection = { agent: "codex", id: "fixture", deltaFile, via: "prompt" };
      state.lanes.main.pendingHandoff = { target: "codex", deltaFile };
      fs.writeFileSync(path.join(legacy, "state.json"), JSON.stringify(state));
      fs.writeFileSync(path.join(project, deltaFile), "pending context\n");
      fs.writeFileSync(path.join(legacy, "user-owned.txt"), "do not remove\n");
      const env = { ...process.env, CONTEXT_BRIDGE_HOME: home, CONTEXT_BRIDGE_STORAGE: "", PATH: "" };
      delete env.CONTEXT_BRIDGE_ADAPTERS;
      const child = spawnSync(process.execPath, [self, "--worker", project, String(fault)], {
        env, encoding: "utf8", timeout: 40000,
      });
      assert.equal(child.status, 0, `fault ${fault}: ${child.error?.message ?? child.stderr}`);
      const report = JSON.parse(child.stdout);
      if (fault === 0) {
        count = report.operations.length;
        assert.ok(count > 0 && count < 200, "bounded migration fixture");
        assert.deepEqual([...new Set(report.operations)].sort(), ["mkdirSync", "openSync", "writeFileSync", "writeSync"]);
      }
      console.log(JSON.stringify({ fault, refused: report.refused, recovered: report.recovered }));
    }
    console.log(JSON.stringify({ passed: true, faults: count, gitAvailable: false, nativeAgents: false }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
