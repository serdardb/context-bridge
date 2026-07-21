import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS, AGENT_IDS, adapterFor } from "../src/agents/index.mjs";

// `capabilities` says what each agent's own record can EVER yield. It is a
// claim, and this project has been burned by an unverified claim before: doctor
// printed READY when all it knew was that a binary existed. So every entry is
// pinned here against rows cut out of real sessions on a real machine.
//
// The fixtures matter as much as the assertions. They are copied verbatim from
// live transcripts, never hand-written, because a hand-written fixture only
// proves our beliefs are self-consistent. That is not theory: the Antigravity
// adapter shipped without honouring `truncated_fields` precisely because the
// fixtures were invented by someone who did not know the field existed, and a
// real row would have carried it.

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "audit");
const rows = (name) =>
  fs
    .readFileSync(path.join(FIXTURES, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("every agent declares what its record can and cannot yield", () => {
  for (const id of AGENT_IDS) {
    const c = adapterFor(id).capabilities;
    assert.ok(c, `${id} declares no capabilities, so its gaps would be silent`);
    for (const field of ["commands", "commandArgs", "outcome", "exitCode", "duration", "filesRead", "filesChanged", "pairing"]) {
      assert.ok(field in c, `${id} says nothing about ${field}`);
    }
  }
});

test("a capability is never a bare maybe: every value is one of the declared kinds", () => {
  // The vocabulary is closed on purpose. A value outside it is not a smaller
  // problem than a missing one: a reader that does not recognise a word either
  // guesses or ignores it, and both are worse than being told nothing. This test
  // caught its own author using "full" before it was a word.
  const allowed = new Set([true, false, "full", "parsed", "partial", "pointer", "summary", "truncated", "keyed", "positional"]);
  for (const id of AGENT_IDS) {
    for (const [field, value] of Object.entries(adapterFor(id).capabilities)) {
      assert.ok(allowed.has(value), `${id}.${field} is ${JSON.stringify(value)}, which no reader knows how to interpret`);
    }
  }
});

// The finding that broke the first manifest design. Grok was assumed to provide
// command text like everyone else, because its quota had run out and nobody
// thought to read the files it had already written to disk.
test("Grok really cannot say which command it ran, as declared", () => {
  const started = rows("grok-events.jsonl").find((r) => r.type === "tool_started");
  assert.ok(started, "the fixture must contain a real tool_started row");
  assert.deepEqual(Object.keys(started).sort(), ["toolName", "ts", "type"].sort().map((k) => (k === "toolName" ? "tool_name" : k)).sort());
  assert.equal(adapterFor("grok").capabilities.commandArgs, false, "declaring true here would promise text that is not recorded");
});

test("Grok really does record duration as a field, where others must parse or guess", () => {
  const done = rows("grok-events.jsonl").find((r) => r.type === "tool_completed");
  assert.equal(typeof done.duration_ms, "number", "the claim is a structured field, not a parsed one");
  assert.ok(["success", "error"].includes(done.outcome));
  assert.equal(adapterFor("grok").capabilities.duration, true);
  assert.equal(adapterFor("grok").capabilities.pairing, "positional", "neither Grok tool row carries an id to pair on");
  assert.equal(started(done), undefined);
  function started(row) {
    return row.id ?? row.call_id ?? row.tool_id;
  }
});

// Codex is the only agent with an exit code, and the only one where it has to be
// read out of prose. "parsed" is the honest word for that, and the distinction is
// the point of not using booleans.
test("Codex pairs by a real key, but its exit code and duration live inside a string", () => {
  const [call, output] = rows("codex.jsonl").map((r) => r.payload);
  assert.equal(call.type, "function_call");
  assert.equal(output.type, "function_call_output");
  assert.equal(call.call_id, output.call_id, "pairing is keyed, so it survives concurrency and reordering");
  assert.equal(adapterFor("codex").capabilities.pairing, "keyed");

  assert.equal(output.exitCode, undefined, "if this ever becomes a field, the declaration must stop saying parsed");
  assert.match(output.output, /Process exited with code/, "today it is prose, which is why it is parsed and fragile");
  assert.match(output.output, /Wall time/);
  assert.equal(adapterFor("codex").capabilities.exitCode, "parsed");
  assert.equal(adapterFor("codex").capabilities.duration, "parsed");
});

test("Codex observes every parsed process field it declares", () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.cwd()), ".tmp-codex-audit-"));
  try {
    const transcriptPath = path.join(tmp, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, fs.readFileSync(path.join(FIXTURES, "codex.jsonl"), "utf8"));
    assert.deepEqual(adapterFor("codex").observeAudit({ transcriptPath }), {
      commandArgs: true,
      outcome: "parsed",
      exitCode: "parsed",
      duration: "parsed",
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Claude pairs by tool_use_id and reports only whether a call failed", () => {
  const blocks = rows("claude.jsonl").flatMap((r) => r.message?.content ?? []);
  const use = blocks.find((b) => b.type === "tool_use");
  const result = blocks.find((b) => b.type === "tool_result");
  assert.ok(use && result, "the fixture must hold a real call and a real result");
  assert.ok(use.id, "the key that makes pairing exact");
  assert.ok("tool_use_id" in result);
  assert.equal(adapterFor("claude").capabilities.pairing, "keyed");

  assert.equal(result.exit_code, undefined, "there is no exit code, only is_error");
  assert.equal(adapterFor("claude").capabilities.exitCode, false);
  assert.equal(adapterFor("claude").capabilities.duration, false);
  assert.ok(use.input, "arguments are recorded, unlike Grok");
  assert.equal(adapterFor("claude").capabilities.commandArgs, true);
});

// Read only the RUN_COMMAND rows and Antigravity looks as blind as Grok. The
// command lives one row earlier, on the response that issued the tool call.
test("Antigravity keeps the command in tool_calls, not in the row that reports it", () => {
  const all = rows("antigravity.jsonl");
  const run = all.find((r) => r.type === "RUN_COMMAND");
  const planner = all.find((r) => (r.tool_calls ?? []).length);

  assert.ok(run, "fixture must contain a real RUN_COMMAND row");
  assert.ok(planner?.tool_calls?.[0]?.name, "and the response row that actually names the tool");
  assert.ok(planner.tool_calls[0].args, "with its arguments, which is what commandArgs true refers to");
  assert.equal(adapterFor("antigravity").capabilities.commandArgs, true);

  assert.match(run.content, /Created At|Completed At|completed successfully/, "outcome and duration are prose here");
  assert.equal(adapterFor("antigravity").capabilities.outcome, "parsed");
  assert.equal(adapterFor("antigravity").capabilities.duration, "parsed");
});

test("Antigravity's tool output is truncated by Antigravity, so there is nothing fuller to point at", () => {
  assert.equal(adapterFor("antigravity").capabilities.toolOutput, "truncated");
  assert.notEqual(adapterFor("antigravity").capabilities.toolOutput, "pointer", "a pointer would promise a fuller copy that was never written");
});

// Codex runs everything through exec_command, so an empty read set from Codex
// means the concept does not apply rather than that it read nothing. That
// difference is the entire reason capabilities exist beside the manifest.
test("an agent with no file-reading tool declares false, not partial", () => {
  assert.equal(adapterFor("codex").capabilities.filesRead, false);
  assert.equal(adapterFor("claude").capabilities.filesRead, "partial", "Claude reads through Bash too, which is invisible without parsing shell");
});

test("no adapter claims to carry a full reasoning chain it cannot produce", () => {
  assert.equal(adapterFor("codex").capabilities.reasoning, "summary", "most Codex reasoning is encrypted_content");
  for (const id of AGENT_IDS) {
    const r = adapterFor(id).capabilities.reasoning;
    assert.ok(r === true || r === false || r === "summary" || r === "full", `${id} reasoning claim is unreadable: ${r}`);
  }
});

test("the fixtures are real rows, not hand-written approximations", () => {
  for (const f of ["claude.jsonl", "codex.jsonl", "grok-events.jsonl", "antigravity.jsonl"]) {
    const parsed = rows(f);
    assert.ok(parsed.length, `${f} is empty`);
    for (const row of parsed) {
      const keys = Object.keys(row);
      assert.ok(keys.length > 2, `${f} has a row with ${keys.length} keys, which looks invented rather than captured`);
    }
  }
});

test("every registered adapter is covered by a fixture, including any added later", () => {
  const covered = new Set(["claude", "codex", "grok", "antigravity"]);
  for (const id of AGENT_IDS) {
    assert.ok(covered.has(id), `${id} declares capabilities that no real transcript pins`);
    assert.ok(ADAPTERS[id].capabilities, `${id} must declare capabilities`);
  }
});

// The half of drift nobody watches for. Existing canaries notice when a vendor
// renames a field we read, because parsing breaks. Nothing notices when a vendor
// STARTS recording something we declare as absent: Grok could begin storing
// command arguments tomorrow and this project would report that it cannot,
// forever, with every test green.
test("drift is reported in both directions, not only when something is lost", async () => {
  const { capabilityDrift } = await import("../src/probe.mjs");
  assert.equal(capabilityDrift({ commandArgs: true }, { commandArgs: false }).status, "lost");
  assert.equal(capabilityDrift({ commandArgs: false }, { commandArgs: true }).status, "gained");
  assert.deepEqual(capabilityDrift({ commandArgs: false }, { commandArgs: true }).gained, ["commandArgs"]);
});

// Absence of evidence is not evidence of absence, and a probe that confuses the
// two is the same false alarm as calling a fresh project broken.
test("a session with no tool calls proves nothing and says nothing", async () => {
  const { capabilityDrift } = await import("../src/probe.mjs");
  assert.equal(capabilityDrift({ commandArgs: false, duration: true }, { commandArgs: null, duration: null }).status, "matches");
  for (const id of AGENT_IDS) {
    const observed = adapterFor(id).observeAudit({ transcriptPath: "/does/not/exist", eventsPath: "/does/not/exist" });
    for (const v of Object.values(observed)) assert.equal(v, null, `${id} must report null, never false, when it saw nothing`);
  }
});

// The first run of the drift check reported that Codex had lost its exit code.
// The claim said "parsed", meaning read out of prose, and the observer looked for
// a structured field and correctly failed to find one. Both were right and the
// comparison was still wrong, so ranking exists to compare like with like.
test("prose and a real field are not confused for each other, in either direction", async () => {
  const { capabilityDrift } = await import("../src/probe.mjs");
  assert.equal(capabilityDrift({ exitCode: "parsed" }, { exitCode: "parsed" }).status, "matches");
  assert.equal(capabilityDrift({ exitCode: "parsed" }, { exitCode: true }).status, "gained", "prose promoted to a field is an upgrade worth hearing about");
  assert.equal(capabilityDrift({ exitCode: "parsed" }, { exitCode: false }).status, "lost");
  assert.equal(capabilityDrift({ exitCode: true }, { exitCode: "parsed" }).status, "lost", "a field demoted to prose is a real regression");
});

test("every adapter can be asked what it actually observed, including any added later", () => {
  for (const id of AGENT_IDS) {
    assert.equal(typeof adapterFor(id).observeAudit, "function", `${id} declares capabilities nothing can check against reality`);
  }
});
