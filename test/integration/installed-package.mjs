import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

// Deliberately load everything from the installed tarball, not this checkout.
const installed = process.argv[2];
assert.ok(installed && path.isAbsolute(installed), "pass an installed package root");
const manifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
assert.equal(manifest.name, "@serdardb/context-bridge");
for (const absent of ["test", "notes", ".bridge"]) assert.equal(fs.existsSync(path.join(installed, absent)), false);
for (const required of ["src/agents/aider_driver.py", "src/agents/aider_lock.py", "codex/SKILL.md"]) {
  assert.ok(fs.statSync(path.join(installed, required)).isFile());
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-installed-"));
const source = path.join(root, "source"), target = path.join(root, "target"), empty = path.join(root, "empty");
for (const dir of [source, target, empty]) fs.mkdirSync(dir);
const env = { ...process.env, HOME: path.join(root, "home"), PATH: "",
  CONTEXT_BRIDGE_HOME: path.join(root, "runtime"), CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_ADAPTERS: "",
  CODEX_THREAD_ID: "", CONTEXT_BRIDGE_LANE: "" };
Object.assign(process.env, env);
const cli = path.join(installed, manifest.bin.bridge);
const run = (cwd, args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
};
const load = (file) => import(pathToFileURL(path.join(installed, file)));

async function verifyInstalledLock() {
  const module = pathToFileURL(path.join(installed, "src/locking.mjs")).href;
  const guard = path.join(root, "acceptance.guard");
  const owner = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withKernelLockSync } from ${JSON.stringify(module)};
    withKernelLockSync(${JSON.stringify(guard)}, () => {
      process.send('held');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
    });
  `], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  owner.stderr.on("data", data => { stderr += data; });
  const closed = new Promise(resolve => owner.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Installed lock owner did not become ready.")), 5000);
      const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      owner.once("message", message => finish(message === "held" ? null : new Error("Invalid lock barrier.")));
      owner.once("error", finish);
      owner.once("exit", () => finish(new Error(stderr || "Lock owner exited before ready.")));
    });
    const inode = fs.statSync(guard).ino;
    const contender = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { withKernelLockSync } from ${JSON.stringify(module)};
      try { withKernelLockSync(${JSON.stringify(guard)}, () => {}); console.log('entered'); }
      catch (error) { console.log(error.code); }
    `], { env: { ...env, CONTEXT_BRIDGE_LOCK_TIMEOUT_MS: "200" }, encoding: "utf8", timeout: 5000 });
    assert.equal(contender.status, 0, contender.stderr || contender.error?.message);
    assert.equal(contender.stdout.trim(), "BRIDGE_LOCK_TIMEOUT", "a second process must not enter the owned critical section");
    assert.equal(owner.kill("SIGKILL"), true, "the lock owner must still be alive when forcefully stopped");
    await closed;
    const { withKernelLockSync } = await load("src/locking.mjs");
    withKernelLockSync(guard, () => assert.equal(fs.statSync(guard).ino, inode, "recovery must retain the guard identity"));
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await closed;
  }
}

let client;
try {
  assert.ok(run(empty, ["--version"]).includes(manifest.version));
  assert.ok(run(empty, ["--help"]).includes("artifact"));
  JSON.parse(run(empty, ["status", "--json"]));
  JSON.parse(run(empty, ["project", "list", "--json"]));
  assert.deepEqual(fs.readdirSync(empty), []);
  assert.equal(fs.existsSync(env.CONTEXT_BRIDGE_HOME), false, "read-only CLI must not initialize storage");
  const plugins = path.join(root, "experimental.json");
  const installedRequire = createRequire(path.join(installed, "package.json"));
  fs.writeFileSync(plugins, JSON.stringify({ apiVersion: 1, modules: ["aider", "pi"].map((id) =>
    installedRequire.resolve(`@serdardb/context-bridge/experimental/${id}`)) }));
  const candidates = spawnSync(process.execPath, [cli, "adapters", "--json"], {
    cwd: empty, env: { ...env, CONTEXT_BRIDGE_ADAPTERS: plugins }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(candidates.status, 0, candidates.stderr || candidates.error?.message);
  assert.deepEqual(JSON.parse(candidates.stdout).adapters.map((item) => item.id).slice(-2), ["aider", "pi"]);
  assert.equal(JSON.parse(run(empty, ["adapters", "--json"])).adapters.length, 5, "candidates never load implicitly");
  assert.equal(fs.existsSync(env.CONTEXT_BRIDGE_HOME), false, "loading descriptors must not initialize storage");
  assert.deepEqual(fs.readdirSync(empty), []);
  await verifyInstalledLock();
  const { ensureState, writeCheckpoint } = await load("src/state.mjs");
  const { composeFullContext } = await load("src/delta.mjs");
  const { verifyArtifact } = await load("src/artifact.mjs");
  ensureState(source);
  const context = composeFullContext({ fromAgent: "claude", summary: "PACKAGED_SUMMARY_3719",
    sources: [{ label: "Claude", messages: [{ role: "user", text: "PACKAGED_CONTEXT_5182" }] }],
    decisions: ["Git is optional"], work: [], next: ["Preserve portable evidence"] });
  writeCheckpoint(source, "main", "2026-09-17T00-00-00-000Z-claude-to-codex-full.md", context);
  const artifact = path.join(root, "context.cbctx"), roundtrip = path.join(root, "roundtrip.cbctx");
  run(source, ["artifact", "export", artifact]);
  const sealed = JSON.parse(run(source, ["artifact", "seal", artifact, "--out", path.join(root, "sealed"), "--json"]));
  const sharingPreview = JSON.parse(run(source, ["share", "send", sealed.sealedFile, "--endpoint", "https://unavailable.invalid", "--json"]));
  assert.equal(sharingPreview.applied, false);
  assert.equal(sharingPreview.hash, sealed.hash);
  const opened = path.join(root, "opened.cbctx");
  run(target, ["artifact", "open", sealed.sealedFile, "--key-file", sealed.keyFile, "--out", opened]);
  assert.deepEqual(fs.readFileSync(opened), fs.readFileSync(artifact));
  run(target, ["artifact", "import", artifact, "--apply"]);
  run(target, ["artifact", "export", roundtrip]);
  assert.equal(verifyArtifact(roundtrip).context, verifyArtifact(artifact).context);
  for (const dir of [source, target]) assert.deepEqual(fs.readdirSync(dir), [], "no project runtime or Git changes");

  const require = createRequire(path.join(installed, "package.json"));
  const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")));
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")));
  client = new Client({ name: "installed-package-acceptance", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [cli, "mcp", "--project", empty], env, stderr: "pipe" }));
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["bridge_adapters", "bridge_status"]);
  assert.deepEqual((await client.callTool({ name: "bridge_status", arguments: {} })).structuredContent, { state: "absent" });
  assert.deepEqual(fs.readdirSync(empty), []);
  console.log(JSON.stringify({ version: manifest.version, platform: process.platform, node: process.version,
    installedArtifact: true, experimentalEntryPoints: true, gitAbsentFromPath: true, cliReadOnly: true, artifactRoundtrip: true,
    actualMcpStdio: true, kernelExclusion: true, killedOwnerRecovery: true, sealedArtifactRoundtrip: true, offlineSharingPreview: true,
    credentialsUsed: false, vendorAgentsVerified: false }));
} finally {
  await client?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
