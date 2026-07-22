import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeMessagesSince,
  codexActivitySince,
  composeDelta,
  conversationAccount,
  deltaLostSomething,
  rolloutIdleAfter,
} from "../src/delta.mjs";

test("claudeMessagesSince extracts post-sync user and assistant text defensively", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-delta-"));
  const transcript = path.join(dir, "claude.jsonl");
  writeJsonl(transcript, [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "user",
      message: { content: "old message" },
    },
    {
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "user",
      isSidechain: true,
      message: { content: "sidechain" },
    },
    {
      timestamp: "2026-01-01T00:00:02.000Z",
      type: "user",
      message: { content: "<command-name>/bridge</command-name>" },
    },
    {
      timestamp: "2026-01-01T00:00:03.000Z",
      type: "user",
      message: { content: [{ type: "text", text: "new user request" }] },
    },
    {
      timestamp: "2026-01-01T00:00:04.000Z",
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash" },
          { type: "text", text: "assistant answer" },
        ],
      },
    },
    "{broken json",
  ]);

  assert.deepEqual(claudeMessagesSince(transcript, "2026-01-01T00:00:00.000Z"), [
    { role: "user", text: "new user request", at: "2026-01-01T00:00:03.000Z" },
    { role: "assistant", text: "assistant answer", at: "2026-01-01T00:00:04.000Z" },
  ]);
});

test("codexActivitySince extracts messages, patch files, and idle signal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-rollout-"));
  const rollout = path.join(dir, "rollout.jsonl");
  writeJsonl(rollout, [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "old" },
    },
    {
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "implement the fix" },
    },
    {
      timestamp: "2026-01-01T00:00:02.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "patched it" },
    },
    {
      timestamp: "2026-01-01T00:00:03.000Z",
      type: "event_msg",
      payload: { type: "patch_apply_end", changes: { "src/app.js": {}, "README.md": {} } },
    },
    {
      timestamp: "2026-01-01T00:00:04.000Z",
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "patched it" },
    },
  ]);

  const activity = codexActivitySince(rollout, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(activity.messages, [
    { role: "user", text: "implement the fix", at: "2026-01-01T00:00:01.000Z" },
    { role: "assistant", text: "patched it", at: "2026-01-01T00:00:02.000Z" },
  ]);
  assert.deepEqual(activity.patchedFiles.sort(), ["README.md", "src/app.js"]);
  assert.equal(activity.turnsCompleted, 1);
  assert.equal(rolloutIdleAfter(rollout, "2026-01-01T00:00:03.500Z"), true);
  assert.equal(rolloutIdleAfter(rollout, "2026-01-01T00:00:04.000Z"), false);
});

test("composeDelta respects the UTF-8 byte cap", () => {
  const delta = composeDelta({
    fromAgent: "codex",
    conversation: Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      text: `message ${i} ` + "ş".repeat(300),
    })),
    decisions: ["Use byte-aware truncation."],
    work: Array.from({ length: 80 }, (_, i) => `uncommitted: M file-${i}-${"ş".repeat(120)}.js`),
    next: ["Run tests."],
  });

  assert.ok(Buffer.byteLength(delta, "utf8") <= 8 * 1024);
  assert.match(delta, /\[… truncated …\]/);
});

// A delta that carries a fifth of what it was given and says nothing about the
// rest is not a bounded delta, it is a lossy one presenting as complete. These
// do not change what is carried; they change what the delta admits to. The bug
// they exist for: a Codex review arrived as its first 220 characters, and the
// part cut away was the evidence and an operational warning. Nothing in the
// delta suggested anything was missing, so it read as a short review rather than
// a truncated one.

test("messages that never entered the delta are counted and named", () => {
  const delta = composeDelta({
    fromAgent: "codex",
    conversation: Array.from({ length: 40 }, (_, i) => ({ role: "assistant", text: `message ${i}` })),
    decisions: [],
    work: [],
    next: [],
  });

  // 40 candidates, 14 carried, and the 26 absent ones are the whole point.
  assert.match(delta, /26 of Codex's 40 new messages did not fit above\./);
});

test("a delta that left nothing out says nothing about leaving things out", () => {
  const delta = composeDelta({
    fromAgent: "codex",
    conversation: [
      { role: "user", text: "short question" },
      { role: "assistant", text: "short answer" },
    ],
    decisions: [],
    work: [],
    next: [],
  });

  assert.doesNotMatch(delta, /did not fit/);
  assert.doesNotMatch(delta, /shortened/, "silence is the claim that nothing was cut, so it has to be true");
});

test("a message shortened to fit says so, and one merely reflowed does not", () => {
  const delta = composeDelta({
    fromAgent: "codex",
    conversation: [
      { role: "assistant", text: "x".repeat(400) },
      // Long enough to be suspicious, short enough to survive whole once its
      // newlines collapse. oneLine reflows it; nothing is lost, so nothing is claimed.
      { role: "assistant", text: "line one\nline two\nline three" },
    ],
    decisions: [],
    work: [],
    next: [],
  });

  assert.match(delta, /1 of Codex's 2 messages above is shortened to its first 220 characters\./);
  assert.doesNotMatch(delta, /did not fit/);
  assert.doesNotMatch(delta, / are shortened/, "one message is not 'are'; a count that reads wrong reads as sloppy");
});

test("in a catch-up from several agents each one accounts for itself", () => {
  const delta = composeDelta({
    sources: [
      { id: "codex", label: "Codex", messages: Array.from({ length: 20 }, (_, i) => ({ role: "assistant", text: `c${i}` })) },
      { id: "grok", label: "Grok", messages: Array.from({ length: 3 }, (_, i) => ({ role: "assistant", text: `g${i}` })) },
    ],
    decisions: [],
    work: [],
    next: [],
  });

  // One total would bury which agent came through incomplete, which is exactly
  // the question the receiving agent has to answer before trusting the delta.
  assert.match(delta, /6 of Codex's 20 new messages did not fit above\./);
  assert.doesNotMatch(delta, /Grok's 3 new messages did not fit/);

  const account = conversationAccount({
    sources: [
      { id: "codex", label: "Codex", messages: Array.from({ length: 20 }, () => ({ role: "assistant", text: "c" })) },
      { id: "grok", label: "Grok", messages: Array.from({ length: 3 }, () => ({ role: "assistant", text: "g" })) },
    ],
  });
  assert.deepEqual(
    account.map((a) => [a.label, a.candidates, a.included, a.omitted]),
    [
      ["Codex", 20, 14, 6],
      ["Grok", 3, 3, 0],
    ]
  );
  assert.equal(deltaLostSomething(account), true);
});

function writeJsonl(file, records) {
  fs.writeFileSync(
    file,
    records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n") + "\n"
  );
}
