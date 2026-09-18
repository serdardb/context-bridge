import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as adapter from "../../src/agents/pi.mjs";
import { readPiSession, piMark, piActivity } from "../../src/agents/pi-records.mjs";

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli) || !fs.statSync(cli).isFile()) throw new Error("Pass an absolute installed Pi CLI file.");
const relocationRoot = process.argv.includes("--cross-device") ? "/dev/shm" : null;
const bridgeRequested = process.argv.includes("--bridge") || process.argv.includes("--migrate") || Boolean(relocationRoot);
const interactiveRequested = process.argv.includes("--interactive") || bridgeRequested;
const windows = process.platform === "win32";
if (interactiveRequested && (windows ? !process.env.BRIDGE_TEST_PTY_MODULE :
  !["darwin", "linux"].includes(process.platform) || !fs.existsSync("/usr/bin/expect"))) {
  throw new Error("PTY acceptance requires expect on POSIX or an isolated BRIDGE_TEST_PTY_MODULE on Windows.");
}
if (windows && bridgeRequested) throw new Error("Windows launcher acceptance is separate from native ConPTY continuity.");
const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 15000 });
assert.equal(version.status, 0, "the supplied native CLI must start");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pi-native-"));
let project = path.join(root, "project"), relocatedRoot = null;
const agent = path.join(root, "agent");
fs.mkdirSync(project); fs.mkdirSync(agent);
for (const name of ["bridge", "user-utility"]) {
  const dir = path.join(agent, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: User-owned ${name} skill\n---\nSTALE_OR_UNRELATED_USER_SKILL\n`);
}
const requests = [];
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw);
  requests.push(input);
  const answer = `PI_NATIVE_RESPONSE_${requests.length}`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (choices, extra = {}) => `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "fixture", choices, ...extra })}\n\n`;
  res.write(chunk([{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }]));
  res.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
  baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "local-fixture-only", api: "openai-completions",
  models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 128 }],
} } }));
const sessionDir = path.join(agent, "sessions");
fs.mkdirSync(sessionDir);
const sessionFile = path.join(sessionDir, "native-session.jsonl");
const flags = ["--print", "--provider", "fixture", "--model", "fixture", "--tools", "read", "--no-extensions", "--no-context-files", "--offline"];
async function execute(args, interactive = false, executable = cli, extraEnv = {}) {
  return await new Promise((resolve, reject) => {
    const command = interactive && !windows ? "/usr/bin/expect" : process.execPath;
    const commandArgs = interactive ? [fileURLToPath(new URL(windows ? "pi-native-conpty.mjs" : "pi-native-pty.exp", import.meta.url)), process.execPath, executable, ...args] : [executable, ...args];
    const child = spawn(command, commandArgs, { cwd: project,
      env: { ...process.env, TERM: "xterm-256color", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", ...extraEnv }, stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), interactive ? 45000 : 20000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`Pi exited ${code}: ${stderr}`)); });
  });
}
try {
  const first = await execute([...adapter.startCommand().args, ...flags, "--session", sessionFile,
    ...adapter.promptArgs("BRIDGE_FIRST_CONTEXT_8271")]);
  assert.match(first, /PI_NATIVE_RESPONSE_1/);
  const before = readPiSession(sessionFile), mark = piMark(before);
  const { SessionManager } = await import(pathToFileURL(path.join(path.dirname(cli), "core/session-manager.js")));
  assert.equal(SessionManager.open(sessionFile).getSessionId(), before.header.id, "vendor loader retains the saved identity");
  const second = await execute([...adapter.resumeCommand({ id: before.header.id, transcriptPath: sessionFile }).args,
    ...flags, ...adapter.promptArgs("BRIDGE_SECOND_CONTEXT_9318")]);
  assert.match(second, /PI_NATIVE_RESPONSE_2/);
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[0]), /BRIDGE_FIRST_CONTEXT_8271/);
  assert.match(JSON.stringify(requests[1]), /BRIDGE_FIRST_CONTEXT_8271/);
  assert.match(JSON.stringify(requests[1]), /BRIDGE_SECOND_CONTEXT_9318/);
  assert.match(JSON.stringify(requests[0]), /name>bridge<\/name/);
  assert.match(JSON.stringify(requests[0]), /name>user-utility<\/name/);
  for (const request of requests) {
    assert.ok(request.messages.some((message) => message.role === "system" && message.content.includes(adapter.bridgeInstructions())),
      "the current conditional protocol survives a same-name user skill on both start and resume");
  }
  const after = readPiSession(sessionFile);
  assert.equal(after.header.id, before.header.id);
  assert.deepEqual(piActivity(after, mark).messages.map((message) => message.text), ["BRIDGE_SECOND_CONTEXT_9318", "PI_NATIVE_RESPONSE_2"]);
  if (bridgeRequested) {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    fs.symlinkSync(cli, path.join(bin, "pi"));
    const plugin = path.join(root, "plugin.mjs"), manifest = path.join(root, "plugins.json");
    fs.writeFileSync(plugin, `import {defineAdapter} from ${JSON.stringify(new URL("../../src/adapter-sdk.mjs", import.meta.url).href)};
      import * as pi from ${JSON.stringify(new URL("../../src/agents/pi.mjs", import.meta.url).href)}; export default defineAdapter(pi);`);
    fs.writeFileSync(manifest, JSON.stringify({ apiVersion: 1, modules: [plugin] }));
    const bridge = fileURLToPath(new URL("../../bin/bridge.mjs", import.meta.url));
    const env = { CONTEXT_BRIDGE_HOME: path.join(root, "bridge-home"), CONTEXT_BRIDGE_STORAGE: "",
      CONTEXT_BRIDGE_ADAPTERS: manifest, CODEX_THREAD_ID: "", CONTEXT_BRIDGE_LANE: "", PATH: bin };
    const run = (args) => {
      const result = spawnSync(process.execPath, args, { cwd: project, env: { ...process.env, ...env }, encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const stateModule = new URL("../../src/state.mjs", import.meta.url).href;
    const codex = path.join(root, "codex.jsonl");
    fs.writeFileSync(codex, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg",
      payload: { type: "agent_message", message: "BRIDGE_NATIVE_LAUNCHER_EVIDENCE_7329" } }) + "\n");
    run(["--input-type=module", "-e", `import {defaultState,saveState} from ${JSON.stringify(stateModule)};
      const s=defaultState(process.cwd()); s.activeAgent='codex';
      s.agents.codex={id:'fixture-codex',transcriptPath:${JSON.stringify(codex)},mark:null,idle:false};
      s.agents.pi={id:${JSON.stringify(after.header.id)},transcriptPath:${JSON.stringify(sessionFile)},mark:null,idle:false}; saveState(process.cwd(),s);`]);
    run([bridge, "handoff", "pi", "--from", "codex", "--summary", "Verify actual native Pi delivery through bridge"]);
    const pendingStatus = JSON.parse(run([bridge, "status", "--json"]));
    assert.equal(pendingStatus.pending?.target, "pi", JSON.stringify(pendingStatus));
    if (relocationRoot) {
      const storageModule = new URL("../../src/storage.mjs", import.meta.url).href;
      const identity = JSON.parse(run(["--input-type=module", "-e", `import {projectIdentity} from ${JSON.stringify(storageModule)}; console.log(JSON.stringify(projectIdentity(process.cwd())));`]));
      relocatedRoot = fs.mkdtempSync(path.join(relocationRoot, "bridge-pi-relocated-"));
      const moved = path.join(relocatedRoot, "project");
      fs.cpSync(project, moved, { recursive: true });
      assert.notEqual(fs.statSync(project).dev, fs.statSync(moved).dev, "the fixture must cross actual filesystems");
      fs.rmSync(project, { recursive: true });
      project = moved;
      run([bridge, "project", "adopt", identity.id, "--json"]);
      env.PI_NATIVE_ACCEPT_RELOCATION = "1";
    }
    let migrated = null;
    if (process.argv.includes("--migrate")) {
      // Recreate the legacy layout only inside this disposable fixture. Keep
      // the existing registry entry: interrupted/previous migration must work too.
      migrated = JSON.parse(run(["--input-type=module", "-e", `import fs from 'node:fs'; import path from 'node:path';
        import {loadState,bridgeDir,safeCheckpointPath} from ${JSON.stringify(stateModule)};
        const s=loadState(process.cwd(),{readOnly:true}); const delta=fs.readFileSync(safeCheckpointPath(process.cwd(),s.pendingInjection.deltaFile),'utf8');
        fs.renameSync(bridgeDir(process.cwd()),path.join(process.cwd(),'.bridge'));
        // The published legacy store predates kernel guards. All fixture
        // writers have exited; do not mislabel a new guard as legacy data.
        fs.rmSync(path.join(process.cwd(),'.bridge','state.json.lock.guard'),{force:true});
        console.log(JSON.stringify({pending:s.pendingInjection,delta}));`]));
      assert.equal(fs.existsSync(path.join(project, ".bridge", "state.json")), true);
    }
    const resumeArgs = ["pi", "--resume", "main", ...flags.filter((flag) => flag !== "--print")];
    if (relocationRoot) {
      await execute(resumeArgs, true, bridge, { ...env, PI_NATIVE_ACCEPT_RELOCATION: "cancel" });
      assert.equal(requests.length, 2, "cancelling native relocation must not send context to the provider");
      assert.ok(JSON.parse(run([bridge, "status", "--json"])).pending, "cancelled relocation must preserve pending delivery");
    }
    await execute(resumeArgs, true, bridge, env);
    assert.equal(requests.length, 3);
    assert.ok(JSON.stringify(requests[2]).includes("BRIDGE_NATIVE_LAUNCHER_EVIDENCE_7329"));
    assert.ok(JSON.stringify(requests[2]).includes("BRIDGE_FIRST_CONTEXT_8271"));
    if (relocationRoot) {
      assert.ok(requests[2].messages.some((message) => message.role === "system" &&
        typeof message.content === "string" && message.content.includes(project)),
      "native Pi must establish the adopted working directory, not just retain its session ID");
    }
    assert.equal(JSON.parse(run([bridge, "status", "--json"])).pending, null, "new Pi output must acknowledge delivery");
    assert.equal(readPiSession(sessionFile).header.id, after.header.id);
    if (migrated) {
      const consumed = run(["--input-type=module", "-e", `import fs from 'node:fs'; import {safeCheckpointPath} from ${JSON.stringify(stateModule)};
        process.stdout.write(fs.readFileSync(safeCheckpointPath(process.cwd(),${JSON.stringify(migrated.pending.deltaFile + ".consumed")}), 'utf8'));`]);
      assert.equal(consumed, migrated.delta, "migration and delivery preserve the entire queued delta");
      assert.ok(fs.readdirSync(path.join(env.CONTEXT_BRIDGE_HOME, "migrations"), { withFileTypes: true }).some((entry) => entry.isDirectory()),
        "migration keeps its backup instead of deleting the only original");
      const migrationPlan = JSON.parse(run([bridge, "storage", "plan", "--json"]));
      assert.equal(migrationPlan.completed.length, 1);
      assert.deepEqual(migrationPlan.completed[0].changes, [], "native delivery changes active state, not retired originals");
    }
    run([bridge, "handoff", "codex", "--from", "pi", "--summary", "Return actual native Pi response"]);
    const reverse = run(["--input-type=module", "-e", `import fs from 'node:fs'; import {loadState,safeCheckpointPath} from ${JSON.stringify(stateModule)};
      const s=loadState(process.cwd(),{readOnly:true}); console.log(fs.readFileSync(safeCheckpointPath(process.cwd(),s.pendingInjection.deltaFile),'utf8'));`]);
    assert.match(reverse, /PI_NATIVE_RESPONSE_3/);
    assert.equal(fs.existsSync(path.join(project, ".bridge")), false);
  } else if (process.argv.includes("--interactive")) {
    const interactive = await execute([...adapter.resumeCommand({ id: after.header.id, transcriptPath: sessionFile }).args,
      ...flags.filter((flag) => flag !== "--print"), ...adapter.promptArgs("BRIDGE_INTERACTIVE_CONTEXT_6143")], true);
    assert.match(interactive, /PI_NATIVE_RESPONSE_3/);
    assert.equal(requests.length, 3);
    assert.ok(JSON.stringify(requests[2]).includes("BRIDGE_FIRST_CONTEXT_8271"));
    const final = readPiSession(sessionFile);
    assert.equal(final.header.id, before.header.id);
    assert.deepEqual(piActivity(final, piMark(after)).messages.map((message) => message.text), ["BRIDGE_INTERACTIVE_CONTEXT_6143", "PI_NATIVE_RESPONSE_3"]);
  }
  console.log(JSON.stringify({ vendor: "Pi", version: version.stdout.trim(), platform: process.platform, arch: process.arch, node: process.version,
    transport: "actual CLI, local deterministic provider", requests: requests.length,
    bridgeRoundtrip: bridgeRequested, migratedPending: process.argv.includes("--migrate"), crossDeviceAdoption: Boolean(relocationRoot), interactivePty: interactiveRequested, sameNativeSession: true, userSkillsPreserved: true,
    packagedProtocolPresent: true, resumedContextPreserved: true, authenticatedModel: false }));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  if (relocatedRoot) fs.rmSync(relocatedRoot, { recursive: true, force: true });
}
