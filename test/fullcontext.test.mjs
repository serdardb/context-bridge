import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { composeFullContext } from "../src/delta.mjs";
import { loadState } from "../src/state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_BIN = path.join(ROOT, "bin", "bridge.mjs");
const THREAD_ID = "0198aaaa-bbbb-7ccc-8ddd-eeeeffff0002";
const LONG_MESSAGE = "Draft A for the announcement tweet. " + "All wording must survive verbatim. ".repeat(30);

test("composeFullContext keeps every message verbatim with no caps", () => {
  const manyMessages = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    text: `message ${i}: ${LONG_MESSAGE}`,
    at: `2026-07-20T10:00:${String(i).padStart(2, "0")}.000Z`,
  }));
  const full = composeFullContext({
    fromAgent: "codex",
    conversation: manyMessages,
    decisions: ["Keep prose intact."],
    work: [],
    next: ["Review the drafts."],
  });
  for (const m of manyMessages) assert.ok(full.includes(m.text), `message ${m.at} must survive verbatim`);
  assert.doesNotMatch(full, /\[… truncated …\]/);
});

test("handoff writes an un-truncated full-context checkpoint and references it from the delta", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-full-")));
  const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-codexhome-")));
  const day = path.join(codexHome, "sessions", "2026", "07", "20");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(
    path.join(day, `rollout-2026-07-20T10-00-00-${THREAD_ID}.jsonl`),
    [
      { timestamp: "2026-07-20T10:00:00.000Z", type: "session_meta", payload: { id: THREAD_ID, cwd: project } },
      { timestamp: "2026-07-20T10:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: LONG_MESSAGE } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
  );

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "handoff", "claude"], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: THREAD_ID },
  });
  assert.equal(res.status, 0, res.stderr);

  const s = loadState(project);
  const delta = fs.readFileSync(path.join(project, s.pendingInjection.deltaFile), "utf8");
  assert.ok(!delta.includes(LONG_MESSAGE), "the bounded delta clips long messages");
  const ref = delta.match(/Full un-truncated context: (\S+)/);
  assert.ok(ref, "delta must reference the full-context checkpoint");
  const full = fs.readFileSync(path.join(project, ref[1]), "utf8");
  assert.ok(full.includes(LONG_MESSAGE), "the full-context checkpoint keeps the message verbatim");
});
