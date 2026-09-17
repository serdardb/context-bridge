import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultState, saveState, loadState, safeCheckpointPath } from "../src/state.mjs";
import { defineAdapter, ADAPTER_API_VERSION } from "@serdardb/context-bridge/adapter-sdk";
import * as codex from "../src/agents/codex.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "bin/bridge.mjs");
const sdk = new URL("../src/adapter-sdk.mjs", import.meta.url).href;
const base = new URL("../src/agents/codex.mjs", import.meta.url).href;
const run = (args, cwd, env) => spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 20000 });

test("an explicitly configured SDK adapter participates in real CLI discovery and handoff without Git", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sdk-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, "project"); fs.mkdirSync(project);
  const plugin = path.join(dir, "example.mjs");
  fs.writeFileSync(plugin, `import {defineAdapter} from ${JSON.stringify(sdk)};
    import * as base from ${JSON.stringify(base)};
    export default defineAdapter({...base, id:'example', displayName:'Example', detectHost:()=>null,
      health:()=>({version:'fixture',ready:true,auth:{ok:true},extras:[],installHint:'fixture'}),
      hydrate:(_project,slot)=>slot.id ? {id:slot.id,transcriptPath:slot.transcriptPath}:null});`);
  const manifest = path.join(dir, "plugins.json");
  fs.writeFileSync(manifest, JSON.stringify({ apiVersion: 1, modules: [plugin] }));
  const env = { CONTEXT_BRIDGE_ADAPTERS: manifest, PATH: "" };
  const listed = run([cli, "adapters", "--json"], project, env);
  assert.equal(listed.status, 0, listed.stderr);
  const descriptors = JSON.parse(listed.stdout).adapters;
  assert.equal(descriptors.at(-1).id, "example");
  assert.equal(descriptors.at(-1).operations.resumeCommand, true);
  assert.equal(fs.existsSync(path.join(project, ".bridge")), false, "listing must not initialize state");
  const absent = run([cli, "adapters", "--json"], project, { ...env, CONTEXT_BRIDGE_ADAPTERS: "" });
  assert.equal(JSON.parse(absent.stdout).adapters.some((entry) => entry.id === "example"), false);
  const transcript = path.join(dir, "session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ timestamp: "2026-09-17T10:00:00Z", type: "event_msg", payload: { type: "agent_message", message: "SDK integration evidence" } }) + "\n");
  const state = defaultState(project);
  state.activeAgent = "codex";
  for (const id of ["codex", "example"]) state.agents[id] = { id: `${id}-session`, transcriptPath: transcript, mark: null, idle: false };
  saveState(project, state);
  const handed = run([cli, "handoff", "example", "--from", "codex", "--summary", "Continue the SDK integration."], project, env);
  assert.equal(handed.status, 0, handed.stderr);
  const after = loadState(project, { readOnly: true });
  assert.equal(after.pendingInjection.agent, "example");
  const delta = fs.readFileSync(safeCheckpointPath(project, after.pendingInjection.deltaFile), "utf8");
  assert.match(delta, /SDK integration evidence/);
  assert.match(delta, /Continue the SDK integration/);
  const returned = run([cli, "handoff", "codex", "--from", "example", "--summary", "The extension returns its context."], project, env);
  assert.equal(returned.status, 0, returned.stderr);
  const back = loadState(project, { readOnly: true });
  assert.equal(back.pendingInjection.agent, "codex");
  assert.match(fs.readFileSync(safeCheckpointPath(project, back.pendingInjection.deltaFile), "utf8"), /The extension returns its context/);
  assert.equal(defineAdapter(codex).apiVersion, ADAPTER_API_VERSION);
});

test("plugin loading refuses implicit paths, incompatible manifests and reserved identities", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sdk-refusal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "executed");
  const plugin = path.join(dir, "plugin.mjs");
  fs.writeFileSync(plugin, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'yes');
    import {defineAdapter} from ${JSON.stringify(sdk)}; import * as base from ${JSON.stringify(base)};
    export default defineAdapter({...base,id:'help'});`);
  const manifest = path.join(dir, "plugins.json");
  for (const data of [{ apiVersion: 99, modules: [plugin] }, { apiVersion: 1, modules: ["https://example.com/plugin.mjs"] },
    { apiVersion: 1, modules: [plugin, plugin] }]) {
    fs.writeFileSync(manifest, JSON.stringify(data));
    const result = run([cli, "adapters", "--json"], dir, { CONTEXT_BRIDGE_ADAPTERS: manifest });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Adapter plugins:/);
    assert.equal(fs.existsSync(marker), false);
  }
  fs.writeFileSync(manifest, JSON.stringify({ apiVersion: 1, modules: [plugin] }));
  const reserved = run([cli, "adapters"], dir, { CONTEXT_BRIDGE_ADAPTERS: manifest });
  assert.notEqual(reserved.status, 0);
  assert.match(reserved.stderr, /reserved agent name/);
  assert.equal(fs.existsSync(marker), true, "an explicitly trusted module executes before its exports can be checked");
  const relative = run([cli, "adapters"], dir, { CONTEXT_BRIDGE_ADAPTERS: "plugins.json" });
  assert.match(relative.stderr, /absolute manifest path/);
});
