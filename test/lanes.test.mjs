import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  loadState,
  saveState,
  mutateState,
  laneOf,
  lanes,
  agentSlot,
  statePath,
  bridgeDir,
  checkpointsDir,
  writeCheckpoint,
  isValidLaneName,
  emptyLane,
  STATE_VERSION,
} from "../src/state.mjs";
import { pruneCheckpoints } from "../src/clean.mjs";

const STATE_MODULE = fileURLToPath(new URL("../src/state.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BRIDGE_BIN = path.join(ROOT, "bin", "bridge.mjs");

// Multi-lane isolation, pinned from the start rather than after a bug report.
//
// The whole point of a lane is that two lines of work in one directory do not see
// each other. The active-lane view routes every `s.agents`/`s.pendingInjection`
// read to the lane the caller is standing in, so these tests build a project that
// already has two lanes and prove a reader sees exactly one of them, that writing
// one leaves the other untouched, and that a caller can still reach a named lane
// on purpose. This project has twice shipped a rule generalised over one axis and
// not another; lanes are a third axis, and this is the fixture that makes a leak
// fail a test instead of a switch.

function twoLaneProject() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-2lane-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });

  const main = emptyLane();
  main.activeAgent = "claude";
  main.agents.claude = { id: "claude-main", transcriptPath: "/m/claude.jsonl", mark: "2026-01-01T00:00:00.000Z", idle: false };
  main.pendingInjection = { agent: "claude", id: "claude-main", via: "hook", deltaFile: ".bridge/checkpoints/m.md" };
  main.knownBy = { claude: { codex: "mark-main" } };
  main.git = { sha: "main-sha", recordedAt: "2026-01-01T00:00:00.000Z" };

  const feature = emptyLane();
  feature.activeAgent = "codex";
  feature.agents.codex = { id: "codex-feat", transcriptPath: "/f/codex.jsonl", mark: "2026-02-02T00:00:00.000Z", idle: true };
  feature.pendingHandoff = { target: "grok", ready: true };
  feature.knownBy = { codex: { grok: "mark-feat" } };
  feature.git = { sha: "feat-sha", recordedAt: "2026-02-02T00:00:00.000Z" };

  const s = {
    version: STATE_VERSION,
    project,
    activeLane: "main",
    lanes: { main, feature },
    launcher: null,
    updatedAt: null,
  };
  fs.writeFileSync(statePath(project), JSON.stringify(s, null, 2));
  return project;
}

test("a reader standing in one lane sees that lane's work and none of the other's", () => {
  const project = twoLaneProject();
  const s = loadState(project);

  assert.equal(s.activeAgent, "claude", "the active lane's active agent, not the other lane's");
  assert.equal(s.agents.claude.id, "claude-main");
  assert.equal(s.agents.codex.id, null, "codex is linked in the OTHER lane; here it must read empty");
  assert.equal(s.pendingInjection?.agent, "claude", "main's pending marker");
  assert.equal(s.pendingHandoff, null, "the pending handoff belongs to feature, and must not leak here");
  assert.equal(s.git.sha, "main-sha");
  assert.deepEqual(s.knownBy, { claude: { codex: "mark-main" } });
});

test("moving to the other lane flips the whole view, and only the view", () => {
  const project = twoLaneProject();
  const s = loadState(project);
  s.activeLane = "feature";

  assert.equal(s.activeAgent, "codex");
  assert.equal(s.agents.codex.id, "codex-feat");
  assert.equal(s.agents.claude.id, null, "claude is main's, not feature's");
  assert.equal(s.pendingHandoff?.target, "grok");
  assert.equal(s.pendingInjection, null, "the injection was main's");
  assert.equal(s.git.sha, "feat-sha");
});

test("a caller can reach a lane it is not standing in, by name", () => {
  const project = twoLaneProject();
  const s = loadState(project); // active is main

  assert.equal(laneOf(s).activeAgent, "claude", "no name means the active lane");
  assert.equal(laneOf(s, "feature").activeAgent, "codex", "and a name reaches the one asked for");
  assert.deepEqual(
    lanes(s).map(([name]) => name).sort(),
    ["feature", "main"],
    "every lane is enumerable"
  );
});

test("writing while standing in one lane leaves the other lane byte-for-byte intact", () => {
  const project = twoLaneProject();
  const before = laneOf(loadState(project), "feature");

  const s = loadState(project); // active is main
  s.agents.claude.id = "claude-main-2";
  s.pendingInjection = null;
  saveState(project, s);

  const reloaded = loadState(project);
  assert.equal(reloaded.agents.claude.id, "claude-main-2", "main's own change landed");
  assert.deepEqual(laneOf(reloaded, "feature"), before, "feature was not touched by a write aimed at main");
});

test("agentSlot mutates the active lane's slot and no other lane's", () => {
  const project = twoLaneProject();
  const s = loadState(project); // active is main

  agentSlot(s, "codex").set({ id: "codex-in-main" });
  assert.equal(laneOf(s, "main").agents.codex.id, "codex-in-main", "the write lands in main");
  assert.equal(laneOf(s, "feature").agents.codex.id, "codex-feat", "feature's codex is a different session and unchanged");
});

// The concurrency gate. Two launchers, two lanes, both saving.

test("two mutations of different lanes both land", () => {
  const project = twoLaneProject();
  mutateState(project, "main", (st) => (st.agents.claude.id = "claude-A"));
  mutateState(project, "feature", (st) => (st.agents.codex.id = "codex-B"));

  const reloaded = loadState(project);
  assert.equal(laneOf(reloaded, "main").agents.claude.id, "claude-A", "main's write landed");
  assert.equal(laneOf(reloaded, "feature").agents.codex.id, "codex-B", "feature's write landed");
});

test("two writers to the SAME lane, from stale snapshots, both keep their field", () => {
  // The round-4 blocker: two processes on one lane (a launcher and its hook) each
  // loaded the file, each changed a different field, and the second wholesale write
  // erased the first. mutateState re-reads inside the lock and applies the mutation
  // to the file as it is, so a change to `pendingHandoff` and a change to `idle`
  // both survive instead of the later write flattening the earlier.
  const project = twoLaneProject();
  // Process A sets a pending handoff on main. Process B, which loaded main before
  // A wrote, only touches idle. Neither may lose the other's field.
  mutateState(project, "main", (st) => (st.pendingHandoff = { target: "codex", ready: true }));
  mutateState(project, "main", (st) => (st.agents.claude.idle = true));

  const reloaded = loadState(project);
  assert.deepEqual(laneOf(reloaded, "main").pendingHandoff, { target: "codex", ready: true }, "A's pendingHandoff survived B's write");
  assert.equal(laneOf(reloaded, "main").agents.claude.idle, true, "and B's idle change is there too");
});

test("a hook writes the lane its launcher pinned, not the project's active lane", () => {
  // A launcher on the `feature` lane spawned this agent, so its hook must record
  // the session in `feature` even though `main` is the active lane project-wide.
  // Without the pinned lane the hook would follow the active-lane view and write
  // `main`, silently filing one lane's session under another.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hooklane-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(
    statePath(project),
    JSON.stringify(
      { version: STATE_VERSION, project, activeLane: "main", lanes: { main: emptyLane(), feature: emptyLane() }, launcher: null, updatedAt: null },
      null,
      2
    )
  );
  // Claude only links once the transcript file it names actually exists.
  const transcript = path.join(project, "claude-feat.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: "hi" } }) + "\n");

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start"], {
    input: JSON.stringify({ cwd: project, source: "startup", session_id: "claude-feat", transcript_path: transcript }),
    encoding: "utf8",
    env: { ...process.env, CONTEXT_BRIDGE_LANE: "feature" },
  });
  assert.equal(res.status, 0, res.stderr);

  const s = loadState(project);
  assert.equal(laneOf(s, "feature").agents.claude.id, "claude-feat", "the session landed in the pinned lane");
  assert.equal(laneOf(s, "main").agents.claude.id, null, "and the active lane was left untouched");
});

test("a malformed state file is refused, not silently recreated over", () => {
  // Missing and malformed both read back as null; treating them alike would wipe
  // every lane the instant a byte went bad. A present-but-unparseable file must be
  // refused so the corruption is loud and the lanes are recoverable.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-corrupt-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(statePath(project), "{ this is not, json ]");

  assert.throws(() => loadState(project), /could not be parsed/);
  assert.equal(fs.readFileSync(statePath(project), "utf8"), "{ this is not, json ]", "the bad file is left exactly as it was, not overwritten");
});

test("a lock left by a dead process is stolen at once, not waited out", () => {
  // A crashed writer leaves its lock behind. Stealing has to key on the owner
  // being gone, not on the clock: a fresh-looking lock from a dead pid must be
  // taken immediately, or every writer stalls until an arbitrary stale timeout.
  const project = twoLaneProject();
  const lock = statePath(project) + ".lock";
  fs.writeFileSync(lock, "999999 2026-08-03T00:00:00.000Z"); // a pid that is not alive, stamped now-ish

  const start = Date.now();
  mutateState(project, "main", (st) => (st.activeAgent = "codex"));
  assert.ok(Date.now() - start < 5000, "the dead lock was stolen promptly, not waited out");
  assert.equal(loadState(project).lanes.main.activeAgent, "codex", "and the write went through");
});

test("a write refuses a corrupt file instead of skeleton-wiping the lanes", () => {
  // The corrupt guard has to sit on the WRITE path too, not only the load path:
  // mutateState re-reads the file, and if it treated a malformed one as empty it
  // would apply its change onto a fresh skeleton and drop every other lane.
  const project = twoLaneProject();
  fs.writeFileSync(statePath(project), "{ half a file ]"); // corrupt on disk

  assert.throws(() => mutateState(project, "main", (st) => (st.activeAgent = "codex")), /could not be parsed/);
  assert.equal(fs.readFileSync(statePath(project), "utf8"), "{ half a file ]", "the corrupt file is left for recovery, not overwritten");
});

test("a hook files its session in the lane it is linked to, not a stale env lane", () => {
  // A session already linked to a lane belongs to that lane whatever the
  // environment says. Here Claude is linked in `main`, but the hook fires with
  // CONTEXT_BRIDGE_LANE=feature (stale or hand-set). Trusting the env over the live
  // link would file main's own session under feature.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hookstale-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  const main = emptyLane();
  const transcript = path.join(project, "claude-main.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00.000Z", message: { content: "hi" } }) + "\n");
  main.agents.claude = { id: "claude-main", transcriptPath: transcript, mark: null, idle: false };
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main, feature: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "internal-hook", "session-start"], {
    input: JSON.stringify({ cwd: project, source: "resume", session_id: "claude-main", transcript_path: transcript }),
    encoding: "utf8",
    env: { ...process.env, CONTEXT_BRIDGE_LANE: "feature" },
  });
  assert.equal(res.status, 0, res.stderr);

  const s = loadState(project);
  assert.equal(laneOf(s, "main").agents.claude.id, "claude-main", "the linked lane stays the session's home");
  assert.equal(laneOf(s, "feature").agents.claude.id, null, "the stale env did not drag the session into another lane");
});

test("main's checkpoints stay flat while a new lane's live under it", () => {
  // main is never moved, so the paths embedded in its old deltas stay true; a new
  // lane has no such history and starts clean in its own directory. Same filename
  // in two lanes must not collide.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ckpt-lane-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });

  const mainRel = writeCheckpoint(project, "main", "2026-01-01T00-00-00-000Z-claude-to-codex.md", "main body");
  const featRel = writeCheckpoint(project, "feature", "2026-01-01T00-00-00-000Z-claude-to-codex.md", "feature body");

  assert.equal(mainRel, path.join(".bridge", "checkpoints", "2026-01-01T00-00-00-000Z-claude-to-codex.md"), "main stays flat");
  assert.equal(featRel, path.join(".bridge", "lanes", "feature", "checkpoints", "2026-01-01T00-00-00-000Z-claude-to-codex.md"), "a new lane is under it");
  assert.equal(fs.readFileSync(path.join(project, mainRel), "utf8"), "main body");
  assert.equal(fs.readFileSync(path.join(project, featRel), "utf8"), "feature body", "the same name in two lanes does not collide");
});

test("retention keeps each lane's newest groups independently, not one shared window", () => {
  // A busy lane's churn must not push a quiet lane's only checkpoint out of the
  // keep window. If retention swept one flat pile, feature's group, being the
  // oldest overall, would be pruned; per lane it is the newest in its own.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-ret-lane-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main: emptyLane(), feature: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );

  const old = Date.now() / 1000 - 30 * 24 * 60 * 60; // 30 days ago, well past any cutoff
  const put = (lane, stem, ageOffset) => {
    const rel = writeCheckpoint(project, lane, `${stem}.md`, "x");
    fs.utimesSync(path.join(project, rel), old + ageOffset, old + ageOffset);
  };
  // main is the newer, busier lane; feature is quieter and older overall.
  put("main", "2026-03-01T00-00-00-000Z-claude-to-codex", 300);
  put("main", "2026-02-01T00-00-00-000Z-claude-to-codex", 200);
  put("main", "2026-01-01T00-00-00-000Z-claude-to-codex", 100);
  put("feature", "2025-12-02T00-00-00-000Z-claude-to-codex", 20);
  put("feature", "2025-12-01T00-00-00-000Z-claude-to-codex", 10);

  // keep the newest ONE per lane. Per lane: main -> 1, feature -> 1. If retention
  // ran on a single shared window this would keep only the newest of all five (a
  // main group) and prune both of feature's; if it never scanned feature, both of
  // feature's would survive uncollected. Exactly one proves per-lane retention.
  pruneCheckpoints(project, { keep: 1, days: 1 });

  const left = (lane) => fs.readdirSync(checkpointsDir(project, lane)).filter((f) => f.endsWith(".md")).length;
  assert.equal(left("feature"), 1, "feature kept its own newest and pruned its own older, on its own window");
  assert.equal(left("main"), 1, "main kept its newest and pruned the rest");
});

test("a lane name that could climb out of its directory is refused", () => {
  // A lane name becomes a path segment, so `..` or a slash would let a checkpoint
  // write escape the project. The name is validated wherever it reaches the disk.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lanename-")));
  for (const bad of ["..", ".", "../evil", "a/b", "a\\b", ".hidden", ""]) {
    assert.equal(isValidLaneName(bad), false, `${JSON.stringify(bad)} is not a safe lane name`);
    assert.throws(() => checkpointsDir(project, bad), /Invalid lane name/, `${JSON.stringify(bad)} must not build a path`);
  }
  assert.ok(isValidLaneName("feature") && isValidLaneName("fix-123_v2.1"));
  assert.doesNotThrow(() => checkpointsDir(project, "feature"));
  assert.doesNotThrow(() => checkpointsDir(project, "main"));
});

test("retention prunes a lane directory the state has forgotten", () => {
  // A lane removed from state, or a state too corrupt to read, leaves its
  // directory on disk. Discovering lanes from disk, not only from state, keeps an
  // orphaned lane's checkpoints from growing forever the way an uncollected kind
  // once did.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-orphan-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  // State knows only main; `feature` exists on disk but is not in state.
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );
  const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
  const rel = writeCheckpoint(project, "feature", "2025-01-01T00-00-00-000Z-claude-to-codex.md", "orphan");
  fs.utimesSync(path.join(project, rel), old, old);

  pruneCheckpoints(project, { keep: 0, days: 1 });

  assert.ok(!fs.existsSync(path.join(project, rel)), "the forgotten lane's old checkpoint was collected, not left to leak");
});

test("clean fails closed on a corrupt state and keeps a pending checkpoint", () => {
  // A review reproduced `clean --all` deleting the very delta a pending handoff was
  // waiting on, because a corrupt state could not name it to protect it. Missing
  // state is a fresh project with nothing to lose; corrupt state is not, so it must
  // refuse to delete rather than guess in the one direction that loses a handoff.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-failclosed-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  const rel = writeCheckpoint(project, "main", "2026-08-03T12-00-00-000Z-claude-to-codex.md", "the delta a switch is waiting on");
  fs.writeFileSync(statePath(project), "{ corrupt, not valid json"); // unreadable

  const res = pruneCheckpoints(project, { all: true });
  assert.equal(res.skippedCorruptState, true, "it says it refused because state was unreadable");
  assert.equal(res.deletedFiles, 0);
  assert.ok(fs.existsSync(path.join(project, rel)), "nothing was deleted, including the pending delta");
});

test("clean refuses the whole prune when a lane's checkpoints resolve outside the project", () => {
  // A review deleted a file outside the project when .bridge/lanes (or a lane's
  // checkpoints) was a symlink pointing away. Retention resolves each lane's real
  // path and refuses the ENTIRE prune if any escapes the project's own .bridge —
  // skipping just the bad lane would still drop the pending protection it carries
  // and let a safe lane be pruned. So the outside victim AND a prunable main group
  // must both survive, and the refusal must be reported.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-symlink-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-outside-")));
  const victim = path.join(outside, "2026-01-01T00-00-00-000Z-claude-to-codex.md");
  fs.writeFileSync(victim, "not the bridge's to delete");
  // A prunable group in flat main that a lane-skip (rather than a full refusal)
  // would happily delete.
  const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
  const mainRel = writeCheckpoint(project, "main", "2026-01-02T00-00-00-000Z-claude-to-codex.md", "safe lane, must survive the refusal");
  fs.utimesSync(path.join(project, mainRel), old, old);
  // A lane the state knows, whose checkpoints directory is a symlink to `outside`.
  fs.mkdirSync(path.join(bridgeDir(project), "lanes", "feature"), { recursive: true });
  fs.symlinkSync(outside, path.join(bridgeDir(project), "lanes", "feature", "checkpoints"));
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main: emptyLane(), feature: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );

  const res = pruneCheckpoints(project, { all: true });
  assert.equal(res.skippedEscapingBridge, true, "it reports the refusal instead of silently skipping the lane");
  assert.equal(res.deletedGroups, 0, "no lane is pruned when one escapes");
  assert.ok(fs.existsSync(victim), "a symlinked lane must not let clean reach outside the project");
  assert.ok(fs.existsSync(path.join(project, mainRel)), "the safe main group survives the refusal");
});

test("clean fails closed when there is no state file but checkpoints exist", () => {
  // A checkpoint with no state to name it could be a handoff whose state was lost;
  // deleting it takes the recovery with it. Missing state is safe only when empty.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-nostate-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  const rel = writeCheckpoint(project, "main", "2026-08-03T12-00-00-000Z-claude-to-codex.md", "maybe a lost handoff");
  // no state.json is written

  const res = pruneCheckpoints(project, { all: true });
  assert.equal(res.skippedNoState, true, "it says it refused because there is no state to check against");
  assert.ok(fs.existsSync(path.join(project, rel)), "the checkpoint was not deleted");
});

test("many processes hammering their own lanes at once lose no lane's write", async () => {
  // The real thing the lock exists for: separate OS processes writing the same
  // file. Each child pins one lane and rewrites it in a loop; if the lock or the
  // lane-scoped splice were wrong, a child would read another mid-write and a
  // lane would end on the wrong value or vanish.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lane-race-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  const names = ["main", "alpha", "beta", "gamma"];
  const lanesObj = {};
  for (const n of names) lanesObj[n] = emptyLane();
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: lanesObj, launcher: null, updatedAt: null }, null, 2)
  );

  const child = (lane) =>
    new Promise((resolve) => {
      const code = `
        import("${STATE_MODULE}").then(async ({ mutateState }) => {
          const project = ${JSON.stringify(project)}, lane = ${JSON.stringify(lane)};
          for (let i = 0; i < 25; i++) {
            mutateState(project, lane, (st) => { st.activeAgent = lane + "-" + i; });
          }
        });
      `;
      spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore" }).on("exit", resolve);
    });

  await Promise.all(names.map(child));

  const final = loadState(project);
  for (const n of names) {
    assert.equal(laneOf(final, n).activeAgent, `${n}-24`, `${n} ended on its own last write, not lost or overwritten by a neighbour`);
  }
});

test("writeCheckpoint refuses to write through a symlinked lane checkpoints directory", () => {
  // The read/rename gate has a symmetric twin on the write side. A lane whose
  // checkpoints directory is a symlink out would otherwise let a handoff create the
  // delta, full and manifest files outside the project. Every existing path
  // component from .bridge down must be a real directory. Reintroduce the raw
  // checkpointsDir in writeCheckpoint and the file lands in the external directory.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-write-")));
  fs.mkdirSync(path.join(project, ".bridge", "lanes", "feature"), { recursive: true });
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-outside-")));
  fs.symlinkSync(outside, path.join(project, ".bridge", "lanes", "feature", "checkpoints"));

  assert.throws(
    () => writeCheckpoint(project, "feature", "2026-01-01T00-00-00-000Z-claude-to-codex.md", "escaped"),
    /symlinked path component/,
    "a symlinked lane checkpoints dir must be refused"
  );
  assert.equal(fs.readdirSync(outside).length, 0, "nothing was written into the external directory");

  fs.rmSync(project, { recursive: true });
  fs.rmSync(outside, { recursive: true });
});

// Phase 5: lane management. The state layer first, pure and lock-safe.

test("createLane adds an empty lane and refuses a duplicate or a bad name", async () => {
  const { createLane, emptyLane: mk } = await import("../src/state.mjs");
  const disk = { version: STATE_VERSION, project: "/p", activeLane: "main", lanes: { main: mk() }, launcher: null, updatedAt: null };

  createLane(disk, "feature");
  assert.deepEqual(disk.lanes.feature, mk(), "a new lane starts empty, inheriting nothing");
  assert.throws(() => createLane(disk, "feature"), /already exists/, "a duplicate name is refused");
  assert.throws(() => createLane(disk, "../evil"), /Invalid lane name/, "a traversing name never becomes a directory");
});

test("switchActiveLane moves the pointer only to an existing lane", async () => {
  const { switchActiveLane, emptyLane: mk } = await import("../src/state.mjs");
  const disk = { version: STATE_VERSION, project: "/p", activeLane: "main", lanes: { main: mk(), feature: mk() }, launcher: null, updatedAt: null };

  switchActiveLane(disk, "feature");
  assert.equal(disk.activeLane, "feature");
  assert.throws(() => switchActiveLane(disk, "ghost"), /No lane named/, "you cannot switch to a lane that is not there");
});

test("removeLaneFromState refuses main and the active lane, removes any other", async () => {
  const { removeLaneFromState, emptyLane: mk } = await import("../src/state.mjs");
  const disk = { version: STATE_VERSION, project: "/p", activeLane: "feature", lanes: { main: mk(), feature: mk(), api: mk() }, launcher: null, updatedAt: null };

  assert.throws(() => removeLaneFromState(disk, "main"), /cannot be removed/, "a project always keeps a main lane");
  assert.throws(() => removeLaneFromState(disk, "feature"), /is active/, "the active lane cannot be pulled from under the pointer");
  removeLaneFromState(disk, "api");
  assert.equal(disk.lanes.api, undefined, "an idle, non-default lane is removed");
});

test("mutateProject persists a lane creation and an activeLane move, unlike mutateState", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-laneproj-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );

  return import("../src/state.mjs").then(({ mutateProject, createLane, switchActiveLane }) => {
    mutateProject(project, (disk) => {
      createLane(disk, "feature");
      switchActiveLane(disk, "feature");
    });
    const reloaded = JSON.parse(fs.readFileSync(statePath(project), "utf8"));
    assert.ok(reloaded.lanes.feature, "the new lane was written");
    assert.equal(reloaded.activeLane, "feature", "mutateProject does NOT restore activeLane the way a lane-scoped mutate does");
    fs.rmSync(project, { recursive: true });
  });
});

test("laneSummaries marks the active lane, lists linked agents, and orders by recency", async () => {
  const { laneSummaries } = await import("../src/state.mjs");
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lanesum-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });

  const main = emptyLane();
  main.agents.claude = { id: "claude-1", transcriptPath: "/m/c.jsonl", mark: null, idle: false };
  const feature = emptyLane();
  const s = { version: STATE_VERSION, project, activeLane: "feature", lanes: { main, feature }, launcher: null, updatedAt: null };
  fs.writeFileSync(statePath(project), JSON.stringify(s, null, 2));

  // main has an older checkpoint; feature a newer one -> feature is more recent.
  const older = writeCheckpoint(project, "main", "2026-01-01T00-00-00-000Z-claude-to-codex.md", "x");
  const newer = writeCheckpoint(project, "feature", "2026-02-02T00-00-00-000Z-codex-to-claude.md", "x");
  fs.utimesSync(path.join(project, older), new Date("2026-01-01"), new Date("2026-01-01"));
  fs.utimesSync(path.join(project, newer), new Date("2026-02-02"), new Date("2026-02-02"));

  const summaries = laneSummaries(project, s);
  assert.deepEqual(summaries.map((l) => l.name), ["feature", "main"], "newest activity first");
  assert.equal(summaries.find((l) => l.name === "feature").active, true, "the active lane is marked");
  assert.deepEqual(summaries.find((l) => l.name === "main").agents, ["claude"], "linked agents are listed");

  fs.rmSync(project, { recursive: true });
});

test("bridge lane rm deletes the lane directory only after --yes, and never main", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lanerm-")));
  const run = (...a) => spawnSync(process.execPath, [BRIDGE_BIN, "lane", ...a], { cwd: project, encoding: "utf8" });

  run("new", "feature");
  const laneDir = path.join(project, ".bridge", "lanes", "feature", "checkpoints");
  fs.mkdirSync(laneDir, { recursive: true });
  fs.writeFileSync(path.join(laneDir, "2026-01-01T00-00-00-000Z-claude-to-codex.md"), "x");
  run("switch", "main"); // cannot remove the active lane

  const refused = run("rm", "feature"); // no --yes
  assert.equal(refused.status, 1, "rm without --yes refuses");
  assert.ok(fs.existsSync(laneDir), "and deletes nothing");

  const removed = run("rm", "feature", "--yes");
  assert.equal(removed.status, 0);
  assert.equal(fs.existsSync(path.join(project, ".bridge", "lanes", "feature")), false, "the whole lane directory is gone");

  const main = run("rm", "main", "--yes");
  assert.equal(main.status, 1, "main is never removable");

  fs.rmSync(project, { recursive: true });
});

test("bridge lane rm refuses while a launcher is alive, so a live session cannot resurrect it", () => {
  // Codex's blocker: mutateState recreates a missing target lane (it must, to
  // bootstrap the first one), so a launcher pinned to a removed lane writes it back
  // empty on its next hook. Until a per-lane launcher record exists, rm refuses
  // whenever any launcher is alive. This process is alive, so it stands in for one.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-rmlive-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(
    statePath(project),
    JSON.stringify(
      {
        version: STATE_VERSION,
        project,
        activeLane: "main",
        lanes: { main: emptyLane(), feature: emptyLane() },
        launcher: { pid: process.pid, recordedAt: "2026-01-01T00:00:00.000Z", stateVersion: STATE_VERSION },
        updatedAt: null,
      },
      null,
      2
    )
  );

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "lane", "rm", "feature", "--yes"], { cwd: project, encoding: "utf8" });
  assert.equal(res.status, 1, "rm is refused while a launcher is alive");
  assert.match(res.stdout, /launcher is running on lane/i);
  assert.ok(loadState(project).lanes.feature, "the lane is still there, not half-removed");

  fs.rmSync(project, { recursive: true });
});

test("a stale mutateState after lane rm does not resurrect the lane, but a fresh project still bootstraps", async () => {
  // Codex's deeper blocker: the any-live-launcher guard could not close resurrection,
  // because a hook calls mutateState(project, pinnedLane, ...) directly and a delayed
  // one can fire after rm. The real fix is in mutateState: it refuses to recreate a
  // lane that an EXISTING project no longer has. Remove that rule and `feature`
  // reappears here. The one legitimate auto-create, a brand-new project's first lane,
  // still works because there is no state file at all in that case.
  const { mutateProject, removeLaneFromState } = await import("../src/state.mjs");
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-resurrect-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main: emptyLane(), feature: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );

  mutateProject(project, (disk) => removeLaneFromState(disk, "feature"));
  assert.equal(loadState(project).lanes.feature, undefined, "feature was removed");

  // A delayed hook / still-pinned launcher writes to the removed lane.
  mutateState(project, "feature", (st) => (st.agents.claude.id = "ghost"));
  assert.equal(loadState(project).lanes.feature, undefined, "the removed lane was not resurrected by a stale write");

  // Bootstrap still works: a project with no state file at all gets its first lane.
  const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-bootstrap-")));
  fs.mkdirSync(bridgeDir(fresh), { recursive: true });
  mutateState(fresh, "main", (st) => (st.activeAgent = "claude"));
  assert.equal(loadState(fresh)?.lanes?.main?.activeAgent, "claude", "a brand-new project's first lane is still created");

  fs.rmSync(project, { recursive: true });
  fs.rmSync(fresh, { recursive: true });
});

// Phase 6: bridge unlink. The point is BOTH directions of the watermark matrix.

test("unlinkAgent clears the slot and every watermark that names the agent, both directions", async () => {
  const { unlinkAgent } = await import("../src/state.mjs");
  const lane = emptyLane();
  lane.activeAgent = "codex";
  lane.agents.claude = { id: "c1", transcriptPath: "/c", mark: "mc", idle: false };
  lane.agents.codex = { id: "x1", transcriptPath: "/x", mark: "mx", idle: false };
  lane.knownBy = { claude: { codex: "a", grok: "b" }, codex: { claude: "c" } };
  lane.pendingHandoff = { target: "codex", ready: true };

  const changed = unlinkAgent(lane, "codex");
  assert.equal(changed, true);
  assert.equal(lane.agents.codex.id, null, "codex's session is forgotten");
  assert.equal(lane.agents.codex.mark ?? null, null, "and so is its watermark");
  // The whole reason unlink is not just 'clear the slot': a leftover mark points at
  // a session that no longer exists, and the next handoff sends nothing 'since' it.
  assert.equal(lane.knownBy.codex, undefined, "codex as a TARGET is cleared");
  assert.equal("codex" in lane.knownBy.claude, false, "codex as a SOURCE is cleared from claude");
  assert.equal(lane.knownBy.claude.grok, "b", "an unrelated watermark survives");
  assert.equal(lane.agents.claude.id, "c1", "another agent's link is untouched");
  assert.equal(lane.pendingHandoff, null, "a pending handoff naming codex is dropped, not left dangling");
  assert.equal(lane.activeAgent, null, "codex was active; the pointer is cleared");
  assert.equal(unlinkAgent(lane, "codex"), false, "unlinking an already-unlinked agent changes nothing");
});

test("bridge unlink clears one agent in the active lane and reports it", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-unlink-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  const main = emptyLane();
  main.activeAgent = "claude";
  main.agents.claude = { id: "c1", transcriptPath: "/c", mark: "mc", idle: false };
  main.agents.codex = { id: "x1", transcriptPath: "/x", mark: "mx", idle: false };
  main.knownBy = { claude: { codex: "a" }, codex: { claude: "b" } };
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main }, launcher: null, updatedAt: null }, null, 2)
  );

  const bogus = spawnSync(process.execPath, [BRIDGE_BIN, "unlink", "nope"], { cwd: project, encoding: "utf8" });
  assert.equal(bogus.status, 1, "an unknown agent is a usage error");

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "unlink", "codex"], { cwd: project, encoding: "utf8" });
  assert.equal(res.status, 0);
  const after = loadState(project);
  assert.equal(after.agents.codex.id, null, "codex is unlinked");
  assert.equal(after.agents.claude.id, "c1", "claude is left linked");
  assert.equal(after.knownBy.codex, undefined, "codex's target row is gone");
  assert.equal("codex" in (after.knownBy.claude ?? {}), false, "and its source column too");

  fs.rmSync(project, { recursive: true });
});

test("unlinkAgent forgets a slot carrying only hook or pending metadata, not just a session id", async () => {
  const { unlinkAgent, emptyAgent } = await import("../src/state.mjs");
  const lane = emptyLane();
  // Codex stamps hookSeen the moment its hook fires, before any valid session link.
  // Such a slot has no id/transcriptPath/mark, yet it still keeps the agent
  // hook-eligible, so unlink must forget it and count it as a change.
  lane.agents.codex = { id: null, transcriptPath: null, mark: null, idle: false, hookSeen: "2026-01-01T00:00:00.000Z" };

  const changed = unlinkAgent(lane, "codex");
  assert.equal(changed, true, "a slot with only hookSeen is still linked enough to forget");
  assert.equal("hookSeen" in lane.agents.codex, false, "the whole slot is reset, so hookSeen is dropped");
  assert.deepEqual(lane.agents.codex, emptyAgent(), "reset to a clean empty slot");
  assert.equal(unlinkAgent(lane, "codex"), false, "unlinking it again changes nothing");
});

test("bridge unlink refuses while a launcher is alive, so a live session cannot relink after", () => {
  // Codex's concurrency finding: unlink clears the slot, but an in-flight handoff's
  // stale snapshot, or a delayed hook, could re-link the old session. Both need a
  // live session; refuse while a launcher is alive (same guard as lane rm). This
  // process stands in for the launcher.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-unlinklive-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  const main = emptyLane();
  main.agents.codex = { id: "x1", transcriptPath: "/x", mark: "mx", idle: false };
  fs.writeFileSync(
    statePath(project),
    JSON.stringify(
      { version: STATE_VERSION, project, activeLane: "main", lanes: { main }, launcher: { pid: process.pid, recordedAt: "2026-01-01T00:00:00.000Z", stateVersion: STATE_VERSION }, updatedAt: null },
      null,
      2
    )
  );

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "unlink", "codex"], { cwd: project, encoding: "utf8" });
  assert.equal(res.status, 1, "unlink is refused while a launcher is alive");
  assert.match(res.stdout, /launcher is running on lane/i);
  assert.equal(loadState(project).agents.codex.id, "x1", "codex is still linked, not half-unlinked");

  fs.rmSync(project, { recursive: true });
});

// Phase 5.2: the launcher record is per lane, so lane rm / unlink no longer refuse
// on ANY live launcher, only one on the lane they touch.

test("lane rm frees a lane no launcher holds while still protecting the one a live launcher drives", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-rmperlane-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(
    statePath(project),
    JSON.stringify(
      {
        version: STATE_VERSION,
        project,
        activeLane: "main",
        lanes: { main: emptyLane(), feature: emptyLane(), other: emptyLane() },
        launchers: { [String(process.pid)]: { pid: process.pid, lane: "other", recordedAt: "2026-01-01T00:00:00.000Z", stateVersion: STATE_VERSION } },
        updatedAt: null,
      },
      null,
      2
    )
  );
  const run = (...a) => spawnSync(process.execPath, [BRIDGE_BIN, "lane", ...a], { cwd: project, encoding: "utf8" });

  // feature has no launcher -> removable even though a launcher is live on `other`.
  const rmFeature = run("rm", "feature", "--yes");
  assert.equal(rmFeature.status, 0, "a lane no launcher holds is removable while another lane's launcher runs");
  assert.equal(loadState(project).lanes.feature, undefined, "feature is gone");

  // `other` has the live launcher -> still refused.
  const rmOther = run("rm", "other", "--yes");
  assert.equal(rmOther.status, 1, "the lane a live launcher drives is still protected");
  assert.ok(loadState(project).lanes.other, "and not removed");

  fs.rmSync(project, { recursive: true });
});

test("recordLauncher tracks the lane per pid, prunes dead launchers, supersedes the legacy field", async () => {
  const { recordLauncher, liveLaunchers, laneHasLiveLauncher } = await import("../src/state.mjs");
  // A DEAD legacy launcher (pid 1 is init and actually alive, so use an unassigned
  // high pid) plus a dead entry already in the map. Both must be forgotten.
  const disk = { version: STATE_VERSION, project: "/p", activeLane: "main", lanes: { main: emptyLane() }, launcher: { pid: 999999998, recordedAt: "x" }, launchers: { "999999999": { pid: 999999999, lane: "gone", recordedAt: "x", stateVersion: STATE_VERSION } }, updatedAt: null };

  recordLauncher(disk, process.pid, "main");
  assert.equal(disk.launchers["999999999"], undefined, "the dead launcher pid was pruned");
  assert.equal(disk.launchers["999999998"], undefined, "the dead legacy launcher is forgotten, not migrated");
  assert.equal(disk.launchers[String(process.pid)].lane, "main", "this launcher is recorded against its lane");
  assert.equal(disk.launcher, undefined, "the legacy single-record field is superseded");
  assert.deepEqual(liveLaunchers(disk), [{ pid: process.pid, lane: "main" }]);
  assert.equal(laneHasLiveLauncher(disk, "main"), true, "the lane it drives is held");
  assert.equal(laneHasLiveLauncher(disk, "other"), false, "another lane is not");
  assert.equal(laneHasLiveLauncher(disk, "main", process.pid), false, "excluding this pid clears it");
});

test("liveLaunchers folds in a legacy single launcher record as unknown-lane, blocking every lane", async () => {
  const { liveLaunchers, laneHasLiveLauncher } = await import("../src/state.mjs");
  const s = { launcher: { pid: process.pid, recordedAt: "x" } }; // a pre-per-lane state mid-upgrade

  assert.deepEqual(liveLaunchers(s), [{ pid: process.pid, lane: null }]);
  assert.equal(laneHasLiveLauncher(s, "anything"), true, "an unknown-lane launcher conservatively holds every lane");
});

test("recordLauncher preserves a still-live legacy launcher so every lane stays guarded through the upgrade", async () => {
  const { recordLauncher, liveLaunchers, laneHasLiveLauncher } = await import("../src/state.mjs");
  // A v5 project upgraded from before per-lane tracking: one legacy launcher record,
  // and its process (this test) is still alive. No launchers map yet.
  const disk = { version: STATE_VERSION, project: "/p", activeLane: "main", lanes: { main: emptyLane(), feature: emptyLane() }, launcher: { pid: process.pid, recordedAt: "x", stateVersion: STATE_VERSION }, updatedAt: null };

  // A brand-new per-lane launcher (a different, not-alive pid) starts on main.
  recordLauncher(disk, 999001, "main");

  assert.equal(disk.launcher, undefined, "the legacy field is retired");
  assert.equal(disk.launchers[String(process.pid)].lane, null, "the still-live legacy launcher is kept as unknown-lane, not dropped");
  assert.ok(liveLaunchers(disk).some((l) => l.pid === process.pid && l.lane === null), "it is still counted alive");
  // Because the legacy launcher's lane is unknown, it must keep guarding EVERY lane,
  // including one the new launcher is not on. Dropping it here reopened rm/unlink.
  assert.equal(laneHasLiveLauncher(disk, "feature"), true, "feature is still guarded by the live legacy launcher");
  assert.equal(laneHasLiveLauncher(disk, "main"), true, "and so is main");
});

// Phase 5.2: --resume selects a lane. The parsing and resolution are pure and
// tested here; the interactive picker itself is exercised by hand.

test("extractResume pulls --resume and its lane out of forwarded args in every form", async () => {
  const { extractResume } = await import("../src/cli.mjs");
  assert.deepEqual(extractResume(["--model", "x"]), { resume: undefined, rest: ["--model", "x"] });
  assert.deepEqual(extractResume(["--resume"]), { resume: true, rest: [] });
  assert.deepEqual(extractResume(["--resume", "auth"]), { resume: "auth", rest: [] });
  assert.deepEqual(extractResume(["--resume=auth"]), { resume: "auth", rest: [] });
  // a flag right after --resume means the bare picker form, and the flag survives
  assert.deepEqual(extractResume(["--resume", "--model", "x"]), { resume: true, rest: ["--model", "x"] });
  // surrounding agent args are preserved in order
  assert.deepEqual(extractResume(["--model", "x", "--resume", "auth", "-v"]), { resume: "auth", rest: ["--model", "x", "-v"] });
});

test("resolveResumeLane requires an existing lane, falls back, or asks to pick", async () => {
  const { resolveResumeLane } = await import("../src/cli.mjs");
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-resume-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main: emptyLane(), feature: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );

  assert.deepEqual(resolveResumeLane(project, undefined), { lane: null }, "no --resume resumes the last lane");
  assert.deepEqual(resolveResumeLane(project, "feature"), { lane: "feature" }, "a named, existing lane opens directly");
  assert.equal(resolveResumeLane(project, "ghost").error !== undefined, true, "a lane that does not exist is refused, not created");
  assert.equal(resolveResumeLane(project, "../evil").error !== undefined, true, "an invalid lane name is refused");
  assert.deepEqual(resolveResumeLane(project, true), { pick: true }, "the bare form asks to pick when there is more than one lane");

  // single-lane project: nothing to choose, so the bare form just opens it
  const solo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-resume1-")));
  fs.mkdirSync(bridgeDir(solo), { recursive: true });
  fs.writeFileSync(
    statePath(solo),
    JSON.stringify({ version: STATE_VERSION, project: solo, activeLane: "main", lanes: { main: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );
  assert.deepEqual(resolveResumeLane(solo, true), { lane: null }, "the bare form does not prompt when there is only one lane");

  fs.rmSync(project, { recursive: true });
  fs.rmSync(solo, { recursive: true });
});

test("bridge <agent> --resume <missing> refuses before launching anything", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-resumecli-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "claude", "--resume", "ghost"], { cwd: project, encoding: "utf8" });
  assert.equal(res.status, 1, "an unknown lane is an error, and the agent never starts");
  assert.match(res.stdout, /No lane named 'ghost'/);

  fs.rmSync(project, { recursive: true });
});

test("extractResume refuses a duplicate or empty --resume instead of leaking it to the agent", async () => {
  const { extractResume } = await import("../src/cli.mjs");
  // Two --resume: without this, feature is chosen and `--resume other` is left in
  // rest, reaching an agent (Codex/OpenCode) that does not drop it.
  assert.ok(extractResume(["--resume", "feature", "--resume", "other"]).error, "two --resume is refused");
  assert.ok(extractResume(["--resume=a", "--resume=b"]).error, "two --resume= is refused");
  assert.ok(extractResume(["--resume", "a", "--resume=b"]).error, "a mixed pair is refused");
  // A second --resume never survives into rest.
  const dup = extractResume(["--resume", "feature", "--resume", "other", "--model", "x"]);
  assert.ok(dup.error);
  assert.equal(dup.rest, undefined, "no forwarded args are handed back when the input is refused");
  // Empty --resume= is ambiguous, refused rather than silently treated as a picker.
  assert.ok(extractResume(["--resume="]).error, "an empty --resume= is refused");
});

test("parseChoice takes only a whole number in range, not 1abc or out-of-range", async () => {
  const { parseChoice } = await import("../src/cli.mjs");
  assert.equal(parseChoice("1abc", 3), null, "a trailing non-digit is rejected, not read as 1");
  assert.equal(parseChoice("2", 3), 2);
  assert.equal(parseChoice("0", 3), 0, "0 is the New lane slot");
  assert.equal(parseChoice("  2 ", 3), 2, "surrounding space is fine");
  assert.equal(parseChoice("4", 3), null, "out of range is rejected");
  assert.equal(parseChoice("-1", 3), null, "a sign is not a digit run");
  assert.equal(parseChoice("", 3), null);
});

test("unlinkAgent tombstones the forgotten session, and a re-unlink preserves the tombstone", async () => {
  const { unlinkAgent } = await import("../src/state.mjs");
  const lane = emptyLane();
  lane.agents.codex = { id: "sess-1", transcriptPath: "/t", mark: "m", idle: false };

  assert.equal(unlinkAgent(lane, "codex"), true, "the first unlink forgets the session");
  assert.equal(lane.agents.codex.id, null, "the session is forgotten");
  assert.deepEqual(lane.agents.codex.rejectedSessions, ["sess-1"], "and its id is tombstoned so a stale hook cannot relink it");

  // The tombstone set is not 'content' to forget, so re-unlinking is still a no-op AND
  // keeps the set (a re-unlink must not reopen the relink window).
  assert.equal(unlinkAgent(lane, "codex"), false, "re-unlinking an already-forgotten agent changes nothing");
  assert.deepEqual(lane.agents.codex.rejectedSessions, ["sess-1"], "the tombstone survives the re-unlink");
});

test("unlinkAgent ACCUMULATES tombstones so an earlier session is never forgotten (the single-tombstone bug)", async () => {
  const { unlinkAgent, agentSlot } = await import("../src/state.mjs");
  const lane = emptyLane();
  // Session A links, then is unlinked.
  lane.agents.codex = { id: "A", transcriptPath: "/a", mark: null, idle: false };
  unlinkAgent(lane, "codex");
  assert.deepEqual(lane.agents.codex.rejectedSessions, ["A"], "A is rejected");

  // A DIFFERENT session B links (a deliberate link retires only B, which was not there),
  // then B is unlinked too.
  agentSlot(lane, "codex").set({ id: "B", transcriptPath: "/b" });
  unlinkAgent(lane, "codex");

  // BOTH A and B must stay rejected. A single scalar tombstone remembered only B here,
  // so A's delayed hook could relink; the set keeps them both.
  assert.ok(lane.agents.codex.rejectedSessions.includes("A"), "A is STILL rejected after B was unlinked");
  assert.ok(lane.agents.codex.rejectedSessions.includes("B"), "and so is B");
});

test("a deliberate link (adopt) of the same unlinked id retires just that one tombstone", async () => {
  const { unlinkAgent, agentSlot } = await import("../src/state.mjs");
  const lane = emptyLane();
  lane.agents.codex = { id: "old", transcriptPath: "/t", mark: "m", idle: false };
  unlinkAgent(lane, "codex");
  // Also reject a second, unrelated session so we can prove only 'old' is retired.
  lane.agents.codex.rejectedSessions = ["old", "other"];

  // The user deliberately re-adopts the SAME id. agentSlot.set retires that ONE
  // session's tombstone so its hooks are not blocked forever, but leaves the rest.
  agentSlot(lane, "codex").set({ id: "old", transcriptPath: "/t" });
  assert.equal(lane.agents.codex.id, "old", "the session is linked again");
  assert.ok(!lane.agents.codex.rejectedSessions?.includes("old"), "old is no longer rejected");
  assert.ok(lane.agents.codex.rejectedSessions?.includes("other"), "but an unrelated rejected session stays rejected");
});

test("bridge clean --lane and inspect --lane target one lane and reject an unknown one", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lanescope-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main: emptyLane(), feature: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );
  // An old, prunable group in feature only.
  const fdir = path.join(project, ".bridge", "lanes", "feature", "checkpoints");
  fs.mkdirSync(fdir, { recursive: true });
  const ff = path.join(fdir, "2026-01-01T00-00-00-000Z-claude-to-codex.md");
  fs.writeFileSync(ff, "x");
  const old = Date.now() / 1000 - 30 * 24 * 60 * 60;
  fs.utimesSync(ff, old, old);

  const run = (...a) => spawnSync(process.execPath, [BRIDGE_BIN, ...a], { cwd: project, encoding: "utf8" });

  assert.equal(run("clean", "--lane", "ghost", "--all").status, 1, "clean rejects an unknown lane");
  assert.equal(run("inspect", "--lane", "ghost").status, 1, "inspect rejects an unknown lane");
  assert.ok(fs.existsSync(ff), "a rejected clean deletes nothing");

  const ok = run("clean", "--lane", "feature", "--all");
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /in lane feature/, "the report names the scoped lane");
  assert.equal(fs.existsSync(ff), false, "feature's group is pruned");

  fs.rmSync(project, { recursive: true });
});

test("clean --lane and inspect --lane fail closed on corrupt state instead of crashing", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-corruptlane-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(statePath(project), "{ this is not, valid json"); // corrupt, not missing
  const run = (...a) => spawnSync(process.execPath, [BRIDGE_BIN, ...a], { cwd: project, encoding: "utf8" });

  const cleaned = run("clean", "--lane", "feature", "--all");
  assert.equal(cleaned.status, 1, "clean --lane exits 1 on corrupt state");
  assert.match(cleaned.stdout, /could not be read/i, "it prints the fail-closed report, not a stack trace or 'unknown lane'");
  assert.doesNotMatch(cleaned.stdout, /No lane named/, "corrupt state is not mislabelled as an unknown lane");

  const inspected = run("inspect", "--lane", "feature");
  assert.equal(inspected.status, 1, "inspect --lane exits 1 on corrupt state");
  assert.match(inspected.stdout, /could not be read/i, "inspect reports corrupt state clearly, not 'unknown lane'");

  fs.rmSync(project, { recursive: true });
});

test("a legacy scalar 'unlinked' tombstone is migrated into the rejectedSessions set", async () => {
  const { unlinkAgent } = await import("../src/state.mjs");
  const lane = emptyLane();
  // A state written by the briefly-shipped scalar version.
  lane.agents.codex = { id: "live", transcriptPath: "/t", mark: null, idle: false, unlinked: "old-scalar" };

  unlinkAgent(lane, "codex");

  assert.ok(lane.agents.codex.rejectedSessions.includes("old-scalar"), "the legacy scalar tombstone survives as a set entry");
  assert.ok(lane.agents.codex.rejectedSessions.includes("live"), "and the just-unlinked id is added, not overwriting it");
  assert.equal(lane.agents.codex.unlinked ?? null, null, "the scalar field is dropped after migration");
});

test("re-adopting an id that a LEGACY scalar 'unlinked' tombstoned clears the scalar too", async () => {
  // The scalar version left one field, `unlinked`, that the hook gate still honours.
  // A deliberate re-adopt of that exact id retired the id from the new set but left
  // the legacy scalar in place, so the gate kept rejecting the very session the user
  // chose to link. agentSlot.set must drop the scalar when it names the linked id.
  const project = twoLaneProject();
  const s = loadState(project); // active is main
  laneOf(s, "main").agents.codex = { id: null, transcriptPath: null, mark: null, idle: false, unlinked: "sess-A" };

  agentSlot(s, "codex").set({ id: "sess-A", transcriptPath: "/t" });

  const slot = laneOf(s, "main").agents.codex;
  assert.equal(slot.id, "sess-A", "the deliberate link landed");
  assert.equal(slot.unlinked ?? null, null, "and the legacy scalar tombstone for that same id is gone");
});

test("re-adopting a DIFFERENT id leaves a legacy scalar tombstone standing", async () => {
  // Linking sess-B must not resurrect sess-A: its scalar tombstone stays until the
  // next unlink migrates it into the set, so sess-A's stale hook is still a no-op.
  const project = twoLaneProject();
  const s = loadState(project); // active is main
  laneOf(s, "main").agents.codex = { id: null, transcriptPath: null, mark: null, idle: false, unlinked: "sess-A" };

  agentSlot(s, "codex").set({ id: "sess-B", transcriptPath: "/t" });

  assert.equal(laneOf(s, "main").agents.codex.unlinked, "sess-A", "a link of a different id leaves sess-A tombstoned");
});
