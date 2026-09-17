import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as aider from "../src/agents/aider.mjs";
import { createAdapterRegistry } from "../src/adapter-contract.mjs";

test("Aider candidate satisfies the SDK without inventing audit capabilities or losing argument boundaries", () => {
  const adapter = createAdapterRegistry([aider]).aider;
  for (const command of [adapter.startCommand(["--", "--model", "provider/model", "--", "--literal-file"]),
    adapter.resumeCommand({ id: "linked" }, ["--", "--model", "provider/model", "--", "--literal-file"])]) {
    assert.equal(command.cmd, process.execPath);
    assert.deepEqual(JSON.parse(command.args[command.args.indexOf("--native-args") + 1]),
      ["--model", "provider/model", "--", "--literal-file"]);
  }
  assert.deepEqual(adapter.promptArgs("/run do-not-execute\ncontext"), ["--prompt", "/run do-not-execute\ncontext"]);
  assert.ok(Object.values(adapter.capabilities).every((value) => value === false));
  assert.deepEqual(adapter.observeAudit(), adapter.capabilities);
  assert.equal(adapter.detectHost({}), null);
  assert.ok(adapter.smokeCommand().args.includes("--smoke"));
});

test("a first prompt session that exits before polling is linked before delivery is settled", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-first-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"); fs.mkdirSync(project);
  const native = path.join(root, "native.json"), source = path.join(root, "codex.jsonl");
  fs.writeFileSync(source, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg",
    payload: { type: "agent_message", message: "FIRST_DELIVERY_CONTEXT" } }) + "\n");
  const sdk = new URL("../src/adapter-sdk.mjs", import.meta.url).href;
  const codex = new URL("../src/agents/codex.mjs", import.meta.url).href;
  const state = new URL("../src/state.mjs", import.meta.url).href;
  const plugin = path.join(root, "plugin.mjs"), manifest = path.join(root, "adapters.json");
  const child = `if(!process.argv.join(' ').includes('FIRST_DELIVERY_CONTEXT'))process.exit(3);
    require('node:fs').writeFileSync(${JSON.stringify(native)},JSON.stringify([{role:'assistant',text:'Received',at:new Date().toISOString()}]));`;
  fs.writeFileSync(plugin, `import fs from 'node:fs';import * as codex from ${JSON.stringify(codex)};
    import {defineAdapter} from ${JSON.stringify(sdk)};
    const file=${JSON.stringify(native)};
    const ref=()=>({id:'fresh',transcriptPath:file});
    const activity=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
    export default defineAdapter({...codex,id:'quick',displayName:'Quick fixture',injection:'prompt',
      detectHost:()=>null,discover:()=>null,hydrate:()=>ref(),
      startCommand:()=>({cmd:process.execPath,args:['-e',${JSON.stringify(child)}]}),
      promptArgs:(text)=>['--',text],adoptStartedSession:()=>fs.existsSync(file)?[ref()]:[],
      currentMark:()=>activity().length,activitySince:(_ref,mark)=>({messages:activity().slice(mark??0),patchedFiles:[],turnsCompleted:1})});`);
  fs.writeFileSync(manifest, JSON.stringify({ apiVersion: 1, modules: [plugin] }));
  const env = { ...process.env, CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_HOME: path.join(root, "home"),
    CONTEXT_BRIDGE_ADAPTERS: manifest, PATH: "" };
  delete env.CODEX_THREAD_ID; delete env.CONTEXT_BRIDGE_LANE;
  const run = (args) => {
    const result = spawnSync(process.execPath, args, { cwd: project, env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  const cli = fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url));
  run(["--input-type=module", "-e", `import {defaultState,saveState} from ${JSON.stringify(state)};
    const s=defaultState(process.cwd());s.activeAgent='codex';s.agents.codex={id:'source',transcriptPath:${JSON.stringify(source)},mark:null,idle:false};saveState(process.cwd(),s);`]);
  run([cli, "handoff", "quick", "--from", "codex", "--summary", "First delivery"]);
  run([cli, "quick"]);
  const status = JSON.parse(run([cli, "status", "--json"]));
  assert.equal(status.pending, null, "the first short response must consume delivery after linking");
  assert.ok(status.linkedAgents.includes("quick"));
});
