import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as claude from "../src/agents/claude.mjs";
import * as codex from "../src/agents/codex.mjs";

test("timestamped adapters retain late rows, rewritten history and late command outcomes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-progress-"));
  const timestamp = "2026-01-01T00:00:00.000Z";
  try {
    for (const adapter of [claude, codex]) {
      const ref = { transcriptPath: path.join(dir, `${adapter.id}.jsonl`) };
      const message = text => adapter.id === "claude"
        ? { timestamp, type: "user", message: { content: text } }
        : { timestamp, type: "event_msg", payload: { type: "user_message", message: text } };
      const call = adapter.id === "claude"
        ? { timestamp, type: "assistant", message: { content: [{ type: "tool_use", id: "call", name: "Bash", input: { command: "false" } }] } }
        : { timestamp, type: "response_item", payload: { type: "function_call", call_id: "call", name: "exec_command", arguments: '{"cmd":"false"}' } };
      const output = adapter.id === "claude"
        ? { timestamp, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", is_error: true }] } }
        : { timestamp, type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "Exit code: 1" } };
      const write = rows => fs.writeFileSync(ref.transcriptPath, rows.map(JSON.stringify).join("\n") + "\n");
      write([message("original"), call]);
      const mark = adapter.currentMark(ref);
      assert.equal(adapter.activitySince(ref, mark).messages.length, 0);
      write([message("original"), call, message("late"), output]);
      assert.deepEqual(adapter.activitySince(ref, mark).messages.map(m => m.text), ["late"]);
      assert.equal(adapter.activitySince(ref, mark).sourceRewritten, false);
      const audit = adapter.auditSince(ref, mark);
      assert.equal(audit.commands.length, 1);
      assert.equal(audit.commands[0].args, "false");
      assert.equal(audit.commands[0].ok, false);
      const refreshed = adapter.currentMark(ref);
      assert.equal(adapter.auditSince(ref, refreshed).commands.length, 0);
      write([message("corrected"), call, message("late"), output]);
      assert.equal(adapter.activitySince(ref, refreshed).sourceRewritten, true);
      assert.equal(adapter.activitySince(ref, refreshed).messages[0].text, "corrected");
      assert.equal(adapter.auditSince(ref, refreshed).commands[0].ok, false);
      write([message("shortened")]);
      assert.equal(adapter.activitySince(ref, refreshed).sourceRewritten, true);
      assert.equal(adapter.activitySince(ref, timestamp).messages.length, 0, "legacy ISO filtering remains supported");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
