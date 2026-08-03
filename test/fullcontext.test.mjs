import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { composeFullContext } from "../src/delta.mjs";
import { loadState, saveState } from "../src/state.mjs";

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

test("a first switch carries the whole conversation, a later one carries only what is new", () => {
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
  const run = () =>
    spawnSync(process.execPath, [BRIDGE_BIN, "handoff", "claude"], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: THREAD_ID },
    });

  // FIRST switch: bounded like every other, not an inline dump. A small
  // conversation still travels whole, but it is composed against the road's
  // budget and names the full context checkpoint, rather than pasting the entire
  // history into a single delivery that a prompt agent receives as one argv.
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  let s = loadState(project);
  const firstDelta = fs.readFileSync(path.join(project, s.pendingInjection.deltaFile), "utf8");
  assert.ok(firstDelta.includes(LONG_MESSAGE), "a small first conversation still travels whole");
  assert.match(firstDelta, /This is the first switch/, "and says so, pointing at the checkpoint for the rest");
  assert.match(firstDelta, /Full context checkpoint:/);
  assert.doesNotMatch(firstDelta, /whole conversation is above/, "the un-clipped inline dump is the E2BIG bug, removed");

  // LATER switch: the target has a session now, so only new material travels and
  // the full context checkpoint is referenced instead of inlined.
  s.agents.claude.id = "linked-claude";
  // The fixture lives in the past, so pin Codex's own watermark just before the
  // message added below; otherwise "since now" would filter the fixture out.
  s.agents.codex.mark = "2026-07-20T10:30:00.000Z";
  saveState(project, s);
  fs.appendFileSync(
    path.join(day, `rollout-2026-07-20T10-00-00-${THREAD_ID}.jsonl`),
    JSON.stringify({
      timestamp: "2026-07-20T11:00:00.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "later: " + LONG_MESSAGE },
    }) + "\n"
  );

  const second = run();
  assert.equal(second.status, 0, second.stderr);
  s = loadState(project);
  const laterDelta = fs.readFileSync(path.join(project, s.pendingInjection.deltaFile), "utf8");
  // This assertion used to be its opposite: it required the later delta to clip
  // the long message, because clipping was what the code did. It was proving the
  // defect rather than a requirement. A message that fits inside the road's
  // budget now travels whole, and this one is far inside it.
  assert.ok(laterDelta.includes("later: " + LONG_MESSAGE), "a message that fits must travel whole");
  // This assertion also used to require the opposite, and it is why the suite
  // stayed green while the product text contradicted the change: it demanded the
  // words "temporary" and "may be pruned after this agent hands off", which
  // described a lifetime the file no longer has. The delta must not set a
  // deadline that does not exist, and must not promise an archive either.
  const ref = laterDelta.match(/Full context checkpoint: (\S+)/);
  assert.ok(ref, "a later delta names the full context checkpoint");
  assert.doesNotMatch(laterDelta, /Temporary full context/, "it is not deleted when its reader moves on");
  assert.doesNotMatch(laterDelta, /after this agent hands off/, "that deadline was removed with the delivery-time deletion");
  assert.match(
    laterDelta,
    /kept with this handoff's other checkpoints until they are pruned together/,
    "the real lifetime is the group's, and the delta has to say which one it is"
  );
  const full = fs.readFileSync(path.join(project, ref[1]), "utf8");
  assert.ok(full.includes(LONG_MESSAGE), "the checkpoint keeps the message verbatim");
});

// The bug that shipped in 0.10.0 and broke the first live OpenCode switch. A
// first switch used to inline the entire conversation un-clipped, on the theory
// that a new agent knows nothing. On a 3140-message conversation that produced a
// 1.8MB delta, and a prompt-injecting agent receives its delta as a single
// command-line argument, so `spawn` threw E2BIG (ARG_MAX is ~1MB on macOS) and
// the agent never started. It received nothing, and could not hand back. The
// summary and the durable full context checkpoint, both built after that
// exemption was written, make the dump unnecessary: the reading leads and the
// rest lives in the checkpoint.
test("a first switch on a huge conversation fits the delivery channel", async () => {
  const { handoff } = await import("../src/handoff.mjs");
  const { defaultState, saveState, loadState, checkpointsDir } = await import("../src/state.mjs");
  const { PROMPT_DELTA_BYTES } = await import("../src/delivery.mjs");
  const os = await import("node:os");

  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-firstbig-")));
  fs.mkdirSync(checkpointsDir(project), { recursive: true });
  const rollout = path.join(project, "rollout.jsonl");
  // Far past ARG_MAX if it were inlined: 3000 messages of 500 bytes each is ~1.5MB.
  fs.writeFileSync(
    rollout,
    Array.from({ length: 3000 }, (_, i) =>
      JSON.stringify({
        timestamp: `2026-08-02T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: { type: "agent_message", message: `m${i} ` + "x".repeat(500) },
      })
    ).join("\n")
  );
  const s = defaultState(project);
  s.agents.codex = { id: "019f-codex", transcriptPath: rollout, mark: null, idle: false };
  s.activeAgent = "codex";
  saveState(project, s);

  // grok is a prompt-injecting agent with no session yet: the first-switch path.
  handoff(project, "grok", { from: "codex", summary: "the reading", decisions: "d", next: "n", checkTarget: () => {} });

  const rel = loadState(project).pendingInjection.deltaFile;
  const bytes = fs.statSync(path.join(project, rel)).size;
  assert.ok(bytes <= PROMPT_DELTA_BYTES, `first-switch delta was ${bytes}, over the road it must fit`);

  // And it must actually be spawnable as an argument, which is the real failure.
  const { spawnSync } = await import("node:child_process");
  const delta = fs.readFileSync(path.join(project, rel), "utf8");
  const r = spawnSync("/bin/echo", ["--", delta]);
  assert.equal(r.error?.code, undefined, "a delta that cannot be passed to spawn never reaches the agent");

  // The conversation it could not carry is whole in the checkpoint it points at.
  const ref = delta.match(/Full context checkpoint: (\S+)/);
  assert.ok(ref, "and the overflow is pointed at, not lost");
  const full = fs.readFileSync(path.join(project, ref[1]), "utf8");
  assert.ok(full.includes("m2999"), "the newest message is in the checkpoint");
  assert.ok(full.includes("m0"), "and so is the oldest");
});
