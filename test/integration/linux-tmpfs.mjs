// Actual birthtime-free filesystem acceptance; isolated, no Git or agent accounts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { projectIdentity, registeredProjects, adoptProject } from "../../src/storage.mjs";
import { directoryIdentity } from "../../src/directory-identity.mjs";
import { loadState, mutateProject, writeCheckpoint, safeCheckpointPath } from "../../src/state.mjs";
import { watchProject } from "../../src/watch.mjs";

assert.equal(process.platform, "linux");
const root = fs.mkdtempSync("/dev/shm/bridge-tmpfs-acceptance-");
const external = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-tmpfs-adopt-"));
const cli = fileURLToPath(new URL("../../bin/bridge.mjs", import.meta.url));
process.env.CONTEXT_BRIDGE_HOME = path.join(root, "home");
delete process.env.CONTEXT_BRIDGE_STORAGE;
delete process.env.CONTEXT_BRIDGE_ADAPTERS;
const project = path.join(root, "project"), moved = path.join(root, "moved");
const run = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: project, env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
};
let client;
try {
  fs.mkdirSync(project);
  const actualBirthtime = fs.statSync(project, { bigint: true }).birthtimeNs;
  const simulatedMissingBirthtime = process.argv.includes("--simulate-missing-birthtime");
  if (simulatedMissingBirthtime) {
    // New kernels supply tmpfs birthtime. Hide only that metadata in this fixture;
    // the fallback's native filesystem/handle calls still run without mocks.
    const preload = path.join(root, "missing-birthtime.mjs");
    fs.writeFileSync(preload, `import fs from 'node:fs'; import path from 'node:path';
const original = fs.statSync, originalFd = fs.fstatSync, root = ${JSON.stringify(root)};
const hide = (info, file, options) => {
  const resolved = path.resolve(String(file));
  if (options?.bigint && info.isDirectory() && (resolved === root || resolved.startsWith(root + path.sep))) info.birthtimeNs = 0n;
  return info;
};
fs.statSync = (file, ...args) => {
  return hide(original(file, ...args), file, args[0]);
};
fs.fstatSync = (fd, ...args) => {
  return hide(originalFd(fd, ...args), fs.readlinkSync('/proc/self/fd/' + fd), args[0]);
};\n`);
    const url = pathToFileURL(preload).href;
    await import(url);
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --import=${url}`.trim();
  }
  assert.equal(fs.statSync(project, { bigint: true }).birthtimeNs, 0n);
  assert.match(directoryIdentity(project), /^v3:linux-tmpfs:/);
  assert.equal(JSON.parse(run("status", "--json")).state, "absent");
  assert.equal(fs.existsSync(process.env.CONTEXT_BRIDGE_HOME), false);
  client = new Client({ name: "tmpfs-acceptance", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [cli, "mcp", "--project", project], env: { ...process.env, PATH: "" }, stderr: "pipe" }));
  assert.equal((await client.callTool({ name: "bridge_status", arguments: {} })).structuredContent.state, "absent");
  assert.equal(fs.existsSync(process.env.CONTEXT_BRIDGE_HOME), false);
  run("lane", "new", "work");
  const original = projectIdentity(project).id;
  mutateProject(project, (state) => { state.tmpfsSecret = "retained original only"; });
  const evidence = writeCheckpoint(project, "work", "2026-09-18T00-00-00-000Z-claude-to-codex.md", "complete evidence");
  assert.equal(fs.readFileSync(safeCheckpointPath(project, evidence), "utf8"), "complete evidence");
  assert.throws(() => writeCheckpoint(project, "work", "2026-09-18T00-00-00-000Z-claude-to-codex.md", "replacement"), { code: "EEXIST" });
  assert.equal(fs.readFileSync(safeCheckpointPath(project, evidence), "utf8"), "complete evidence");
  assert.equal(registeredProjects().find((record) => record.id === original).availability, "present");
  assert.deepEqual(fs.readdirSync(project), []);
  fs.renameSync(project, moved);
  assert.equal(projectIdentity(moved, { create: true }).id, original);
  fs.mkdirSync(project);
  assert.equal((await client.callTool({ name: "bridge_status", arguments: {} })).isError, true);
  await client.close(); client = null;
  run("lane", "new", "new-project");
  assert.notEqual(projectIdentity(project).id, original);
  assert.equal(loadState(project).tmpfsSecret, undefined);
  assert.equal(loadState(moved).tmpfsSecret, "retained original only");

  const controller = new AbortController(), events = [];
  await watchProject(project, { policy: "read-only", interval: 100, signal: controller.signal,
    emit(event) {
      events.push(event.type);
      if (event.type === "snapshot") { fs.renameSync(project, path.join(root, "watched-original")); fs.mkdirSync(project); }
      else controller.abort();
    } });
  assert.deepEqual(events, ["snapshot", "unavailable"]);

  const race = path.join(root, "race"); fs.mkdirSync(race);
  const open = fs.openSync;
  const registry = path.join(process.env.CONTEXT_BRIDGE_HOME, "projects.json");
  const before = fs.readFileSync(registry);
  let injected = false;
  fs.openSync = (name, ...args) => {
    const fd = open(name, ...args);
    if (name === race && !injected) { injected = true; fs.renameSync(race, race + "-old"); fs.mkdirSync(race); }
    return fd;
  };
  try { assert.throws(() => projectIdentity(race, { create: true }), { code: "BRIDGE_PROJECT_IDENTITY_UNAVAILABLE" }); }
  finally { fs.openSync = open; }
  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(registry), before);

  const copied = path.join(external, "adopted"); fs.mkdirSync(copied);
  assert.notEqual(fs.statSync(copied).dev, fs.statSync(moved).dev);
  fs.rmdirSync(moved);
  assert.equal(adoptProject(copied, original).id, original);
  assert.equal(loadState(copied).tmpfsSecret, "retained original only");
  assert.deepEqual(fs.readdirSync(copied), []);
  console.log(JSON.stringify({ passed: true, platform: process.platform, uid: process.getuid(),
    birthtime: false, actualBirthtimeAvailable: actualBirthtime > 0n, simulatedMissingBirthtime,
    cli: true, mcp: true, watch: true, replacementRefused: true,
    identityRaceRefused: true, crossFilesystemAdoption: true, exclusivePublication: true,
    gitRequired: false, nativeAgents: false, node: process.version, arch: process.arch }));
} finally {
  await client?.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(external, { recursive: true, force: true });
}
