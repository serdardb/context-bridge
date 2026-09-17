import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ensureState, writeCheckpoint } from "../src/state.mjs";

const cli = fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url));
async function connect(project, extra = [], globalStorage = false) {
  const env = { ...process.env, PATH: "" };
  delete env.CONTEXT_BRIDGE_ADAPTERS;
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
    assert.equal((await client.callTool({ name: "bridge_search", arguments: { query: "needle", path: "/etc/passwd" } })).isError, true);
    assert.equal((await client.callTool({ name: "bridge_search", arguments: { query: "needle", limit: 101 } })).isError, true);
    assert.deepEqual(snapshot(), before);
  } finally { await client?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
