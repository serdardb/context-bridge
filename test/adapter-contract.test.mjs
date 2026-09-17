import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { defaultState, saveState, statePath, checkpointsDir } from "../src/state.mjs";
import { handoff } from "../src/handoff.mjs";
import { buildManifest, renderManifest } from "../src/audit.mjs";
import { ADAPTERS, AGENT_IDS, adapterFor } from "../src/agents/index.mjs";
import { validateAdapter, createAdapterRegistry, adapterDescriptor, REQUIRED_OPERATIONS, RECORD_FIELDS } from "../src/adapter-contract.mjs";

const fixture = () => ({ ...ADAPTERS.codex, capabilities: { ...ADAPTERS.codex.capabilities }, conflictFlags: [] });

test("the production registry validates each built-in adapter without executing it", () => {
  assert.deepEqual(AGENT_IDS, ["claude", "codex", "grok", "antigravity", "opencode"]);
  for (const adapter of Object.values(ADAPTERS)) assert.equal(validateAdapter(adapter), adapter);
  const adapter = fixture();
  for (const key of Object.keys(adapter)) if (typeof adapter[key] === "function") adapter[key] = () => { throw new Error("must not execute"); };
  assert.doesNotThrow(() => createAdapterRegistry([adapter]));
  for (const id of ["constructor", "toString", "__proto__", "unknown"]) assert.equal(adapterFor(id), null);
  assert.throws(() => { ADAPTERS.newagent = adapter; }, TypeError);
});

test("incomplete and incompatible adapters fail at registration instead of during handoff", () => {
  for (const operation of REQUIRED_OPERATIONS) {
    const adapter = fixture();
    delete adapter[operation];
    assert.throws(() => createAdapterRegistry([adapter]), new RegExp(operation));
  }
  for (const field of RECORD_FIELDS) {
    const adapter = fixture();
    delete adapter.capabilities[field];
    assert.throws(() => createAdapterRegistry([adapter]), new RegExp(field));
  }
  const variants = [
    { id: "../escape" }, { id: "new-agent" }, { displayName: " " },
    { injection: "magic" }, { promptArgs: undefined }, { kickoffArgs: false },
    { injection: "hook", kickoffArgs: undefined }, { evaluationCommand: undefined },
    { capabilities: { ...fixture().capabilities, commands: "maybe" } },
    { capabilities: { ...fixture().capabilities, madeUp: true } },
    { conflictFlags: [{ flags: ["not-a-flag"], value: "none", why: "reason" }] },
    { conflictFlags: [{ flags: ["--resume"], value: "guess", why: "reason" }] },
  ];
  for (const change of variants) assert.throws(() => createAdapterRegistry([{ ...fixture(), ...change }]), TypeError);
  assert.throws(() => createAdapterRegistry([fixture(), fixture()]), /Duplicate adapter/);
  assert.throws(() => createAdapterRegistry([], 99), /API version/);
});

test("descriptors separate operational support from transcript evidence and do not leak implementation data", () => {
  const descriptor = adapterDescriptor(ADAPTERS.codex);
  assert.equal(descriptor.operations.evaluationCommand, true);
  assert.equal(descriptor.operations.preResume, false);
  const limited = fixture();
  limited.capabilities.tokenUsage = false;
  assert.equal(adapterDescriptor(limited).record.tokenUsage, false, "live eval support must not override transcript evidence");
  assert.equal(adapterDescriptor(ADAPTERS.opencode).operations.preResume, true);
  assert.equal(adapterDescriptor(ADAPTERS.claude).operations.evaluationCommand, false);
  assert.equal(JSON.parse(JSON.stringify(descriptor)).apiVersion, 1);
  descriptor.record.commands = "changed";
  assert.notEqual(ADAPTERS.codex.capabilities.commands, "changed");
});

test("registered adapters reject malformed command results and argument arrays without exposing their content", () => {
  for (const operation of ["startCommand", "resumeCommand", "smokeCommand", "evaluationCommand"]) {
    for (const result of [null, "secret-command", {}, { cmd: "", args: [] },
      { cmd: "binary", args: [42] }, { cmd: "binary", args: new Array(1) }, { cmd: "secret\0binary", args: [] },
      { cmd: "binary", args: ["secret\0argument"] }, Promise.resolve({ cmd: "binary", args: [] })]) {
      const adapter = { ...fixture(), [operation]: () => result };
      const registered = createAdapterRegistry([adapter]).codex;
      assert.throws(() => registered[operation](), (error) => {
        assert.equal(error.message, `Invalid adapter result: codex.${operation}`);
        return true;
      });
    }
  }
  for (const operation of ["promptArgs", "kickoffArgs"]) {
    for (const result of [null, "not-an-array", [null], ["secret\0argument"]]) {
      const registered = createAdapterRegistry([{ ...fixture(), [operation]: () => result }]).codex;
      assert.throws(() => registered[operation](), /Invalid adapter result/);
    }
  }
  assert.throws(() => adapterFor("codex").resumeCommand({ id: "secret\0session" }), /Invalid adapter result: codex.resumeCommand/);
  const command = adapterFor("codex").resumeCommand({ id: "valid-session" }, ["argument with spaces"]);
  assert.deepEqual(command.args, ["resume", "valid-session", "argument with spaces"]);
});

test("registered activity readers reject malformed transcripts but preserve opaque watermarks and complete text", () => {
  const valid = { messages: [{ role: "assistant", text: "full\ntext", at: null }], patchedFiles: [], turnsCompleted: 0 };
  for (const result of [null, {}, { ...valid, messages: "wrong" },
    { ...valid, messages: [{ role: "tool", text: "secret" }] },
    { ...valid, messages: [{ role: "user", text: {}, at: null }] },
    { ...valid, messages: [{ role: "user", text: "text", at: 42 }] },
    { ...valid, patchedFiles: [false] }, { ...valid, turnsCompleted: -1 },
    { ...valid, turnsCompleted: 0.5 },
    ...[null, undefined, 0, "false", {}].map((deliveryObserved) => ({ ...valid, deliveryObserved }))]) {
    const registered = createAdapterRegistry([{ ...fixture(), activitySince: () => result }]).codex;
    assert.throws(() => registered.activitySince(), /Invalid adapter result: codex.activitySince/);
  }
  const mark = { vendorSpecific: [42, "not-a-date"] };
  const adapter = { ...fixture(), activitySince(_ref, received) {
    assert.equal(received, mark);
    return valid;
  } };
  assert.equal(createAdapterRegistry([adapter]).codex.activitySince({}, mark), valid);
  for (const deliveryObserved of [true, false]) {
    const result = { ...valid, deliveryObserved };
    assert.equal(createAdapterRegistry([{ ...fixture(), activitySince: () => result }]).codex.activitySince({}, mark), result);
  }
});

test("a real handoff refuses an invalid native record without swallowing it as an empty conversation", (t) => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-invalid-adapter-")));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const rollout = path.join(project, "rollout.jsonl");
  fs.writeFileSync(rollout, JSON.stringify({ timestamp: 42, type: "event_msg",
    payload: { type: "agent_message", message: "private conversation" } }) + "\n");
  const s = defaultState(project);
  s.activeAgent = "codex";
  for (const id of ["codex", "claude"]) s.agents[id] = { id: `${id}-session`, transcriptPath: rollout, mark: null, idle: false };
  saveState(project, s);
  const before = fs.readFileSync(statePath(project));
  assert.throws(() => handoff(project, "claude", { from: "codex", checkTarget: () => {} }),
    /Invalid adapter result: codex.activitySince/);
  assert.deepEqual(fs.readFileSync(statePath(project)), before);
  assert.deepEqual(fs.existsSync(checkpointsDir(project)) ? fs.readdirSync(checkpointsDir(project)) : [], []);
  const script = `import {adapterFor} from ${JSON.stringify(new URL("../src/agents/index.mjs", import.meta.url).href)};
    adapterFor('codex').resumeCommand({id: 'bad\\0session'});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", cwd: project, env: { ...process.env, PATH: "" } });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Invalid adapter result: codex.resumeCommand/);
  assert.doesNotMatch(child.stderr, /private conversation/);
});

test("session methods distinguish no session from malformed identities and preserve candidate ambiguity", () => {
  for (const operation of ["discover", "hydrate", "refById"]) {
    for (const result of [undefined, false, [], {}, { id: 42 }, { id: " " },
      { id: "private\0id" }, { id: "valid", transcriptPath: {} }, { id: "valid", eventsPath: "bad\0path" }]) {
      const registered = createAdapterRegistry([{ ...fixture(), [operation]: () => result }]).codex;
      assert.throws(() => registered[operation](), new RegExp(`Invalid adapter result: codex.${operation}`));
    }
    const registered = createAdapterRegistry([{ ...fixture(), [operation]: () => null }]).codex;
    assert.equal(registered[operation](), null);
  }
  const candidates = [{ id: "one", transcriptPath: null }, { id: "two", transcriptPath: "/native/history" }];
  const registered = createAdapterRegistry([{ ...fixture(), adoptStartedSession: () => candidates }]).codex;
  assert.equal(registered.adoptStartedSession(), candidates, "validation must not choose among ambiguous candidates");
  for (const result of [null, {}, [null], new Array(1), [{ id: false }]]) {
    const invalid = createAdapterRegistry([{ ...fixture(), adoptStartedSession: () => result }]).codex;
    assert.throws(() => invalid.adoptStartedSession(), /Invalid adapter result/);
  }
});

test("native preparation rejects invalid commands and unbounded timeout values before execution", () => {
  const valid = { cmd: "sqlite3", args: ["store.db", "BEGIN; COMMIT;"], timeout: 15000, note: "prepare", operation: "inject" };
  for (const result of [undefined, false, {}, { ...valid, timeout: 0 }, { ...valid, timeout: -1 },
    { ...valid, timeout: Infinity }, { ...valid, timeout: "15000" }, { ...valid, args: [null] },
    { ...valid, note: {} }, { ...valid, operation: "bad\0label" }]) {
    const registered = createAdapterRegistry([{ ...fixture(), preResume: () => result }]).codex;
    assert.throws(() => registered.preResume(), /Invalid adapter result: codex.preResume/);
  }
  for (const result of [null, valid, { cmd: "sqlite3", args: [] }]) {
    const registered = createAdapterRegistry([{ ...fixture(), preResume: () => result }]).codex;
    assert.equal(registered.preResume(), result);
  }
  for (const result of [{ id: "new" }, { id: "new", preResume: null }, { id: 42, preResume: valid }]) {
    const registered = createAdapterRegistry([{ ...fixture(), fabricateSession: () => result }]).codex;
    assert.throws(() => registered.fabricateSession(), /Invalid adapter result: codex.fabricateSession/);
  }
  const result = { id: "new", preResume: valid };
  assert.equal(createAdapterRegistry([{ ...fixture(), fabricateSession: () => result }]).codex.fabricateSession(), result);
});

test("health, evidence and probe reports reject incompatible shapes without inventing success", (t) => {
  const invalid = {
    health: { version: "1", ready: "yes", auth: { ok: true }, extras: [], installHint: "install" },
    auditSince: { commands: [{ ok: "yes" }], filesRead: [], filesChanged: [], dropped: 0 },
    observeAudit: { commandArgs: "maybe" },
    parseProbe: { status: "healthy" },
    discoveryProbe: { status: "readable", examined: -1, recognised: 1 },
    idleAfter: "yes", detectHost: "otheragent",
  };
  for (const [operation, result] of Object.entries(invalid)) {
    const adapter = createAdapterRegistry([{ ...fixture(), [operation]: () => result }]).codex;
    assert.throws(() => adapter[operation](), new RegExp(`Invalid adapter result: codex.${operation}`));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-audit-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "claude.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: 42, message: {
    content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "private command" } }],
  } }));
  const manifest = buildManifest(dir, { source: "claude", target: "codex", sources: { claude: { transcriptPath: transcript } } });
  assert.deepEqual(manifest.readerErrors, [{ agent: "claude", reason: "audit reader failed" }]);
  assert.deepEqual(manifest.agents, {});
  assert.match(renderManifest(manifest), /INCOMPLETE.*claude/);
  assert.doesNotMatch(JSON.stringify(manifest), /private command/);
});
