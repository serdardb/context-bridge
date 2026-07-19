import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneCheckpoints } from "../src/clean.mjs";
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
  const res = pruneCheckpoints(project, { dryRun: true });
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
