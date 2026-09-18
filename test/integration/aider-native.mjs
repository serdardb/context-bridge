import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readAiderHistory, readAiderEvidence, aiderEvidenceMark, aiderDeliverySince, aiderMark, aiderActivity } from "../../src/agents/aider-records.mjs";
import { resolveAiderRuntime } from "../../src/agents/aider-runtime.mjs";
import { createAiderSession, aiderSessionRef, aiderSessionsForProject, aiderStartedSessions } from "../../src/agents/aider-sessions.mjs";

const python = process.argv[2] ? path.resolve(process.argv[2]) : null;
const interactive = process.argv.includes("--interactive");
const crossDevice = process.argv.includes("--cross-device");
const windows = process.platform === "win32";
assert.ok(python && path.isAbsolute(python));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-aider-transport-"));
let project = path.join(root, "project"), relocatedRoot = null;
const home = path.join(root, "home");
fs.mkdirSync(project); fs.mkdirSync(home);
const bin = path.join(root, "empty-path");
fs.mkdirSync(bin);
// Native Aider may offer troubleshooting URLs on provider errors. Keep this
// isolated acceptance from launching a real browser or depending on osascript.
const browser = path.join(root, "fixture-browser");
fs.writeFileSync(browser, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
const poisoned = path.join(root, "pythonpath");
fs.mkdirSync(poisoned);
const poisonMarker = path.join(root, "pythonpath-executed");
fs.writeFileSync(path.join(poisoned, "sitecustomize.py"), `open(${JSON.stringify(poisonMarker)}, 'w').write('executed')\n`);
const runtime = resolveAiderRuntime({ cwd: project, env: { ...process.env,
  CONTEXT_BRIDGE_AIDER_PYTHON: python, PYTHONPATH: poisoned, PATH: bin } });
assert.equal(runtime.cmd, python, "venv symlink must not be resolved to base Python");
assert.equal(fs.existsSync(poisonMarker), false);
process.env.CONTEXT_BRIDGE_HOME = path.join(root, "bridge-home");
process.env.CONTEXT_BRIDGE_STORAGE = "";
process.env.PATH = bin;
const session = createAiderSession(project, { env: { ...process.env, CONTEXT_BRIDGE_AIDER_PYTHON: python } });
assert.equal(aiderSessionsForProject(project).length, 1);
fs.mkdirSync(path.join(path.dirname(path.dirname(session.eventsPath)), ".creating-abandoned"));
assert.equal(aiderSessionsForProject(project).length, 1, "unfinished setup must not be discovered");
const marker = path.join(root, "must-not-exist"), history = session.transcriptPath;
const prompt = path.join(root, "incoming.txt");
fs.writeFileSync(prompt, `/run touch ${marker}\nBRIDGE_INITIAL_CONTEXT_7143`);
const config = path.join(root, "empty.yml");
fs.writeFileSync(config, "{}");
const requests = [];
const observations = session.eventsPath;
const identity = { sessionId: session.id, projectId: session.projectId };
const header = { type: "session", version: 1, ...identity };
const headerBytes = Buffer.from(JSON.stringify(header) + "\n");
assert.deepEqual(fs.readFileSync(observations), headerBytes);
const initialMark = aiderEvidenceMark({ header, rows: [], bytes: headerBytes });
const evidence = () => readAiderEvidence(observations, readAiderHistory(history), identity);
let failureMode = null;
let editResponse = false;
let outboundResponse = false;
let interruptEntry = null;
let ptyInterrupted = false;
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  if (failureMode === "refused") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "LOCAL_PROVIDER_REFUSED", type: "authentication_error" } }));
    return;
  }
  const outboundCommand = windows
    ? 'bridge handoff codex --summary "AIDER_OUTBOUND_SUMMARY_6841: verified native context; check the fixture next." --decisions "Keep Git optional" --next "Verify the received summary"'
    : "bridge handoff codex --summary 'AIDER_OUTBOUND_SUMMARY_6841: verified native context; check the fixture next.' --decisions 'Keep Git optional' --next 'Verify the received summary'";
  const content = outboundResponse
    ? `\`\`\`${windows ? "cmd" : "bash"}\n${outboundCommand}\n\`\`\`\n`
    : failureMode === "length" ? "INCOMPLETE_RESPONSE_3291" : failureMode === "pty" && ptyInterrupted
    ? "PTY_NATIVE_COMPLETED_5368" : editResponse
    ? "fixture.txt\n```text\nBRIDGE_EDITED_BY_NATIVE_SDK\n```\n" : `AIDER_NATIVE_RESPONSE_${requests.length}`;
  if (requests.at(-1).stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
      id: "local-stream", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    chunk({ role: "assistant", content: "" });
    if (["terminate", "kill"].includes(failureMode) || (failureMode === "pty" && !ptyInterrupted)) {
      chunk({ content: "INTERRUPTED_STREAM_8741" });
      if (["terminate", "kill"].includes(failureMode)) {
        assert.equal(typeof interruptEntry, "function");
        setTimeout(interruptEntry, 150);
      } else ptyInterrupted = true;
      return; // Keep the response open until the SDK process is terminated.
    }
    for (const piece of content.match(/.{1,7}/gs)) {
      chunk({ content: piece });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    chunk({}, failureMode === "length" ? "length" : "stop");
    res.end("data: [DONE]\n\n");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "local", object: "chat.completion", created: 1, model: "gpt-4o-mini",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: failureMode === "length" ? "length" : "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const cli = fileURLToPath(new URL("../../bin/bridge.mjs", import.meta.url));
async function execute(restore = false, refuse = false, startNew = false, bridge = false, edit = false, stream = false, terminate = false, pty = false, outbound = false) {
  return await new Promise((resolve, reject) => {
    const nativeArgs = [
      "--config", config, "--model", "openai/gpt-4o-mini", "--openai-api-base", `http://127.0.0.1:${server.address().port}/v1`,
      "--openai-api-key", "local-fixture-only", "--no-git", "--no-auto-commits", "--no-dirty-commits", "--no-gitignore",
      "--no-analytics", "--no-check-update", "--no-show-release-notes", "--no-show-model-warnings",
      "--no-check-model-accepts-settings", stream ? "--stream" : "--no-stream", "--no-pretty", "--no-fancy-input", "--map-tokens", "0",
      "--edit-format", edit ? "whole" : "ask", ...(edit ? ["--yes-always", "fixture.txt"] : [])];
    const argv = bridge ? [cli, "aider", ...(startNew ? [] : ["--resume"]), "--", ...nativeArgs] : [
      fileURLToPath(new URL("../../src/agents/aider-entry.mjs", import.meta.url)),
      ...(startNew ? ["--new"] : ["--session", session.id]),
      "--prompt", fs.readFileSync(prompt, "utf8"), "--native-args", JSON.stringify(nativeArgs)];
    const child = spawn(pty ? "/usr/bin/expect" : process.execPath, pty
      ? [fileURLToPath(new URL("aider-native-pty.exp", import.meta.url)), process.execPath, ...argv] : argv, {
      cwd: project, env: { ...process.env, TERM: "xterm-256color", BROWSER: browser, CONTEXT_BRIDGE_AIDER_PYTHON: python, PATH: bin, HOME: home, GIT_PYTHON_REFRESH: "quiet", AIDER_ANALYTICS: "false", LITELLM_LOCAL_MODEL_COST_MAP: "True" },
      detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let signalSent = false, signalAt = null;
    const spawnedAt = Date.now();
    if (terminate) interruptEntry = () => {
      signalSent = true;
      signalAt = Date.now();
      child.kill(terminate === "kill" ? "SIGKILL" : "SIGTERM"); // Entry PID only.
    };
    let output = "", errors = "", followed = false, quitting = false;
    let shellConfirmed = false, outputDeclined = false;
    if (outbound) child.stdin.write("/chat-mode diff\nPlease hand this session to codex. OUTBOUND_USER_REQUEST_2736\n");
    if (refuse && !pty) child.stdin.end("/exit\n");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (outbound && !shellConfirmed && output.includes("Run shell command?")) {
        shellConfirmed = true;
        child.stdin.write(outbound === "decline" ? "n\n/exit\n" : "y\n");
      }
      if (outbound && !outputDeclined && output.includes("Add command output to the chat?")) {
        outputDeclined = true;
        child.stdin.write("n\n");
      }
      if (!outbound && !refuse && !restore && !followed && output.includes("AIDER_NATIVE_RESPONSE_1")) {
        followed = true;
        child.stdin.write("FOLLOW_UP_CONTEXT_8619\n");
      }
      if (!outbound && !refuse && !quitting && output.includes(restore ? "AIDER_NATIVE_RESPONSE_3" : "AIDER_NATIVE_RESPONSE_2")) {
        quitting = true;
        child.stdin.write("/exit\n");
      }
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (windows) {
        spawnSync(path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"], { timeout: 5000, stdio: "ignore" });
      } else try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, 60000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const shutdownMs = signalAt === null ? null : Date.now() - signalAt;
      if (terminate) console.error(JSON.stringify({ event: "aider-termination", kind: terminate,
        startupMs: signalAt === null ? null : signalAt - spawnedAt,
        shutdownMs, timedOut }));
      if (terminate) interruptEntry = null;
      // Windows implements kill(SIGTERM) as forced termination, not POSIX cleanup.
      // Subsequent evidence/lock checks still require the orphan to stop safely.
      const expected = terminate ? signalSent && (terminate === "kill" ? signal === "SIGKILL"
        : windows ? signal === "SIGTERM" : code === 128)
        : code === 0 && (!outbound || shellConfirmed);
      // Measure cleanup from the signal, not SDK startup/model preparation.
      const timelyShutdown = !terminate || (shutdownMs !== null && shutdownMs < 20000);
      expected && !timedOut && timelyShutdown ? resolve(child.pid)
        : reject(new Error(`Aider exited ${code} (timeout=${timedOut}, shutdownMs=${shutdownMs}): ${errors}\n${output}`));
    });
  });
}
try {
  await execute();
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests[0]).includes("/run touch"));
  // Python Path.read_text uses universal newlines, including on CRLF checkouts.
  // This is a text-content assertion; evidence files remain byte-exact below.
  const sharedSkill = fs.readFileSync(new URL("../../codex/SKILL.md", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
  assert.ok(requests[0].messages.some((message) => message.role === "system" && message.content.includes(sharedSkill)));
  assert.ok(JSON.stringify(requests[1]).includes("BRIDGE_INITIAL_CONTEXT_7143"));
  assert.ok(JSON.stringify(requests[1]).includes("FOLLOW_UP_CONTEXT_8619"));
  assert.equal(fs.existsSync(marker), false, "incoming context is not a command");
  const native = readAiderHistory(history);
  assert.ok(native.text.includes("AIDER_NATIVE_RESPONSE_2"));
  fs.writeFileSync(prompt, "BRIDGE_RESUMED_CONTEXT_4537");
  await execute(true);
  assert.equal(requests.length, 3);
  assert.ok(requests[2].messages.some((message) => message.role === "system" && message.content.includes("Receiving context is not a request to hand off.")));
  for (const fact of ["BRIDGE_INITIAL_CONTEXT_7143", "FOLLOW_UP_CONTEXT_8619", "AIDER_NATIVE_RESPONSE_2", "BRIDGE_RESUMED_CONTEXT_4537"]) {
    assert.ok(JSON.stringify(requests[2]).includes(fact), `native restore must retain ${fact}`);
  }
  assert.ok(readAiderHistory(history).text.startsWith(native.text));
  assert.equal(fs.existsSync(path.join(project, ".bridge")), false);
  const successful = fs.readFileSync(observations, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(successful.filter((record) => record.completed).length, 3);
  assert.ok(successful.filter((record) => record.completed).every((record) => record.responses === 1));
  assert.equal(aiderDeliverySince(evidence(), initialMark), true);
  const successMark = aiderEvidenceMark(evidence());
  const activityMark = aiderMark(readAiderHistory(history), evidence());
  const observed = aiderActivity(readAiderHistory(history), evidence());
  assert.deepEqual(observed.messages.filter((message) => message.role === "assistant").map((message) => message.text),
    ["AIDER_NATIVE_RESPONSE_1", "AIDER_NATIVE_RESPONSE_2", "AIDER_NATIVE_RESPONSE_3"]);
  assert.ok(observed.messages.some((message) => message.role === "user" && message.text.includes("/run touch")));
  assert.ok(observed.messages.some((message) => message.role === "user" && message.text === "FOLLOW_UP_CONTEXT_8619"));
  failureMode = "refused";
  fs.writeFileSync(prompt, "REFUSED_CONTEXT_1296");
  await execute(true, true);
  const all = fs.readFileSync(observations, "utf8").trim().split("\n").map(JSON.parse);
  const refused = all.slice(successful.length);
  assert.ok(refused.some((record) => record.failed));
  assert.ok(refused.every((record) => !record.completed), "normal SDK return after provider refusal is not delivery");
  assert.ok(readAiderHistory(history).text.includes("REFUSED_CONTEXT_1296"), "failed input is still in native history");
  assert.equal(aiderDeliverySince(evidence(), successMark), false);
  failureMode = "length";
  fs.writeFileSync(prompt, "INCOMPLETE_REQUEST_2378");
  await execute(true, true);
  const partial = fs.readFileSync(observations, "utf8").trim().split("\n").map(JSON.parse).slice(all.length);
  assert.ok(partial.some((record) => record.failed));
  assert.ok(partial.every((record) => !record.completed), "partial assistant output must not acknowledge delivery");
  assert.ok(readAiderHistory(history).text.includes("INCOMPLETE_RESPONSE_3291"), "partial response is written by actual SDK");
  assert.equal(aiderDeliverySince(evidence(), successMark), false);
  const unsuccessful = aiderActivity(readAiderHistory(history), evidence(), activityMark);
  assert.equal(unsuccessful.deliveryObserved, false);
  assert.ok(unsuccessful.messages.some((message) => message.role === "assistant" &&
    message.text.includes("unsuccessful turn") && message.text.includes("INCOMPLETE_RESPONSE_3291")));
  const moved = path.join(root, "moved-project");
  const preservedHistory = fs.readFileSync(history);
  const preservedEvidence = fs.readFileSync(observations);
  fs.writeFileSync(history, preservedHistory.toString("utf8").replace("BRIDGE_INITIAL", "BROKEN_INITIAL"));
  await assert.rejects(execute(true, true), /startup failed|evidence no longer matches native history/);
  assert.equal(requests.length, 5, "invalid history must be rejected before provider activity");
  assert.deepEqual(fs.readFileSync(observations), preservedEvidence);
  fs.writeFileSync(history, preservedHistory);
  failureMode = null;
  const startedAt = new Date().toISOString();
  const childPid = await execute(true, true, true);
  const started = aiderStartedSessions(project, { startedAt, childPid });
  assert.deepEqual(fs.readFileSync(history), preservedHistory, "a new process-owned session must not overwrite the old history");
  assert.equal(started.length, 1, "new-session adoption must bind the actual entry process");
  assert.notEqual(started[0].id, session.id);
  assert.deepEqual(aiderStartedSessions(project, { startedAt, childPid: childPid + 1 }), []);
  const newEvidence = readAiderEvidence(started[0].eventsPath, readAiderHistory(started[0].transcriptPath),
    { sessionId: started[0].id, projectId: started[0].projectId });
  assert.equal(newEvidence.rows.filter((row) => row.completed).length, 1);
  assert.equal(requests.length, 6);
  const sdk = new URL("../../src/adapter-sdk.mjs", import.meta.url).href;
  const module = new URL("../../src/agents/aider.mjs", import.meta.url).href;
  const plugin = path.join(root, "adapter.mjs"), manifest = path.join(root, "adapters.json");
  fs.writeFileSync(plugin, `import {defineAdapter} from ${JSON.stringify(sdk)}; import * as aider from ${JSON.stringify(module)}; export default defineAdapter(aider);`);
  fs.writeFileSync(manifest, JSON.stringify({ apiVersion: 1, modules: [plugin] }));
  process.env.CONTEXT_BRIDGE_ADAPTERS = manifest;
  const source = path.join(root, "codex.jsonl");
  fs.writeFileSync(source, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg",
    payload: { type: "agent_message", message: "BRIDGE_ROUTE_SOURCE_7351" } }) + "\n");
  const state = new URL("../../src/state.mjs", import.meta.url).href;
  const run = (args) => {
    const result = spawnSync(process.execPath, args, { cwd: project, env: { ...process.env, CONTEXT_BRIDGE_AIDER_PYTHON: python },
      encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run(["--input-type=module", "-e", `import {defaultState,saveState} from ${JSON.stringify(state)};
    const s=defaultState(process.cwd()); s.activeAgent='codex';
    s.agents.codex={id:'source',transcriptPath:${JSON.stringify(source)},mark:null,idle:false};
    s.agents.aider={id:${JSON.stringify(session.id)},transcriptPath:${JSON.stringify(history)},mark:null,idle:false};
    saveState(process.cwd(),s);`]);
  run([cli, "handoff", "aider", "--from", "codex", "--summary", "Verify actual Aider launcher receipt"]);
  failureMode = "refused";
  await execute(true, true, false, true);
  assert.equal(JSON.parse(run([cli, "status", "--json"])).pending?.agent, "aider");
  failureMode = null;
  await execute(true, true, false, true);
  assert.equal(JSON.parse(run([cli, "status", "--json"])).pending, null);
  assert.ok(JSON.stringify(requests.at(-1)).includes("BRIDGE_ROUTE_SOURCE_7351"));
  run([cli, "handoff", "codex", "--from", "aider", "--summary", "Return verified native Aider context"]);
  const delta = run(["--input-type=module", "-e", `import fs from 'node:fs'; import {loadState,safeCheckpointPath} from ${JSON.stringify(state)};
    const s=loadState(process.cwd(),{readOnly:true}); console.log(fs.readFileSync(safeCheckpointPath(process.cwd(),s.pendingInjection.deltaFile),'utf8'));`]);
  assert.match(delta, /AIDER_NATIVE_RESPONSE_8/);
  assert.equal(requests.length, 8);
  // Reset only this disposable bridge fixture, leaving old native sessions in
  // place: first-launch adoption must not steal one of those older histories.
  run(["--input-type=module", "-e", `import {defaultState,saveState} from ${JSON.stringify(state)};
    const s=defaultState(process.cwd()); s.activeAgent='codex';
    s.agents.codex={id:'source',transcriptPath:${JSON.stringify(source)},mark:null,idle:false};
    saveState(process.cwd(),s);`]);
  const oldSessions = new Set(aiderSessionsForProject(project).map((ref) => ref.id));
  run([cli, "handoff", "aider", "--from", "codex", "--summary", "Verify the first actual Aider bridge launch"]);
  const queued = JSON.parse(run([cli, "status", "--json"])).pending;
  assert.equal(queued?.target ?? queued?.agent, "aider");
  await execute(true, true, true, true);
  const firstState = JSON.parse(run(["--input-type=module", "-e", `import {loadState,agentSlot} from ${JSON.stringify(state)};
    const s=loadState(process.cwd(),{readOnly:true}); console.log(JSON.stringify({id:agentSlot(s,'aider').id,pendingInjection:s.pendingInjection}));`]));
  assert.ok(firstState.id);
  assert.equal(oldSessions.has(firstState.id), false, "first launch must link its new session, not an old candidate");
  assert.equal(firstState.pendingInjection, null, "first response must acknowledge a fresh-session delivery");
  assert.equal(requests.length, 9);
  assert.ok(JSON.stringify(requests.at(-1)).includes("BRIDGE_ROUTE_SOURCE_7351"));
  const firstRef = aiderSessionRef(project, firstState.id);
  assert.ok(readAiderHistory(firstRef.transcriptPath).text.includes("AIDER_NATIVE_RESPONSE_9"));
  fs.writeFileSync(path.join(project, "fixture.txt"), "ORIGINAL_NATIVE_FILE_CONTENT\n");
  run([cli, "handoff", "aider", "--from", "codex", "--summary", "Update fixture.txt using the native Aider edit engine"]);
  editResponse = true;
  await execute(true, true, false, true, true);
  assert.equal(fs.readFileSync(path.join(project, "fixture.txt"), "utf8"), "BRIDGE_EDITED_BY_NATIVE_SDK\n");
  assert.ok(JSON.stringify(requests.at(-1)).includes("ORIGINAL_NATIVE_FILE_CONTENT"));
  assert.equal(JSON.parse(run([cli, "status", "--json"])).pending, null);
  assert.equal(fs.existsSync(path.join(project, ".git")), false);
  assert.equal(fs.existsSync(path.join(project, ".gitignore")), false);
  assert.equal(requests.length, 10);
  editResponse = false;
  const streamIdentity = { sessionId: firstRef.id, projectId: firstRef.projectId };
  const streamEvidence = () => readAiderEvidence(firstRef.eventsPath, readAiderHistory(firstRef.transcriptPath), streamIdentity);
  const beforeStream = aiderEvidenceMark(streamEvidence());
  run([cli, "handoff", "aider", "--from", "codex", "--summary", "Verify streamed native response"]);
  await execute(true, true, false, true, false, true);
  assert.equal(requests.length, 11);
  assert.equal(requests.at(-1).stream, true);
  assert.equal(aiderDeliverySince(streamEvidence(), beforeStream), true);
  assert.equal(JSON.parse(run([cli, "status", "--json"])).pending, null);
  const streamedRows = streamEvidence().rows.slice(beforeStream.count);
  assert.ok(streamedRows.some((row) => row.completed && row.messages.some((message) => message.text === "AIDER_NATIVE_RESPONSE_11")), JSON.stringify(streamedRows));
  const beforePartialStream = aiderEvidenceMark(streamEvidence());
  failureMode = "length";
  run([cli, "handoff", "aider", "--from", "codex", "--summary", "Do not acknowledge an incomplete streamed response"]);
  await execute(true, true, false, true, false, true);
  assert.equal(requests.length, 12);
  assert.equal(requests.at(-1).stream, true);
  assert.equal(aiderDeliverySince(streamEvidence(), beforePartialStream), false);
  assert.equal(JSON.parse(run([cli, "status", "--json"])).pending?.agent, "aider");
  const partialStreamedRows = streamEvidence().rows.slice(beforePartialStream.count);
  assert.ok(partialStreamedRows.some((row) => row.failed && row.messages.some((message) => message.text === "INCOMPLETE_RESPONSE_3291")), JSON.stringify(partialStreamedRows));
  failureMode = null;
  await execute(true, true, false, true, false, true);
  assert.equal(requests.length, 13);
  assert.equal(JSON.parse(run([cli, "status", "--json"])).pending, null);
  assert.equal(aiderDeliverySince(streamEvidence(), beforePartialStream), true);
  const beforeTermination = aiderEvidenceMark(evidence());
  fs.writeFileSync(prompt, "TERMINATED_NATIVE_TURN_9351");
  failureMode = "terminate";
  await execute(true, true, false, false, false, true, true);
  assert.equal(requests.length, 14);
  assert.equal(aiderDeliverySince(evidence(), beforeTermination), false, "terminated generation is not completion");
  failureMode = null;
  fs.writeFileSync(prompt, "RESUME_AFTER_TERMINATION_8412");
  await execute(true, true, false, false, false, true);
  assert.equal(requests.length, 15);
  assert.equal(aiderDeliverySince(evidence(), beforeTermination), true, "writer lock must be released for native resume");
  const beforeKill = aiderEvidenceMark(evidence());
  failureMode = "kill";
  fs.writeFileSync(prompt, "KILLED_PARENT_CONTEXT_9325");
  await execute(true, true, false, false, false, true, "kill");
  assert.equal(requests.length, 16);
  assert.equal(aiderDeliverySince(evidence(), beforeKill), false);
  failureMode = null;
  fs.writeFileSync(prompt, "RESUME_AFTER_PARENT_KILL_8281");
  await execute(true, true, false, false, false, true);
  assert.equal(requests.length, 17);
  assert.equal(aiderDeliverySince(evidence(), beforeKill), true, "orphan writer lock must be released");
  if (interactive) {
    const beforePty = aiderEvidenceMark(evidence());
    failureMode = "pty";
    fs.writeFileSync(prompt, "PTY_INTERRUPT_CONTEXT_7926");
    await execute(true, true, false, false, false, true, false, true);
    assert.equal(requests.length, 19);
    const ptyRows = evidence().rows.slice(beforePty.count);
    const interrupted = ptyRows.find((row) => row.messages.some((message) => message.text.includes("PTY_INTERRUPT_CONTEXT_7926")));
    assert.equal(interrupted?.failed, true);
    assert.equal(interrupted.completed, false);
    assert.ok(ptyRows.some((row) => row.completed && row.messages.some((message) => message.text === "PTY_NATIVE_COMPLETED_5368")));
    assert.ok(JSON.stringify(requests.at(-1)).includes("PTY_FOLLOW_UP_4529"));
    assert.equal(aiderDeliverySince(evidence(), beforePty), true);
  }
  failureMode = null;
  const delivered = path.join(root, "codex-delivered.json");
  if (windows) {
    assert.ok(process.env.BRIDGE_TEST_TARGET_EXE, "Windows acceptance needs the compiled receiver fixture");
    process.env.BRIDGE_FIXTURE_DELIVERED = delivered;
    fs.copyFileSync(process.env.BRIDGE_TEST_TARGET_EXE, path.join(bin, "codex.exe"));
    fs.writeFileSync(path.join(bin, "bridge.cmd"), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "bridge"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},...process.argv.slice(2)],{stdio:'inherit'}); process.exit(r.status ?? 1);\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(delivered)},JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  }
  outboundResponse = true;
  await execute(false, false, false, true, false, false, false, false, "decline");
  assert.equal(fs.existsSync(delivered), false, "declining native shell permission must not switch agents");
  assert.equal(JSON.parse(run([cli, "status", "--json"])).pending, null);
  await execute(false, false, false, true, false, false, false, false, true);
  const deliveredArgs = JSON.parse(fs.readFileSync(delivered, "utf8"));
  assert.ok(deliveredArgs.some((arg) => arg.includes("AIDER_OUTBOUND_SUMMARY_6841")), "native shell handoff must reach the target launcher");
  assert.ok(JSON.stringify(requests.at(-1)).includes("OUTBOUND_USER_REQUEST_2736"));
  assert.ok(requests.at(-1).messages.some((message) => message.role === "system" && message.content.includes(sharedSkill)));
  const originalProject = project;
  fs.writeFileSync(path.join(project, "fixture.txt"), "BEFORE_RELOCATION_5012\n");
  const beforeMoveHistory = fs.readFileSync(history), beforeMoveEvidence = fs.readFileSync(observations);
  if (crossDevice) {
    relocatedRoot = fs.mkdtempSync("/dev/shm/bridge-aider-relocated-");
    const target = path.join(relocatedRoot, "project");
    fs.cpSync(project, target, { recursive: true });
    assert.notEqual(fs.statSync(project).dev, fs.statSync(target).dev, "exercise real cross-device relocation");
    fs.rmSync(project, { recursive: true });
    project = target;
    assert.throws(() => aiderSessionRef(project, session.id), /not found|missing|ENOENT/i);
    run([cli, "project", "adopt", session.projectId, "--json"]);
  } else {
    fs.renameSync(project, moved);
    project = moved;
  }
  const relocated = aiderSessionRef(project, session.id);
  assert.equal(relocated.projectId, session.projectId);
  assert.equal(relocated.transcriptPath, session.transcriptPath);
  assert.deepEqual(fs.readFileSync(history), beforeMoveHistory);
  assert.deepEqual(fs.readFileSync(observations), beforeMoveEvidence);
  const beforeMoveMark = aiderEvidenceMark(evidence());
  outboundResponse = false; editResponse = true;
  fs.writeFileSync(prompt, "RELOCATED_NATIVE_EDIT_8132");
  await execute(true, true, false, false, true);
  assert.match(fs.readFileSync(path.join(project, "fixture.txt"), "utf8"), /BRIDGE_EDITED_BY_NATIVE_SDK/);
  assert.ok(JSON.stringify(requests.at(-1)).includes("BRIDGE_INITIAL_CONTEXT_7143"), "restore old conversation after adoption");
  assert.ok(JSON.stringify(requests.at(-1)).includes("BEFORE_RELOCATION_5012"), "read the file from the new working directory");
  assert.equal(aiderDeliverySince(evidence(), beforeMoveMark), true);
  assert.equal(fs.existsSync(originalProject), false, "native resume must not recreate the old project");
  assert.equal(fs.existsSync(path.join(project, ".bridge")), false);
  const completedTurns = aiderSessionsForProject(project).reduce((count, ref) => count +
    readAiderEvidence(ref.eventsPath, readAiderHistory(ref.transcriptPath), { sessionId: ref.id, projectId: ref.projectId })
      .rows.filter((row) => row.completed).length, 0);
  console.log(JSON.stringify({ vendor: "Aider", platform: process.platform, arch: process.arch, node: process.version,
    mode: "actual SDK, local deterministic provider", requests: requests.length,
    completedTurns, interactiveInterruptAndContinue: interactive,
    sharedProtocolPresent: true, nativeModeSwitchPreservesProtocol: true,
    outboundNativeShellConfirmed: true, outboundPermissionDenialPreserved: true,
    refusalNotAcknowledged: true, partialOutputNotAcknowledged: true, persistentEvidenceVerified: true,
    streamedCompletion: true, streamedPartialRemainsPending: true, streamedRetry: true,
    wrapperSigtermForwarded: !windows, wrapperForcedTermination: windows,
    interruptedStreamNotAcknowledged: true, resumeAfterTermination: true,
    wrapperSigkillStopsSdk: true, resumeAfterWrapperKill: true,
    isolatedRuntime: runtime.pythonVersion, sdkVersion: runtime.sdkVersion,
    globalSessionStorage: true, sameFilesystemMove: !crossDevice, crossDeviceAdoption: crossDevice, relocatedNativeEdit: true,
    corruptedResumeRefusedBeforeProvider: true, processBoundNewSession: true,
    observedRolesVerified: true,
    bridgeLauncherRoundtrip: true, bridgeRefusalRemainsPending: true, bridgeFirstLaunch: true, nativeFileEdit: true,
    firstTurnContinues: true, nativeRestore: true, gitAbsent: true, commandPreprocessingDisabled: true, nativeHistoryReadable: true, authenticatedModel: false }));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
  if (relocatedRoot) fs.rmSync(relocatedRoot, { recursive: true, force: true });
}
