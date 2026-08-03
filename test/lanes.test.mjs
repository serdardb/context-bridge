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
  emptyLane,
  STATE_VERSION,
} from "../src/state.mjs";

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
