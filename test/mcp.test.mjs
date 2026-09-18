import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureState, writeCheckpoint, checkpointsDir } from "../src/state.mjs";

const cli = fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url));
async function connect(project, extra = [], globalStorage = false, preload = null) {
  const env = { ...process.env, PATH: "" };
  delete env.CONTEXT_BRIDGE_ADAPTERS;
  if (preload) env.NODE_OPTIONS = `--require=${preload}`;
  if (globalStorage) {
    delete env.CONTEXT_BRIDGE_STORAGE;
    env.CONTEXT_BRIDGE_HOME = path.join(project, "unused-home");
  }
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [cli, "mcp", "--project", project, ...extra], env, stderr: "pipe" });
  const client = new Client({ name: "bridge-integration", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("real MCP stdio exposes metadata only by default and never initializes an absent project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-mcp-"));
  let client;
  try {
    client = await connect(root, [], true);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["bridge_adapters", "bridge_status"]);
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
    const status = await client.callTool({ name: "bridge_status", arguments: {} });
    assert.deepEqual(status.structuredContent, { state: "absent" });
    const adapters = await client.callTool({ name: "bridge_adapters", arguments: {} });
    assert.ok(adapters.structuredContent.adapters.length >= 5);
    assert.equal((await client.callTool({ name: "bridge_search", arguments: { query: "secret" } })).isError, true);
    assert.equal((await client.callTool({ name: "bridge_status", arguments: { project: os.homedir() } })).isError, true);
    assert.deepEqual(fs.readdirSync(root), []);
    fs.renameSync(root, `${root}-original`);
    fs.mkdirSync(root);
    assert.equal((await client.callTool({ name: "bridge_status", arguments: {} })).isError, true);
  } finally {
    await client?.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}-original`, { recursive: true, force: true });
  }
});

test("opt-in MCP search returns bounded evidence without consuming or altering files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-mcp-content-"));
  let client;
  try {
    ensureState(root);
    for (const hour of ["01", "02", "03"]) writeCheckpoint(root, "main",
      `2026-09-17T${hour}-00-00-000Z-claude-to-codex.md`, "durable evidence needle");
    const snapshot = () => {
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(file) : [[path.relative(root, file), fs.readFileSync(file, "utf8")]];
      });
      return walk(root);
    };
    const before = snapshot();
    client = await connect(root, ["--allow-content"]);
    const result = await client.callTool({ name: "bridge_search", arguments: { query: "needle", limit: 1 } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.results.length, 1);
    assert.equal(result.structuredContent.totalMatches, 3);
    assert.equal(result.structuredContent.omittedResults, 2);
    assert.equal(result.structuredContent.snippetsOnly, true);
    assert.equal(result.structuredContent.incomplete, false);
    assert.equal((await client.callTool({ name: "bridge_search", arguments: { query: "needle", path: "/etc/passwd" } })).isError, true);
    assert.equal((await client.callTool({ name: "bridge_search", arguments: { query: "needle", limit: 101 } })).isError, true);
    assert.deepEqual(snapshot(), before);
    fs.symlinkSync(path.join(checkpointsDir(root), "2026-09-17T01-00-00-000Z-claude-to-codex.md"),
      path.join(checkpointsDir(root), "2026-09-17T04-00-00-000Z-claude-to-codex.md"));
    const partial = await client.callTool({ name: "bridge_search", arguments: { query: "needle", limit: 1 } });
    assert.equal(partial.structuredContent.incomplete, true);
    assert.equal(partial.structuredContent.issues[0].reason, "unsafe-checkpoint");
    assert.equal(partial.structuredContent.totalMatches, 3);
    assert.equal(partial.structuredContent.omittedResults, 2, "display limit is separate from inaccessible evidence");
    await client.close(); client = null;
    const replacement = `${root}-replacement`, preload = `${root}-preload.cjs`, marker = `${root}-swap`;
    fs.mkdirSync(replacement); ensureState(replacement);
    writeCheckpoint(replacement, "main", "2026-09-17T00-00-00-000Z-claude-to-codex.md", "OTHER_PROJECT_SECRET needle");
    fs.writeFileSync(preload, `const fs = require('node:fs');
const root = fs.realpathSync(${JSON.stringify(root)}), stat = fs.statSync;
fs.statSync = function(file, ...args) {
  const value = stat.call(this, file, ...args);
  if (file === root && fs.existsSync(${JSON.stringify(marker)})) {
    fs.unlinkSync(${JSON.stringify(marker)});
    fs.renameSync(root, ${JSON.stringify(`${root}-original`)});
    fs.renameSync(${JSON.stringify(replacement)}, root);
  }
  return value;
};`);
    client = await connect(root, ["--allow-content"], false, preload);
    fs.writeFileSync(marker, "swap during first identity check");
    const replaced = await client.callTool({ name: "bridge_search", arguments: { query: "needle" } });
    assert.equal(replaced.isError, true, "a project replaced during a read must not supply MCP content");
    assert.equal(JSON.stringify(replaced).includes("OTHER_PROJECT_SECRET"), false);
  } finally {
    await client?.close();
    for (const suffix of ["", "-replacement", "-original", "-preload.cjs", "-swap"]) fs.rmSync(root + suffix, { recursive: true, force: true });
  }
});
