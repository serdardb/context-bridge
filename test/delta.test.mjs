import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeMessagesSince,
  codexActivitySince,
  composeDelta,
  composeForRoad,
  isBridgeProtocolNoise,
  planDelta,
  SKILL_SENTINEL,
  rolloutIdleAfter,
} from "../src/delta.mjs";
import { HOOK_DELTA_BYTES, PROMPT_DELTA_BYTES } from "../src/delivery.mjs";

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
      timestamp: "2026-01-01T00:00:02.500Z",
      type: "user",
      message: {
        content:
          "Base directory for this skill: <bridge-skill-dir>\n\n" +
          "The user wants to hand this session off to another coding agent via context-bridge.\n" +
          "Follow these steps exactly:\nbridge handoff <target>",
      },
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
      timestamp: "2026-01-01T00:00:01.500Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message:
          "Base directory for this skill: <bridge-skill-dir>\n\n" +
          "The user wants to hand this session off to another coding agent via context-bridge.\n" +
          "Follow these steps exactly:\nbridge handoff <target>",
      },
    },
    {
      timestamp: "2026-01-01T00:00:01.600Z",
      type: "event_msg",
      payload: { type: "user_message", message: "$bridge claude" },
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

// What a delta carries is decided by the road's budget and by nothing else.
//
// Every number that used to decide it was chosen against nothing: 14 messages,
// 220 characters, an 8KB cap. A handoff carried a tenth of what it was allowed
// to, and the message it cut in half was the one worth reading, because a long
// message is long for a reason. Worse, a halved message does not read as
// incomplete. It reads as a short answer, which is how a code review that never
// answered its question passed as one that had.

const BUDGET = 8 * 1024;

test("a message that fits travels whole, with its own structure intact", () => {
  const structured = "Here is the ruling:\n\n1. First point\n2. Second point\n\n```js\nconst x = 1;\n```\n\nDone.";
  const delta = composeDelta(
    { fromAgent: "codex", conversation: [{ role: "assistant", text: structured }], decisions: [], work: [], next: [] },
    BUDGET
  );

  // Not "contains the first 220 characters of": contains the message.
  assert.ok(delta.includes(structured), "the line breaks, the list and the code fence are the message");
});

test("nothing this code produces is a half message", () => {
  const delta = composeDelta(
    {
      fromAgent: "codex",
      conversation: Array.from({ length: 30 }, (_, i) => ({ role: "assistant", text: `m${i} ` + "x".repeat(600) })),
      decisions: [],
      work: [],
      next: [],
    },
    BUDGET
  );

  // Every message that appears at all appears in full. The clip character is the
  // signature of the old rule and must not survive anywhere in the output.
  assert.doesNotMatch(delta, /…/, "an ellipsis in a delta means something was halved");
  const bodies = [...delta.matchAll(/^### Codex.*\n\nm\d+ (x*)/gm)];
  assert.ok(bodies.length > 1, "the fixture must put several messages through");
  for (const m of bodies) {
    assert.equal(m[1].length, 600, "a message is carried whole or not at all");
  }
});

test("what did not fit is counted, and the count matches what is there", () => {
  const sections = {
    fromAgent: "codex",
    conversation: Array.from({ length: 30 }, (_, i) => ({ role: "assistant", text: `m${i} ` + "x".repeat(600) })),
    decisions: [],
    work: [],
    next: [],
  };
  const delta = composeDelta(sections, BUDGET);
  const [plan] = planDelta(sections, BUDGET);

  assert.ok(plan.omitted > 0, "the fixture must overflow the budget or it proves nothing");
  assert.equal(plan.kept.length + plan.omitted, 30);
  assert.equal((delta.match(/^### /gm) ?? []).length, plan.kept.length, "the plan and the text must agree");
  assert.match(delta, new RegExp(`${plan.omitted} earlier messages? from Codex did not fit above, out of 30`));
});

test("the delta stays inside the budget it was given, multi-byte characters included", () => {
  for (const budget of [HOOK_DELTA_BYTES, 16 * 1024, PROMPT_DELTA_BYTES]) {
    const delta = composeDelta(
      {
        fromAgent: "codex",
        conversation: Array.from({ length: 200 }, (_, i) => ({ role: "assistant", text: `m${i} ` + "ş".repeat(300) })),
        decisions: ["Keep it inside the road's limit."],
        work: Array.from({ length: 40 }, (_, i) => `uncommitted: M file-${i}.js`),
        next: ["Run tests."],
      },
      budget
    );
    assert.ok(
      Buffer.byteLength(delta, "utf8") <= budget,
      `budget ${budget} produced ${Buffer.byteLength(delta, "utf8")} bytes`
    );
  }
});

test("a budget too small even for the decisions says so instead of blaming the newest message", () => {
  // The conversation is the elastic part of a delta; the decisions, the git
  // summary and the open questions are short by construction and are never
  // trimmed. So a road narrow enough to be filled by those alone leaves the
  // conversation with nothing, and the reason it gives has to be the real one.
  const sections = {
    fromAgent: "codex",
    conversation: [{ role: "assistant", text: "a perfectly ordinary short message" }],
    decisions: ["Something decided."],
    work: Array.from({ length: 40 }, (_, i) => `uncommitted: M file-${i}.js`),
    next: ["Something next."],
  };
  const delta = composeDelta(sections, 1024);
  const [plan] = planDelta(sections, 1024);

  assert.equal(plan.noRoom, true);
  assert.equal(plan.newestTooLarge, false, "the message is tiny; blaming its size would be a lie");
  assert.match(delta, /budget was spent before the conversation was reached/);
  assert.doesNotMatch(delta, /No conversation activity/);
});

test("composing without a budget is refused rather than given a default", () => {
  // A default here would become the seventh number in this file chosen against
  // nothing, and the first six are the bug.
  assert.throws(() => composeDelta({ fromAgent: "codex", conversation: [] }), /budget/);
});

test("messages come out in the order they happened, though the fill walks backwards", () => {
  const sections = {
    fromAgent: "codex",
    conversation: Array.from({ length: 30 }, (_, i) => ({ role: "assistant", text: `m${i} ` + "x".repeat(600) })),
    decisions: [],
    work: [],
    next: [],
  };
  const delta = composeDelta(sections, BUDGET);
  const seen = [...delta.matchAll(/^### Codex\n\n(m\d+)/gm)].map((m) => Number(m[1].slice(1)));

  assert.ok(seen.length > 1);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "newest-first is how it fills, not how it reads");
  assert.equal(seen[seen.length - 1], 29, "and the newest is the one that must survive");
});

test("an agent whose every word was too large is not reported as an agent that said nothing", () => {
  // The distinction Codex insisted on: silence and an unpayable message are
  // opposite situations, and a delta that renders them the same way tells the
  // receiving agent that nothing happened while something did.
  const sections = {
    fromAgent: "codex",
    conversation: [{ role: "assistant", text: "x".repeat(40 * 1024) }],
    decisions: [],
    work: [],
    next: [],
  };
  const delta = composeDelta(sections, BUDGET);

  assert.doesNotMatch(delta, /No conversation activity/, "this agent was not idle; it was unaffordable");
  assert.match(delta, /None of Codex's 1 new message could be carried: the newest alone is larger/);
  assert.match(delta, /whole in the full context checkpoint/);
  assert.equal(planDelta(sections, BUDGET)[0].newestTooLarge, true);
});

test("an agent that really said nothing still says nothing", () => {
  const delta = composeDelta({ fromAgent: "codex", conversation: [], decisions: [], work: [], next: [] }, BUDGET);
  assert.match(delta, /No conversation activity since last sync/);
  assert.doesNotMatch(delta, /could be carried/);
});

test("a quiet source is not starved by a talkative one sharing the delta", () => {
  const sections = {
    sources: [
      { id: "codex", label: "Codex", messages: Array.from({ length: 200 }, (_, i) => ({ role: "assistant", text: `c${i} ` + "x".repeat(400) })) },
      { id: "grok", label: "Grok", messages: [{ role: "assistant", text: "the three words that mattered" }] },
    ],
    decisions: [],
    work: [],
    next: [],
  };
  const delta = composeDelta(sections, BUDGET);
  const [codex, grok] = planDelta(sections, BUDGET);

  // Equal shares with the surplus flowing on: Grok needs almost nothing and gets
  // all of it, and the rest goes to Codex rather than being held back.
  assert.equal(grok.omitted, 0, "one cheap message must never be crowded out");
  assert.ok(delta.includes("the three words that mattered"));
  assert.ok(codex.kept.length > 0, "and the talkative one still gets the remaining room");
});

test("the hook road is composed against its own budget, not cut down to it", () => {
  const sections = {
    fromAgent: "codex",
    conversation: Array.from({ length: 40 }, (_, i) => ({ role: "assistant", text: `m${i} ` + "x".repeat(300) })),
    decisions: [],
    work: [],
    next: [],
  };
  const hook = composeDelta(sections, HOOK_DELTA_BYTES);
  const prompt = composeDelta(sections, PROMPT_DELTA_BYTES);

  assert.ok(Buffer.byteLength(hook) <= HOOK_DELTA_BYTES);
  assert.ok(planDelta(sections, HOOK_DELTA_BYTES)[0].kept.length < planDelta(sections, PROMPT_DELTA_BYTES)[0].kept.length);
  // Both are whole messages. The narrow road carries fewer of them, not pieces
  // of them, which is the difference between a budget and a blade.
  assert.doesNotMatch(hook, /…/);
  assert.ok(prompt.includes(`m39 ${"x".repeat(300)}`));
  // Pointer-only hook delivery accounting is deliberately NOT here: it belongs
  // to the hook road's own phase, and claiming it now would be the third time a
  // rule was written before its mechanism was read.
});

// Found by Codex in review, after 208 green tests. The caller planned against
// the road's whole budget and composed against the budget minus its own trailing
// text, so the delta could drop a message while the sentence underneath it said
// nothing had been left out. Two budgets meant two deltas, and the one being
// described was never built. The tests missed it because each half was checked
// against itself and never against the other.
test("a message pushed out by the trailing text cannot be reported as nothing left out", () => {
  const sections = {
    fromAgent: "codex",
    conversation: Array.from({ length: 6 }, (_, i) => ({ role: "assistant", text: `m${i} ` + "x".repeat(200) })),
    decisions: ["Something."],
    work: [],
    next: ["Something else."],
  };
  const trailing = (lost) =>
    lost ? "\n\nSOMETHING DID NOT FIT, read the checkpoint." : "\n\nNOTHING was left out of this delta.";

  // The smallest budget at which nothing is left out, so the trailing text is
  // demonstrably the only thing that can push a message over. That is the exact
  // shape of the bug: a budget where the plan says complete and the composed
  // delta, built with less room, is not.
  const lost = (b) => planDelta(sections, b).reduce((n, p) => n + p.omitted, 0);
  let budget = Buffer.byteLength(composeDelta(sections, 64 * 1024));
  while (lost(budget) > 0) budget += 8;
  assert.equal(lost(budget), 0, "at this budget the conversation is complete");

  const out = composeForRoad(sections, budget, trailing);

  assert.ok(Buffer.byteLength(out) <= budget, "the whole thing still has to fit the road");
  assert.ok(out.includes("SOMETHING DID NOT FIT"), "the trailing text ate the room, so the delta has to admit it");
  assert.ok(!out.includes("NOTHING was left out"), "this is the sentence the bug produced");
  // And the count in the body has to agree with the sentence at the foot of it.
  assert.match(out, /did not fit above/);
});

test("a trailing text that answers differently each time still cannot break the budget", () => {
  // Raised in review as the remaining way this could rot: the budget was safe
  // only while `trailing` stayed pure. Rather than ask the next person to keep it
  // that way, each wording is requested once and the measured string is the one
  // appended, so an impure function is simply never given a second chance.
  // Growing fast enough that a third call cannot be absorbed by the slack the
  // planner leaves. A gentler drift passed while the bug was present, which is
  // its own lesson: a regression test that cannot fail proves nothing.
  let calls = 0;
  const trailing = (lost) => `\n\n${lost ? "LOST" : "COMPLETE"} ${"pad".repeat(++calls * calls * 100)}`;
  const sections = {
    fromAgent: "codex",
    conversation: Array.from({ length: 8 }, (_, i) => ({ role: "assistant", text: `m${i} ` + "x".repeat(200) })),
    decisions: [],
    work: [],
    next: [],
  };

  for (const budget of [2048, 4096, 8192]) {
    const out = composeForRoad(sections, budget, trailing);
    assert.ok(Buffer.byteLength(out) <= budget, `budget ${budget} produced ${Buffer.byteLength(out)} bytes`);
  }
});

test("when everything genuinely fits, the trailing text still says so", () => {
  const sections = {
    fromAgent: "codex",
    conversation: [{ role: "assistant", text: "a short message" }],
    decisions: [],
    work: [],
    next: [],
  };
  const trailing = (lost) => (lost ? "\n\nLOST" : "\n\nCOMPLETE");
  const out = composeForRoad(sections, 64 * 1024, trailing);

  assert.ok(out.endsWith("COMPLETE"), "the honest case must not become a permanent warning");
  assert.ok(out.includes("a short message"));
});

// The skill's own handoff instructions were being carried as conversation: on one
// real delta they were 5587 of 7670 bytes, 73%, sent to the agent that already
// has them. Recognising them means matching words that live in another file, so
// these two tests hold that seam together instead of a comment asking someone to.

test("the sentence used to recognise the handoff skill is still in the handoff skill", () => {
  const skill = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin", "skills", "bridge", "SKILL.md"),
    "utf8"
  );
  assert.ok(
    skill.includes(SKILL_SENTINEL),
    "reword the skill and this filter stops working silently, which is how the noise came back last time"
  );
  assert.ok(
    isBridgeProtocolNoise(skill),
    "the filter must recognise the actual file, not a remembered version of it"
  );
});

test("a user talking about the bridge is not mistaken for the bridge talking", () => {
  // Filtering happens before anything is counted, so a message dropped here
  // leaves no trace at all: not in the delta, not in the omitted count, nowhere.
  // That makes a false positive worse than anything phase 1 and 2 were about.
  assert.equal(isBridgeProtocolNoise("$bridge codex"), true, "the invocation is protocol");
  assert.equal(isBridgeProtocolNoise("$bridge claude "), true);
  assert.equal(isBridgeProtocolNoise("$bridge is returning an empty delta again"), false);
  assert.equal(isBridgeProtocolNoise("$bridge komutu neden calismiyor?"), false);
  assert.equal(isBridgeProtocolNoise("why does $bridge drop my messages"), false);
});

// The rule this file exists to keep, made mechanical. Three separate clip
// constants were written by hand in two files, and the fourth was found only by
// grepping while measuring something else. A comment asking the next person to
// remember has now failed three times in this project.
test("no hand-written message clip survives anywhere in the conversation path", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const offenders = [];
  for (const file of ["delta.mjs", "handoff.mjs", "launcher.mjs", "delivery.mjs", "hooks.mjs"]) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
      if (/oneLine\s*\([^)]*,\s*\d+/.test(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`);
      if (/slice\(-\d+\)/.test(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`);
      if (/truncateMiddle\s*\(/.test(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "a message length must come from the road's budget, never from a literal");
});

function writeJsonl(file, records) {
  fs.writeFileSync(
    file,
    records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n") + "\n"
  );
}
