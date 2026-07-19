import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeMessagesSince,
  codexActivitySince,
  composeDelta,
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

function writeJsonl(file, records) {
  fs.writeFileSync(
    file,
    records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n") + "\n"
  );
}
