import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as pi from "../src/agents/pi.mjs";
import { piSessionDirectory, piSessionsForProject, piSessionRef } from "../src/agents/pi-sessions.mjs";
import { createAdapterRegistry, AdapterResultError } from "../src/adapter-contract.mjs";

const at = "2026-09-17T00:00:00.000Z";
const row = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: at, message });
const write = (file, cwd, id, rows = []) => fs.writeFileSync(file,
  [{ type: "session", version: 3, cwd, id, timestamp: at }, ...rows].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

test("Pi relocation requires explicit adoption and a linked identity; discovery stays strict", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pi-relocation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, "original"), moved = path.join(root, "moved");
  fs.mkdirSync(original); fs.mkdirSync(moved);
  const file = path.join(root, "session.jsonl");
  write(file, fs.realpathSync(original), "linked-session");
  const storage = new URL("../src/storage.mjs", import.meta.url).href;
  const reader = new URL("../src/agents/pi-sessions.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import assert from 'node:assert/strict';
    import {projectIdentity,adoptProject} from ${JSON.stringify(storage)};
    import {piSessionRef} from ${JSON.stringify(reader)};
    const original=${JSON.stringify(original)}, moved=${JSON.stringify(moved)}, file=${JSON.stringify(file)};
    const id=projectIdentity(original,{create:true}).id;
    assert.throws(()=>piSessionRef(moved,file,'linked-session'),/different project/);
    fs.rmdirSync(original);
    assert.throws(()=>piSessionRef(moved,file,'linked-session'),/different project/);
    const before=fs.readFileSync(file);
    adoptProject(moved,id);
    assert.equal(piSessionRef(moved,file,'linked-session').id,'linked-session');
    assert.throws(()=>piSessionRef(moved,file),/different project/);
    assert.throws(()=>piSessionRef(moved,file,'other-session'),/identity differs/);
    assert.deepEqual(fs.readFileSync(file),before,'bridge must not rewrite vendor cwd');
    fs.mkdirSync(original);
    assert.throws(()=>piSessionRef(moved,file,'linked-session'),/different project/);
  `], { env: { ...process.env, CONTEXT_BRIDGE_HOME: path.join(root, "home"), CONTEXT_BRIDGE_STORAGE: "", PATH: "" },
    encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

for (const explicitDelivery of [false, true]) test(`real CLI Pi roundtrip uses opaque watermark (explicit delivery: ${explicitDelivery})`, { timeout: 30000 }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pi-roundtrip-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"), bin = path.join(root, "bin");
  fs.mkdirSync(project); fs.mkdirSync(bin);
  const native = path.join(root, "pi.jsonl"), codex = path.join(root, "codex.jsonl");
  write(native, project, "pi-native", [row("old", null, { role: "assistant", content: [{ type: "text", text: "Old Pi evidence" }], stopReason: "stop" })]);
  fs.writeFileSync(codex, JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "agent_message", message: "Codex source evidence" } }) + "\n");
  const sdk = new URL("../src/adapter-sdk.mjs", import.meta.url).href;
  const adapter = new URL("../src/agents/pi.mjs", import.meta.url).href;
  const plugin = path.join(root, "plugin.mjs");
  fs.writeFileSync(plugin, `import {defineAdapter} from ${JSON.stringify(sdk)}; import * as pi from ${JSON.stringify(adapter)};
    export default defineAdapter({...pi, activitySince(ref,mark) {
      const activity=pi.activitySince(ref,mark);
      return ${explicitDelivery} ? {...activity,deliveryObserved:activity.messages.some(m=>m.text==='Pi received the bridge handoff')} : activity;
    }});`);
  const manifest = path.join(root, "plugins.json");
  fs.writeFileSync(manifest, JSON.stringify({ apiVersion: 1, modules: [plugin] }));
  fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nconst fs = require('node:fs');
    if(process.argv.includes('--version')) { console.log('0.85.1-fixture'); process.exit(0); }
    const file=process.argv[process.argv.indexOf('--session')+1];
    const prompt=process.argv[process.argv.indexOf('--')+1];
    if(!prompt?.includes('Codex source evidence')) process.exit(3);
    if(process.env.PI_TEST_SILENT) process.exit(0);
    const rows=fs.readFileSync(file,'utf8').trim().split('\\n').map(JSON.parse);
    fs.appendFileSync(file,JSON.stringify({type:'message',id:require('node:crypto').randomUUID(),parentId:rows.at(-1).id,timestamp:new Date().toISOString(),
      message:{role:'assistant',content:[{type:'text',text:process.env.PI_TEST_PARTIAL?'Incomplete response evidence':'Pi received the bridge handoff'}],stopReason:'stop'}})+'\\n');
  `, { mode: 0o700 });
  const env = { ...process.env, CONTEXT_BRIDGE_HOME: path.join(root, "home"), CONTEXT_BRIDGE_STORAGE: "",
    CONTEXT_BRIDGE_ADAPTERS: manifest, PATH: bin };
  delete env.CODEX_THREAD_ID; delete env.CONTEXT_BRIDGE_LANE;
  const run = (args, extra = {}) => spawnSync(process.execPath, args, { cwd: project, env: { ...env, ...extra }, encoding: "utf8", timeout: 15000 });
  const stateModule = new URL("../src/state.mjs", import.meta.url).href;
  const setup = run(["--input-type=module", "-e", `import {defaultState,saveState} from ${JSON.stringify(stateModule)};
    const s=defaultState(process.cwd()); s.activeAgent='codex';
    s.agents.codex={id:'codex-native',transcriptPath:${JSON.stringify(codex)},mark:null,idle:false};
    s.agents.pi={id:'pi-native',transcriptPath:${JSON.stringify(native)},mark:null,idle:false}; saveState(process.cwd(),s);`]);
  assert.equal(setup.status, 0, setup.stderr);
  const cli = fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url));
  const handoff = run([cli, "handoff", "pi", "--from", "codex", "--summary", "Verify Pi transport"]);
  assert.equal(handoff.status, 0, handoff.stderr);
  const silent = run([cli, "pi", "--resume"], { PI_TEST_SILENT: "1" });
  assert.equal(silent.status, 0, silent.stderr);
  let status = run([cli, "status", "--json"]);
  assert.equal(JSON.parse(status.stdout).pending?.agent, "pi", "old messages and a successful spawn are not delivery");
  if (explicitDelivery) {
    const partial = run([cli, "pi", "--resume"], { PI_TEST_PARTIAL: "1" });
    assert.equal(partial.status, 0, partial.stderr);
    assert.match(fs.readFileSync(native, "utf8"), /Incomplete response evidence/);
    status = run([cli, "status", "--json"]);
    assert.equal(JSON.parse(status.stdout).pending?.agent, "pi", "explicit negative evidence must override new-message fallback");
  }
  const launch = run([cli, "pi", "--resume"]);
  assert.equal(launch.status, 0, launch.stderr);
  status = run([cli, "status", "--json"]);
  assert.equal(JSON.parse(status.stdout).pending, null, "new native message must acknowledge the opaque-mark delivery");
  const back = run([cli, "handoff", "codex", "--from", "pi", "--summary", "Return Pi evidence"]);
  assert.equal(back.status, 0, back.stderr);
  const inspect = run(["--input-type=module", "-e", `import fs from 'node:fs'; import {loadState,safeCheckpointPath} from ${JSON.stringify(stateModule)};
    const s=loadState(process.cwd(),{readOnly:true}); console.log(fs.readFileSync(safeCheckpointPath(process.cwd(),s.pendingInjection.deltaFile),'utf8'));`]);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /Pi received the bridge handoff/);
  assert.equal(fs.existsSync(path.join(project, ".bridge")), false);
});

test("Pi discovery checks native cwd despite folder encoding collisions and rejects duplicate identities", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pi-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "a", "b"), second = path.join(root, "a-b");
  fs.mkdirSync(first, { recursive: true }); fs.mkdirSync(second);
  const env = { PI_CODING_AGENT_DIR: path.join(root, "agent") };
  const dir = piSessionDirectory(first, env);
  assert.equal(dir, piSessionDirectory(second, env));
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, "first.jsonl"), first, "first");
  write(path.join(dir, "second.jsonl"), second, "second");
  fs.symlinkSync(path.join(dir, "first.jsonl"), path.join(dir, "linked.jsonl"));
  assert.deepEqual(piSessionsForProject(first, env).sessions.map((ref) => ref.id), ["first"]);
  assert.deepEqual(piSessionsForProject(second, env).sessions.map((ref) => ref.id), ["second"]);
  assert.throws(() => piSessionRef(first, path.join(dir, "second.jsonl")), /different project/);
  assert.throws(() => piSessionRef(first, path.join(dir, "first.jsonl"), "wrong"), /identity differs/);
  write(path.join(dir, "duplicate.jsonl"), first, "first");
  assert.throws(() => piSessionsForProject(first, env), /same session identity/);
});

test("Pi health checks only an explicitly configured provider and never requests credentials", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pi-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "agent"); fs.mkdirSync(home);
  const marker = path.join(root, "auth-called");
  fs.writeFileSync(path.join(root, "pi"), `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);
    if(a[0]==='--version'){console.log('0.85.1');process.exit(0);}
    if(JSON.stringify(a)!==JSON.stringify(['auth','check','--provider','fixture','--json','--no-refresh']))process.exit(2);
    fs.writeFileSync(${JSON.stringify(marker)},'yes');console.log(JSON.stringify({status:'ready',provider:'fixture'}));`, { mode: 0o700 });
  const module = new URL("../src/agents/pi.mjs", import.meta.url).href;
  const check = () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import {health} from ${JSON.stringify(module)};console.log(JSON.stringify(health()));`],
      { cwd: root, env: { ...process.env, PATH: root, PI_CODING_AGENT_DIR: home }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(check().ready, false);
  assert.equal(fs.existsSync(marker), false);
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ defaultProvider: "fixture" }));
  assert.equal(check().ready, true);
  assert.equal(fs.existsSync(marker), true);
});

test("Pi contract preserves prompt boundaries, matches out-of-order tool results and refuses broken activity", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pi-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  write(file, root, "native", [
    row("a", null, { role: "user", content: "$bridge codex" }),
    row("b", "a", { role: "assistant", content: [
      { type: "text", text: "Review complete" },
      { type: "toolCall", id: "read-id", name: "read", arguments: { path: "input.txt" } },
      { type: "toolCall", id: "write-id", name: "write", arguments: { path: "output.txt" } },
    ], stopReason: "toolUse" }),
    row("c", "b", { role: "toolResult", toolCallId: "write-id", isError: true, content: [] }),
    row("d", "c", { role: "toolResult", toolCallId: "read-id", isError: false, content: [] }),
    row("e", "d", { role: "assistant", content: [{ type: "text", text: "Write failed; input was read." }], stopReason: "stop" }),
  ]);
  const adapter = createAdapterRegistry([pi]).pi;
  const ref = piSessionRef(root, file);
  const audit = adapter.auditSince(ref, null);
  assert.deepEqual(audit.commands.map((call) => call.ok), [true, false]);
  assert.deepEqual(audit.filesRead, ["input.txt"]);
  assert.deepEqual(audit.filesChanged, []);
  const completedLater = adapter.auditSince(ref, { version: 1, sessionId: "native", entryId: "b" });
  assert.deepEqual(completedLater.commands.map((call) => call.ok), [true, false]);
  assert.deepEqual(adapter.auditSince(ref, adapter.currentMark(ref)).commands, []);
  const activity = adapter.activitySince(ref, null);
  assert.deepEqual(activity.messages.map((message) => message.text), ["Review complete", "Write failed; input was read."]);
  assert.equal(adapter.idleAfter(ref, "2026-09-16T00:00:00Z"), true);
  assert.equal(adapter.parseProbe(ref).status, "readable");
  assert.deepEqual(adapter.promptArgs("--dangerous-looking-text"), ["--", "--dangerous-looking-text"]);
  const instructions = pi.bridgeInstructions();
  assert.deepEqual(adapter.resumeCommand(ref).args, ["--session", file, "--append-system-prompt", instructions]);
  assert.deepEqual(adapter.startCommand().args, ["--append-system-prompt", instructions]);
  assert.ok(instructions.includes(fs.readFileSync(pi.bridgeSkillPath(), "utf8")), "ship the actual protocol, not a second hand-maintained copy");
  assert.match(instructions, /ONLY when the user requests/);
  assert.match(instructions, /receiving context is not a request to hand off/);
  assert.equal(adapter.startCommand().args.includes("--no-skills"), false);
  fs.appendFileSync(file, "broken\n");
  assert.equal(adapter.parseProbe(ref).status, "mismatch");
  assert.throws(() => adapter.activitySince(ref, null), AdapterResultError);
});
