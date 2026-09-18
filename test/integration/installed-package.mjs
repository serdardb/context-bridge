import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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

async function verifyWindowsRegistryPermissions() {
  if (process.platform !== "win32") return null;
  const system = path.join(process.env.SystemRoot, "System32");
  const native = (exe, args) => {
    const result = spawnSync(path.join(system, exe), args, { env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  const sid = native("WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"]);
  assert.match(sid, /^S-1-[0-9-]+$/);
  const { ensureState, checkpointsDir, statePath, writeCheckpoint } = await load("src/state.mjs");
  const { projectIdentity, projectStoreDir } = await load("src/storage.mjs");
  const project = path.join(root, "acl-project");
  fs.mkdirSync(project);
  ensureState(project);
  writeCheckpoint(project, "main", "2026-09-18T00-00-00-000Z-claude-to-codex.md", "ACL fixture evidence\n");
  const id = projectIdentity(project).id, store = projectStoreDir(project);
  const caseAlias = path.join(root, "ACL-PROJECT");
  assert.equal(fs.realpathSync(caseAlias), fs.realpathSync(project), "the native fixture must expose a real case alias");
  const stateBeforeAlias = fs.readFileSync(statePath(project));
  ensureState(caseAlias);
  assert.equal(projectIdentity(caseAlias).id, id, "case aliases must not split one physical project");
  assert.equal(projectStoreDir(caseAlias), store);
  assert.deepEqual(fs.readFileSync(statePath(project)), stateBeforeAlias);
  const checkpoints = checkpointsDir(project), relative = path.relative(store, checkpoints);
  const registry = path.join(env.CONTEXT_BRIDGE_HOME, "projects.json");
  const originalState = fs.readFileSync(statePath(project));
  const command = (...args) => spawnSync(process.execPath, [cli, "project", ...args],
    { cwd: empty, env, encoding: "utf8", timeout: 15000 });
  const denyDuring = (directory, body) => {
    try {
      // RD denies listing only; cleanup can remove this explicit ACE in finally.
      native("icacls.exe", [directory, "/deny", `*${sid}:(RD)`]);
      assert.throws(() => fs.readdirSync(directory), error => ["EACCES", "EPERM"].includes(error.code));
      body();
    } finally { native("icacls.exe", [directory, "/remove:d", `*${sid}`]); }
  };
  const beforeRegistry = fs.readFileSync(registry);
  denyDuring(checkpoints, () => {
    assert.equal(JSON.parse(command("inspect", id, "--json").stdout).complete, false);
    const result = command("retire", id, "--apply", "--json");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).applied, false);
    assert.deepEqual(fs.readFileSync(registry), beforeRegistry);
    assert.deepEqual(fs.readFileSync(statePath(project)), originalState);
  });
  fs.rmSync(project, { recursive: true });
  assert.equal(command("retire", id, "--apply", "--json").status, 0);
  const archive = path.join(env.CONTEXT_BRIDGE_HOME, "retired-projects", id);
  const retiredRegistry = fs.readFileSync(registry);
  denyDuring(path.join(archive, relative), () => {
    for (const args of [["restore", id, "--apply", "--json"], ["purge", id, "--apply", "--confirm", id, "--json"]]) {
      const result = command(...args);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(fs.readFileSync(registry), retiredRegistry);
      assert.deepEqual(fs.readFileSync(path.join(archive, "state.json")), originalState);
    }
  });
  assert.equal(command("restore", id, "--apply", "--json").status, 0);
  assert.deepEqual(fs.readFileSync(path.join(store, "state.json")), originalState);
  assert.equal(command("retire", id, "--apply", "--json").status, 0);
  assert.equal(command("purge", id, "--apply", "--confirm", id, "--json").status, 0);
  assert.equal(fs.existsSync(archive), false);
  assert.equal(fs.existsSync(project), false);
  return { nativeCaseAlias: true, nativeDenial: true, refusedMutationsPreserveEvidence: true, missingProjectLifecycle: true };
}

let client, sharingServer, sharingClosed;
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
  const shareStore = path.join(root, "share-store"), shareToken = path.join(root, "share-token");
  fs.mkdirSync(shareStore, { mode: 0o700 });
  fs.writeFileSync(shareToken, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  sharingServer = spawn(process.execPath, [cli, "share", "serve", "--dir", shareStore,
    "--token-file", shareToken, "--json"], { cwd: empty, env, stdio: ["ignore", "pipe", "pipe"] });
  sharingClosed = new Promise(resolve => sharingServer.once("close", resolve));
  let serviceOutput = "", serviceError = "";
  sharingServer.stderr.on("data", bytes => { serviceError += bytes; });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Installed sharing server readiness deadline")), 5000);
    sharingServer.once("error", error => { clearTimeout(timer); reject(error); });
    sharingServer.once("close", () => { clearTimeout(timer); reject(new Error(serviceError || "Sharing server exited before readiness")); });
    sharingServer.stdout.on("data", bytes => {
      serviceOutput += bytes;
      if (!serviceOutput.includes("\n")) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(serviceOutput.split("\n")[0]).endpoint); } catch (error) { reject(error); }
    });
  });
  const sharingArgs = ["--endpoint", endpoint, "--token-file", shareToken, "--allow-loopback-http", "--json"];
  const upload = JSON.parse(run(empty, ["share", "send", sealed.sealedFile, ...sharingArgs, "--apply"]));
  assert.equal(upload.hash, sealed.hash);
  const downloaded = path.join(root, "downloaded.cbsealed");
  run(empty, ["share", "fetch", upload.hash, ...sharingArgs, "--out", downloaded]);
  assert.deepEqual(fs.readFileSync(downloaded), fs.readFileSync(sealed.sealedFile));
  run(empty, ["share", "remove", upload.hash, ...sharingArgs, "--apply"]);
  assert.deepEqual(fs.readdirSync(shareStore), [".share.guard"]);
  assert.equal(sharingServer.kill("SIGTERM"), true);
  let stopExpired = false;
  const stopTimer = setTimeout(() => { stopExpired = true; sharingServer.kill("SIGKILL"); }, 5000);
  try {
    const code = await sharingClosed;
    assert.equal(stopExpired, false, "sharing shutdown exceeded its deadline");
    // Windows terminates the process for SIGTERM; it does not run POSIX handlers.
    if (process.platform === "win32") {
      assert.equal(code, null, serviceError);
      assert.equal(sharingServer.signalCode, "SIGTERM");
    } else assert.equal(code, 0, serviceError);
  } finally { clearTimeout(stopTimer); }
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
  const windowsRegistryPermissions = await verifyWindowsRegistryPermissions();
  console.log(JSON.stringify({ version: manifest.version, platform: process.platform, node: process.version,
    installedArtifact: true, experimentalEntryPoints: true, gitAbsentFromPath: true, cliReadOnly: true, artifactRoundtrip: true,
    actualMcpStdio: true, kernelExclusion: true, killedOwnerRecovery: true, sealedArtifactRoundtrip: true, offlineSharingPreview: true,
    installedSharingRoundtrip: true, windowsRegistryPermissions,
    credentialsUsed: false, vendorAgentsVerified: false }));
} finally {
  if (sharingServer && sharingServer.exitCode === null && sharingServer.signalCode === null) sharingServer.kill("SIGKILL");
  await sharingClosed;
  await client?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
