import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneCheckpoints, supersedePending } from "../src/clean.mjs";
import { AGENT_IDS } from "../src/agents/index.mjs";
import { defaultState, saveState, checkpointsDir } from "../src/state.mjs";

const DAY = 24 * 60 * 60 * 1000;

test("default prune deletes only groups that are BOTH old and beyond the newest 20", () => {
  const project = makeProject();
  // 25 groups: newest 5 are fresh, the remaining 20 are 30 days old.
  makeGroups(project, { count: 5, ageDays: 0, startIndex: 0 });
  makeGroups(project, { count: 20, ageDays: 30, startIndex: 5 });

  const res = pruneCheckpoints(project);
  // Newest 20 groups survive regardless of age; only the 5 oldest (old AND beyond 20) go.
  assert.equal(res.groups, 25);
  assert.equal(res.deletedGroups, 5);
  assert.equal(remainingGroups(project), 20);
});

test("old groups inside the newest N and fresh groups beyond N both survive (AND rule)", () => {
  const project = makeProject();
  makeGroups(project, { count: 10, ageDays: 30, startIndex: 0 });
  const res = pruneCheckpoints(project); // only 10 groups exist, all within newest 20
  assert.equal(res.deletedGroups, 0);

  const project2 = makeProject();
  makeGroups(project2, { count: 25, ageDays: 0, startIndex: 0 }); // beyond 20 but all fresh
  assert.equal(pruneCheckpoints(project2).deletedGroups, 0);
});

test("dry-run reports without deleting and both files of a group are counted", () => {
  const project = makeProject();
  makeGroups(project, { count: 22, ageDays: 30, startIndex: 0 });
  // keepCompanions off: this test is about group accounting, not the backstop.
  const res = pruneCheckpoints(project, { dryRun: true, keepCompanions: Infinity });
  assert.equal(res.deletedGroups, 2);
  assert.equal(res.deletedFiles, 4); // delta + full per group
  assert.equal(remainingGroups(project), 22);
});

test("a pending injection's group survives even --all", () => {
  const project = makeProject();
  const stems = makeGroups(project, { count: 3, ageDays: 30, startIndex: 0 });

  const s = defaultState(project);
  s.pendingInjection = {
    agent: "claude",
    sessionId: null,
    deltaFile: path.join(".bridge", "checkpoints", `${stems[0]}.md`),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  saveState(project, s);

  const res = pruneCheckpoints(project, { all: true });
  assert.equal(res.deletedGroups, 2);
  const left = fs.readdirSync(checkpointsDir(project)).filter((f) => f.endsWith(".md"));
  assert.deepEqual(left.sort(), [`${stems[0]}-full.md`, `${stems[0]}.md`].sort());
});

test("files not named by the bridge are never touched", () => {
  const project = makeProject();
  fs.writeFileSync(path.join(checkpointsDir(project), "notes.md"), "mine");
  const res = pruneCheckpoints(project, { all: true });
  assert.equal(res.deletedGroups, 0);
  assert.ok(fs.existsSync(path.join(checkpointsDir(project), "notes.md")));
});

function makeProject() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-clean-")));
  fs.mkdirSync(checkpointsDir(project), { recursive: true });
  return project;
}

/** Create `count` handoff groups (delta + full) with the given age; returns stems, newest first. */
function makeGroups(project, { count, ageDays, startIndex }) {
  const dir = checkpointsDir(project);
  const stems = [];
  for (let i = 0; i < count; i++) {
    const n = startIndex + i;
    const stem = `2026-01-01T00-00-${String(59 - n).padStart(2, "0")}-000Z-claude-to-codex`;
    const when = new Date(Date.now() - ageDays * DAY - n * 1000);
    for (const name of [`${stem}.md`, `${stem}-full.md`]) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, "checkpoint");
      fs.utimesSync(p, when, when);
    }
    stems.push(stem);
  }
  return stems;
}

function remainingGroups(project) {
  const seen = new Set();
  for (const f of fs.readdirSync(checkpointsDir(project))) {
    const m = f.match(/^(.+?-claude-to-codex)/);
    if (m) seen.add(m[1]);
  }
  return seen.size;
}

test("the companion backstop keeps only the newest few, whatever their age", () => {
  // Companions are ~92% of the bytes and are read at most once, by the session
  // that received them. Their real lifetime is an event, so this only catches
  // the case where that event never comes.
  const project = makeProject();
  makeGroups(project, { count: 8, ageDays: 0, startIndex: 0 });

  const dry = pruneCheckpoints(project, { dryRun: true, keepCompanions: 3 });
  assert.equal(dry.deletedGroups, 0, "fresh groups are not group-pruned");
  assert.equal(dry.deletedCompanions, 5, "8 companions, 3 kept");
  assert.equal(countFiles(project, "-full.md"), 8, "dry run deletes nothing");

  pruneCheckpoints(project, { keepCompanions: 3 });
  assert.equal(countFiles(project, "-full.md"), 3);
  assert.equal(countFiles(project, ".md") - countFiles(project, "-full.md"), 8, "bounded deltas are untouched");
});

test("supersedePending removes delta and full even if the disk is half-consumed", () => {
  // Healthy pending points at an unconsumed .md. A crashed consume can leave
  // .md.consumed while state still names the old path; supersede must not leave
  // the companion behind in either shape.
  const project = makeProject();
  const dir = checkpointsDir(project);
  const stem = "2026-07-20T00-00-00-000Z-claude-to-codex";
  fs.writeFileSync(path.join(dir, `${stem}.md.consumed`), "delta");
  fs.writeFileSync(path.join(dir, `${stem}-full.md`), "full");

  const res = supersedePending(project, {
    deltaFile: path.join(".bridge", "checkpoints", `${stem}.md`),
  });
  assert.equal(res.files, 2);
  assert.equal(fs.existsSync(path.join(dir, `${stem}.md.consumed`)), false);
  assert.equal(fs.existsSync(path.join(dir, `${stem}-full.md`)), false);
});

function countFiles(project, suffix) {
  return fs.readdirSync(checkpointsDir(project)).filter((f) => f.endsWith(suffix)).length;
}

test("every registered agent pair is prunable, including any added later", () => {
  // The bug this guards: the group pattern was written by hand for the original
  // pair, so Grok's checkpoints were invisible to pruning and simply piled up.
  // Iterating the registry means a fourth agent is covered the day it is added,
  // instead of the day someone notices its files never disappear.
  const project = makeProject();
  const dir = checkpointsDir(project);
  const pairs = [];
  for (const from of AGENT_IDS) {
    for (const to of AGENT_IDS) {
      if (from === to) continue;
      pairs.push(`${from}-to-${to}`);
    }
  }

  const old = new Date(Date.now() - 60 * DAY);
  pairs.forEach((pair, i) => {
    const stem = `2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z-${pair}`;
    for (const name of [`${stem}.md`, `${stem}-full.md`]) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, "checkpoint");
      fs.utimesSync(p, old, old);
    }
  });

  const res = pruneCheckpoints(project, { keep: 0, days: 0 });
  assert.equal(res.deletedGroups, pairs.length, `all ${pairs.length} directed pairs must be recognised`);
  assert.equal(fs.readdirSync(dir).length, 0, "nothing belonging to a registered agent survives");
});

// The same mistake made twice on different axes. The group pattern was
// generalised over AGENTS after Grok's checkpoints turned out to be invisible to
// pruning, but it still hard-coded the file KINDS. So when handoffs started
// writing an audit manifest beside each delta, the manifests matched nothing:
// their deltas were pruned and they stayed behind, orphaned, with no rule that
// would ever collect them. Measured on the repository before the fix: 24
// manifests, 472KB, and a prune with every limit at zero deleted 161 groups and
// not one of them.
test("an audit manifest is pruned with the handoff it belongs to", () => {
  const project = makeProject();
  const dir = checkpointsDir(project);
  const stem = "2026-01-01T00-00-00-000Z-claude-to-codex";
  const old = new Date(Date.now() - 60 * DAY);
  for (const name of [`${stem}.md`, `${stem}-full.md`, `${stem}-audit.json`]) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "x");
    fs.utimesSync(p, old, old);
  }

  const res = pruneCheckpoints(project, { keep: 0, days: 0 });
  assert.equal(res.deletedGroups, 1, "the three files are one handoff, not three");
  assert.deepEqual(fs.readdirSync(dir), [], "a manifest left behind is a leak with a schedule");
});

test("replacing an undelivered handoff clears its manifest too", () => {
  const project = makeProject();
  const dir = checkpointsDir(project);
  const stem = "2026-01-02T00-00-00-000Z-codex-to-grok";
  for (const name of [`${stem}.md`, `${stem}-full.md`, `${stem}-audit.json`]) {
    fs.writeFileSync(path.join(dir, name), "x");
  }

  supersedePending(project, { deltaFile: path.join(".bridge", "checkpoints", `${stem}.md`) });
  assert.deepEqual(fs.readdirSync(dir), [], "the superseded handoff leaves nothing of itself behind");
});

// Companions and manifests look alike on disk and are opposites in kind: one is
// a transient duplicate of a delta, the other is the only record of what was
// actually run and what `bridge inspect` reads.
test("handing off drops the companions written for you, and keeps the manifests", async () => {
  const { dropDeliveredCompanions } = await import("../src/clean.mjs");
  const project = makeProject();
  const dir = checkpointsDir(project);
  const stem = "2026-01-03T00-00-00-000Z-claude-to-codex";
  for (const name of [`${stem}.md.consumed`, `${stem}-full.md`, `${stem}-audit.json`]) {
    fs.writeFileSync(path.join(dir, name), "x");
  }

  const res = dropDeliveredCompanions(project, "codex");
  assert.equal(res.files, 1, "only the companion it has finished reading");
  const left = fs.readdirSync(dir).sort();
  assert.ok(left.includes(`${stem}-audit.json`), "the evidence outlives the session that produced it");
  assert.ok(!left.includes(`${stem}-full.md`));
});
