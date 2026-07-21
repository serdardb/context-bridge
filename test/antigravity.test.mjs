import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every fact these tests encode came from running agy 1.1.5 and reading what it
// wrote, not from its documentation and not from what the agent said about
// itself. One of its own claims about its CLI did not survive that check.
const HOME_ENV = "ANTIGRAVITY_HOME";

test("a conversation is found by the workspace its prompts were typed in", async () => {
  const { home, adapter } = await fixture();
  const project = "/tmp/proj-a";
  writeHistory(home, [
    { display: "hi", timestamp: 1000, workspace: project, conversationId: "aaa" },
    { display: "hey", timestamp: 2000, workspace: "/tmp/proj-b", conversationId: "bbb" },
  ]);
  assert.equal(adapter.discover(project)?.id, "aaa");
  assert.equal(adapter.discover("/tmp/proj-c"), null, "a project with no conversation has none");
});

// The workspace recorded is the directory Antigravity was opened in, and that can
// be a parent of the project. Matching by prefix would hand a conversation from
// one project to another, which is the worst failure this product has.
test("a conversation from a parent directory is not this project's conversation", async () => {
  const { home, adapter } = await fixture();
  writeHistory(home, [{ display: "hi", timestamp: 1000, workspace: "/tmp/parent", conversationId: "aaa" }]);
  assert.equal(adapter.discover("/tmp/parent/child"), null);
  assert.equal(adapter.discover("/tmp/parent")?.id, "aaa");
});

// history.jsonl records only what the user typed. A session the bridge seeded and
// the user closed without a word leaves no row there, and would be invisible.
test("a session that left no history row is still adopted from its conversation directory", async () => {
  const { home, adapter } = await fixture();
  writeHistory(home, []);
  const born = Date.now();
  writeTranscript(home, "ghost", [row(0, "USER_INPUT", "<USER_REQUEST>seeded by the bridge</USER_REQUEST>")]);

  const found = adapter.adoptStartedSession("/tmp/anywhere", { startedAt: new Date(born).toISOString() });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "ghost");
});

test("a conversation that predates the launch is not adopted as ours", async () => {
  const { home, adapter } = await fixture();
  writeHistory(home, [{ display: "old", timestamp: 1000, workspace: "/tmp/proj", conversationId: "old" }]);
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  assert.deepEqual(adapter.adoptStartedSession("/tmp/proj", { startedAt: future }), []);
});

// The objection that changed this adapter, raised by Antigravity itself: a
// transcript carries internal rows holding memory-compaction text. Forwarding
// those would tell the next agent the user said something it never said.
test("internal machinery rows never reach the next agent", async () => {
  const { home, adapter } = await fixture();
  writeTranscript(home, "conv", [
    row(0, "USER_INPUT", "<USER_REQUEST>fix the parser</USER_REQUEST>\n<ADDITIONAL_METADATA>local time…</ADDITIONAL_METADATA>"),
    row(1, "CONVERSATION_HISTORY", "internal history blob", "SYSTEM"),
    row(2, "PLANNER_RESPONSE", "Fixed it.", "MODEL"),
    row(3, "CHECKPOINT", "{{ CHECKPOINT 0 }} the earlier parts of this conversation…", "SYSTEM"),
  ]);
  const { messages } = adapter.activitySince(adapter.refById(null, "conv"), null);
  assert.deepEqual(
    messages.map((m) => [m.role, m.text]),
    [
      ["user", "fix the parser"],
      ["assistant", "Fixed it."],
    ],
    "only the conversation crosses, and the user's text without the harness wrapped around it"
  );
});

test("the watermark is the step index, and nothing is resent or skipped", async () => {
  const { home, adapter } = await fixture();
  writeTranscript(home, "conv", [
    row(0, "USER_INPUT", "<USER_REQUEST>one</USER_REQUEST>"),
    row(1, "PLANNER_RESPONSE", "first", "MODEL"),
    row(2, "USER_INPUT", "<USER_REQUEST>two</USER_REQUEST>"),
    row(3, "PLANNER_RESPONSE", "second", "MODEL"),
  ]);
  const ref = adapter.refById(null, "conv");
  assert.equal(adapter.currentMark(ref), 3);
  assert.equal(adapter.activitySince(ref, null).messages.length, 4, "no watermark means everything");
  assert.deepEqual(
    adapter.activitySince(ref, 1).messages.map((m) => m.text),
    ["two", "second"],
    "past the watermark only, and the row at the watermark is not sent again"
  );
  assert.equal(adapter.activitySince(ref, 3).messages.length, 0, "caught up means nothing to send");
});

test("a turn is over when the transcript ends on a finished model response", async () => {
  const { home, adapter } = await fixture();
  const ref = adapter.refById(null, "conv");

  writeTranscript(home, "conv", [
    row(0, "USER_INPUT", "<USER_REQUEST>go</USER_REQUEST>"),
    row(1, "PLANNER_RESPONSE", "working", "MODEL", "IN_PROGRESS"),
  ]);
  assert.equal(adapter.idleAfter(ref), false, "a response still being written is not the end of a turn");

  writeTranscript(home, "conv", [
    row(0, "USER_INPUT", "<USER_REQUEST>go</USER_REQUEST>"),
    row(1, "PLANNER_RESPONSE", "done", "MODEL"),
  ]);
  assert.equal(adapter.idleAfter(ref), true);
});

test("resuming names the conversation, and a delta rides as the opening prompt", async () => {
  const { adapter } = await fixture();
  const { cmd, args } = adapter.resumeCommand({ id: "conv" });
  assert.equal(cmd, "agy");
  assert.deepEqual(args, ["--conversation", "conv"]);
  // Antigravity argued this could not work programmatically, having tested it
  // headlessly where there is no terminal. Under the one the launcher hands its
  // child it works, and the seeded prompt is the transcript's first row.
  assert.deepEqual(adapter.promptArgs("DELTA"), ["--prompt-interactive", "DELTA"]);
});

async function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
  fs.mkdirSync(path.join(home, "brain"), { recursive: true });
  process.env[HOME_ENV] = home;
  const adapter = await import(`../src/agents/antigravity.mjs?home=${encodeURIComponent(home)}`);
  return { home, adapter };
}

function writeHistory(home, rows) {
  fs.writeFileSync(path.join(home, "history.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function writeTranscript(home, conversationId, rows) {
  const dir = path.join(home, "brain", conversationId, ".system_generated", "logs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "transcript.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function row(step_index, type, content, source = "USER_EXPLICIT", status = "DONE") {
  return { step_index, source, type, status, created_at: "2026-07-21T12:00:00Z", content };
}

// The residual risk Codex raised: a conversation directory records no workspace,
// so the silent-session fallback knows only that something began after we
// spawned. It is safe because of what it is combined with rather than on its own:
// our own session always creates a directory, so a second candidate means we
// cannot tell ours apart, and the caller refuses rather than picking.
test("two conversations in the launch window are both returned, so nothing is adopted", async () => {
  const { home, adapter } = await fixture();
  writeHistory(home, []);
  const startedAt = new Date(Date.now() - 1000).toISOString();
  writeTranscript(home, "ours", [row(0, "USER_INPUT", "<USER_REQUEST>seeded</USER_REQUEST>")]);
  writeTranscript(home, "someone-elses", [row(0, "USER_INPUT", "<USER_REQUEST>unrelated</USER_REQUEST>")]);

  const found = adapter.adoptStartedSession("/tmp/proj", { startedAt });
  assert.equal(found.length, 2, "ambiguity has to reach the caller, which refuses on more than one");
});

// Named evidence beats a time window whenever it exists.
test("a conversation named in history wins over anything the window turned up", async () => {
  const { home, adapter } = await fixture();
  const project = "/tmp/proj";
  writeHistory(home, [{ display: "hi", timestamp: Date.now(), workspace: project, conversationId: "named" }]);
  writeTranscript(home, "named", [row(0, "USER_INPUT", "<USER_REQUEST>hi</USER_REQUEST>")]);
  writeTranscript(home, "unrelated-but-recent", [row(0, "USER_INPUT", "<USER_REQUEST>elsewhere</USER_REQUEST>")]);

  const found = adapter.adoptStartedSession(project, { startedAt: new Date(Date.now() - 1000).toISOString() });
  assert.deepEqual(found.map((r) => r.id), ["named"], "the fallback is only for when nothing is named");
});

// Antigravity caps what it writes into its own transcript at roughly 4KB a row
// and records the fact in `truncated_fields`. On the first real session 14 of 55
// rows were cut. Forwarding the remains unmarked would be the silent loss this
// project keeps finding elsewhere: the next agent cannot tell a short message
// from a long one it only received the beginning of.
test("text the agent truncated itself does not travel as though it were whole", async () => {
  const adapter = await import("../src/agents/antigravity.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-trunc-"));
  const transcript = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    transcript,
    [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>a long brief</USER_REQUEST>", truncated_fields: ["content"] },
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "the verdict", truncated_fields: ["content"] },
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", content: "complete answer" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n")
  );

  const { messages } = adapter.activitySince({ transcriptPath: transcript }, null);
  assert.equal(messages.length, 3);
  assert.match(messages[0].text, /^a long brief\n\n\[cut short/, "the user's own words come first, then the notice");
  assert.match(messages[1].text, /\[cut short by Antigravity's own transcript limit\]/);
  assert.doesNotMatch(messages[2].text, /cut short/, "a whole message must not be announced as clipped");
});

test("a row that reports no truncation is passed through untouched", async () => {
  const adapter = await import("../src/agents/antigravity.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-whole-"));
  const transcript = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    transcript,
    JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", content: "said in full", truncated_fields: [] })
  );
  const { messages } = adapter.activitySince({ transcriptPath: transcript }, null);
  assert.equal(messages[0].text, "said in full");
});

// Found by replaying a real 64-row session: a PLANNER_RESPONSE that issues a
// tool call is written as DONE the instant it is emitted, and the tool rows that
// follow are not conversation rows, so they never become the last one. The turn
// therefore read as finished for the entire duration of every tool call — 25
// separate moments in that one session, each a chance to terminate the agent
// while it was working.
test("a response that is issuing a tool call is not the end of a turn", async () => {
  const adapter = await import("../src/agents/antigravity.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-idle-"));
  const t = path.join(dir, "transcript.jsonl");
  const write = (rows) => fs.writeFileSync(t, rows.map((r) => JSON.stringify(r)).join("\n"));

  const thinking = { step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", content: "", tool_calls: [{ name: "run_command" }] };
  write([thinking]);
  assert.equal(adapter.idleAfter({ transcriptPath: t }), false, "it has only just started working");

  // The tool ran. It is not a conversation row, so the tool-issuing response is
  // still the last one we see: the answer must not change.
  write([thinking, { step_index: 1, type: "RUN_COMMAND", status: "DONE", content: "output" }]);
  assert.equal(adapter.idleAfter({ transcriptPath: t }), false, "a finished tool is not a finished turn");

  write([thinking, { step_index: 1, type: "RUN_COMMAND", status: "DONE", content: "out" }, { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", content: "here is the answer" }]);
  assert.equal(adapter.idleAfter({ transcriptPath: t }), true, "now it has spoken and stopped");
});

test("a turn is over when the agent answers without calling anything", async () => {
  const adapter = await import("../src/agents/antigravity.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-idle2-"));
  const t = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(t, JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", content: "done", tool_calls: [] }));
  assert.equal(adapter.idleAfter({ transcriptPath: t }), true);
});
