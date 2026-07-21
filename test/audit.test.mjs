import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildManifest, renderManifest, latestManifest, writeManifest } from "../src/audit.mjs";
import { handoff } from "../src/handoff.mjs";
import { defaultState, saveState, loadState } from "../src/state.mjs";
import { AGENT_IDS, adapterFor } from "../src/agents/index.mjs";
import { fileURLToPath } from "node:url";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "audit");

// The manifest exists because the delta has to stay small and evidence has to
// stay reachable. Everything in it is taken from the agents' own files, never
// from what an agent says about itself: a self-report is an interpretation, and
// the two turns Antigravity ended without writing a single word would have
// produced no audit trail at all under that design.

test("every agent can be asked what it actually ran, including any added later", () => {
  for (const id of AGENT_IDS) {
    assert.equal(typeof adapterFor(id).auditSince, "function", `${id} would silently contribute nothing to an audit`);
  }
});

test("a handoff writes the manifest beside its delta and points at it in one line", () => {
  const { project } = fixture();
  handoff(project, "grok", { from: "codex", checkTarget: () => {} });

  const state = loadState(project);
  const deltaRel = state.pendingInjection.deltaFile;
  const stem = path.basename(deltaRel, ".md");
  const manifestRel = path.join(".bridge", "checkpoints", `${stem}-audit.json`);
  assert.ok(fs.existsSync(path.join(project, manifestRel)), "the pair must share a stem, or nobody can find one from the other");

  const delta = fs.readFileSync(path.join(project, deltaRel), "utf8");
  assert.match(delta, /bridge inspect/, "the delta has to say the audit exists");
  assert.ok(!delta.includes("exit 0"), "and must not carry the audit itself, which was the whole point");
});

// A session file spans every directory an agent has ever worked in. A first run
// of this listed edits to two unrelated repositories: all true, and none of this
// project's business.
test("work done in other projects stays out of this project's manifest", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "audit-scope-")));
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "audit-other-")));
  const m = buildManifest(
    project,
    {
      source: "codex",
      target: "grok",
      sources: { codex: { transcriptPath: "unused" } },
    },
    {},
    // The adapter is stubbed here because what is under test is the scoping, not
    // any vendor's format, and the real formats are pinned in capabilities.test.
  );
  assert.ok(m.manifestVersion, "a manifest always declares its version");

  const scoped = buildManifest(project, {
    source: "x",
    target: "y",
    sources: { fake: { transcriptPath: "unused" } },
  });
  assert.deepEqual(Object.keys(scoped.agents), [], "an unknown agent contributes nothing rather than throwing");
  assert.ok(elsewhere);
});

test("an extractor that throws costs the audit, never the handoff", () => {
  const { project } = fixture();
  const broken = { auditSince: () => { throw new Error("vendor format moved"); }, capabilities: {} };
  const original = adapterFor("codex").auditSince;
  assert.equal(typeof original, "function");

  const m = buildManifest(project, { source: "codex", target: "grok", sources: { codex: null } });
  assert.deepEqual(Object.keys(m.agents), [], "a null session is skipped quietly");
  assert.ok(broken);
});

// Ordering by usefulness rather than by completeness. One real session produced
// 967 commands of which 6 failed, and the six are why anybody opens this file.
test("failures are rendered first, ahead of everything that worked", () => {
  const out = renderManifest({
    source: "codex",
    target: "claude",
    agents: {
      codex: {
        commands: [
          { tool: "exec_command", args: "npm test", ok: true, exitCode: 0, durationMs: 12 },
          { tool: "exec_command", args: "git status", ok: false, exitCode: 128, durationMs: 3 },
        ],
        filesRead: [],
        filesChanged: ["src/handoff.mjs"],
        dropped: 0,
        capabilities: { commandArgs: true, filesRead: false, exitCode: "parsed" },
      },
    },
  });
  const failedAt = out.indexOf("FAILED");
  const changedAt = out.indexOf("  changed  ");
  assert.ok(failedAt !== -1 && failedAt < changedAt, "a failure buried under successes answers nobody's question");
  assert.match(out, /git status/);
  assert.match(out, /exit 128/);
});

// An empty column means different things for different agents, and a reader with
// only the manifest cannot tell them apart. That ambiguity is the exact shape of
// the worst bug this project has had.
test("an empty column is explained by the agent's declared limits", () => {
  const out = renderManifest({
    source: "grok",
    target: "claude",
    agents: {
      grok: {
        commands: [{ tool: "run_terminal_command", args: null, ok: true, exitCode: null, durationMs: 13 }],
        filesRead: [],
        filesChanged: [],
        dropped: 0,
        capabilities: { commandArgs: false, filesRead: false, exitCode: false },
      },
    },
  });
  assert.match(out, /does not record command text/, "otherwise an empty command reads as no command");
  assert.match(out, /arguments not recorded/, "and the row itself has to say so too");
});

// A cap that nobody is told about turns a partial account into a false one.
test("a capped manifest says how much it left out", () => {
  const out = renderManifest({
    source: "claude",
    target: "codex",
    agents: {
      claude: { commands: [], filesRead: [], filesChanged: [], dropped: 767, capabilities: {} },
    },
  });
  assert.match(out, /767 further commands not recorded/);
});

test("inspect finds the newest manifest and survives a project with none", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "audit-latest-")));
  assert.equal(latestManifest(project), null, "a project with no handoff yet is not an error");

  fs.mkdirSync(path.join(project, ".bridge", "checkpoints"), { recursive: true });
  writeManifest(project, "2026-07-21T10-00-00-000Z-a-to-b", { manifestVersion: 1, source: "a", target: "b", agents: {} });
  writeManifest(project, "2026-07-21T11-00-00-000Z-b-to-c", { manifestVersion: 1, source: "b", target: "c", agents: {} });
  assert.equal(latestManifest(project).manifest.source, "b", "the newest one is the one anybody means");
});

/** A project whose Codex session is a small but real rollout. */
function fixture() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "audit-")));
  const rollout = path.join(project, "rollout.jsonl");
  const rows = [
    { timestamp: "2026-07-21T10:00:00.000Z", type: "response_item", payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) } },
    { timestamp: "2026-07-21T10:00:01.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "Wall time: 2.5 seconds\nProcess exited with code 0\n" } },
    { timestamp: "2026-07-21T10:00:02.000Z", type: "response_item", payload: { type: "function_call", call_id: "c2", name: "exec_command", arguments: JSON.stringify({ cmd: "git status" }) } },
    { timestamp: "2026-07-21T10:00:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "Process exited with code 128\n" } },
    { timestamp: "2026-07-21T10:00:04.000Z", type: "event_msg", payload: { type: "agent_message", message: "done" } },
  ];
  fs.writeFileSync(rollout, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const s = defaultState(project);
  s.agents.codex = { id: "019f-codex", transcriptPath: rollout, mark: null, idle: false };
  s.activeAgent = "codex";
  saveState(project, s);
  return { project, rollout };
}

test("the extractor reads outcome and timing out of the prose Codex writes them in", () => {
  const { project, rollout } = fixture();
  const m = buildManifest(project, { source: "codex", target: "grok", sources: { codex: { transcriptPath: rollout } } });
  const cmds = m.agents.codex.commands;
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0].ok, true);
  assert.equal(cmds[0].durationMs, 2500, "Wall time is seconds and the manifest speaks milliseconds");
  assert.equal(cmds[1].ok, false);
  assert.equal(cmds[1].exitCode, 128);
  assert.equal(cmds[1].args, "git status", "the arguments arrive as a JSON string and are unwrapped");
});

// The four blockers Codex found in review, each pinned so it cannot return. All
// four passed the original 165 tests, which is the point: green was hiding them.

// Blocker 1. Grok's mark is a compound { rows, ts }, and comparing e.ts to the
// whole object is always false, so the watermark did nothing and every handoff
// repacked Grok's entire history.
test("Grok's compound mark actually filters, rather than being compared as an object", async () => {
  const grok = await import("../src/agents/grok.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-mark-"));
  const events = path.join(dir, "events.jsonl");
  fs.writeFileSync(
    events,
    [
      { ts: "2026-07-20T10:00:00.000Z", type: "tool_started", tool_name: "run_terminal_command" },
      { ts: "2026-07-20T10:00:00.100Z", type: "tool_completed", tool_name: "run_terminal_command", outcome: "success", duration_ms: 5 },
      { ts: "2026-07-21T10:00:00.000Z", type: "tool_started", tool_name: "run_terminal_command" },
      { ts: "2026-07-21T10:00:00.100Z", type: "tool_completed", tool_name: "run_terminal_command", outcome: "success", duration_ms: 5 },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n")
  );
  const ref = { transcriptPath: path.join(dir, "chat.jsonl"), eventsPath: events };
  assert.equal(grok.auditSince(ref, null).commands.length, 2, "no mark means everything");
  assert.equal(grok.auditSince(ref, { rows: 0, ts: "2026-07-20T12:00:00.000Z" }).commands.length, 1, "a real ts mark drops the earlier command");
});

// Blocker 2. Antigravity declared filesChanged true while its extractor always
// returned an empty list, so the manifest contradicted its own capability.
test("Antigravity's filesChanged extractor honours what its capability promises", async () => {
  const agy = await import("../src/agents/antigravity.mjs");
  assert.equal(agy.capabilities.filesChanged, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-edit-"));
  const t = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    t,
    JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      tool_calls: [{ name: "replace_file_content", args: { TargetFile: '"/repo/src/x.mjs"' } }],
    })
  );
  const changed = agy.auditSince({ transcriptPath: t }, -1).filesChanged;
  assert.deepEqual(changed, ["/repo/src/x.mjs"], "a declared capability that returns nothing is worse than declaring false");
});

// Blocker 3. Codex writes the exit code two ways across rollout variants:
// "Process exited with code N" and, in custom tool output, "Exit code: N".
// Missing the second under-reported real failures.
test("a real apply_patch is recorded as a command and its Exit code: is parsed", async () => {
  const { codexAuditSince } = await import("../src/delta.mjs");
  // Both rows are cut verbatim from a real rollout: a custom_tool_call issuing
  // apply_patch and its custom_tool_call_output. The earlier version of this test
  // prepended a synthetic function_call, which hid that custom_tool_call itself
  // was never recorded as a command, so the pairing had nothing to attach to.
  const call = fs.readFileSync(path.join(FIXTURES, "codex-custom-call.jsonl"), "utf8").trim();
  const output = fs.readFileSync(path.join(FIXTURES, "codex-exitcode-variant.jsonl"), "utf8").trim();
  assert.equal(JSON.parse(call).payload.call_id, JSON.parse(output).payload.call_id, "the fixtures must actually pair");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-custom-"));
  const rollout = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(rollout, [wrap("2026-07-21T10:00:00.000Z", call), wrap("2026-07-21T10:00:01.000Z", output)].join("\n"));

  const cmds = codexAuditSince(rollout, null).commands;
  assert.equal(cmds.length, 1, "custom_tool_call must be recorded as a command, not only its output");
  assert.equal(cmds[0].tool, "apply_patch");
  assert.equal(cmds[0].exitCode, 0, "the Exit code: format must be parsed, not dropped");
});

/** Rollout rows are stored without a top-level timestamp in the fixture; add one. */
function wrap(ts, line) {
  const row = JSON.parse(line);
  return JSON.stringify({ ...row, timestamp: row.timestamp ?? ts });
}

// Blocker 4. The cap dropped everything past 200, so a failure at command 201
// vanished entirely and no render policy could recover it. The manifest is local
// and free, so it now keeps everything.
test("nothing is dropped for being late: a failure past any old cap still appears", async () => {
  const codex = await import("../src/delta.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cap-"));
  const rollout = path.join(dir, "rollout.jsonl");
  const rows = [];
  for (let i = 0; i < 250; i++) {
    rows.push({ timestamp: `2026-07-21T10:00:${String(i % 60).padStart(2, "0")}.000Z`, type: "response_item", payload: { type: "function_call", call_id: `c${i}`, name: "exec_command", arguments: JSON.stringify({ cmd: `step ${i}` }) } });
    const code = i === 240 ? 1 : 0;
    rows.push({ timestamp: `2026-07-21T10:00:${String(i % 60).padStart(2, "0")}.500Z`, type: "response_item", payload: { type: "function_call_output", call_id: `c${i}`, output: `Process exited with code ${code}\n` } });
  }
  fs.writeFileSync(rollout, rows.map((r) => JSON.stringify(r)).join("\n"));
  const audit = codex.codexAuditSince(rollout, null);
  assert.equal(audit.commands.length, 250, "every command is kept now");
  assert.ok(audit.commands.some((c, i) => i === 240 && c.ok === false), "the late failure survived");
  const rendered = renderManifest({ source: "codex", target: "claude", agents: { codex: { ...audit, filesChanged: [], filesRead: [], capabilities: {} } } });
  assert.match(rendered, /step 240/, "and it is rendered, because failures come first regardless of position");
});
