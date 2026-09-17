import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

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
    actualMcpStdio: true, credentialsUsed: false, vendorAgentsVerified: false }));
} finally {
  await client?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
