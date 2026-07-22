import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureState, loadState, STATE_VERSION } from "../src/state.mjs";

test("ensureState creates bridge layout and appends .bridge/ to gitignore once", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-"));
  fs.mkdirSync(path.join(project, ".git"));
  fs.writeFileSync(path.join(project, ".gitignore"), "node_modules/\n");

  const state = ensureState(project);
  assert.equal(state.project, project);
  assert.ok(fs.existsSync(path.join(project, ".bridge", "state.json")));
  assert.ok(fs.existsSync(path.join(project, ".bridge", "checkpoints")));
  assert.ok(fs.existsSync(path.join(project, ".bridge", "logs")));

  ensureState(project);
  const gitignore = fs.readFileSync(path.join(project, ".gitignore"), "utf8");
  assert.equal(gitignore.match(/^\.bridge\/$/gm)?.length, 1);
  assert.equal(loadState(project).version, STATE_VERSION, "a literal here breaks on every bump; the constant is the claim");
});

// Lanes. The migration that folds a single-line project into its first lane is
// the one change in this project that cannot be walked back, so what it must
// never do is lose something on the way down.
test("migrating to lanes moves every field and loses none of it", async () => {
  const { statePath, loadState, DEFAULT_LANE } = await import("../src/state.mjs");
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lane-mig-")));
  fs.mkdirSync(path.join(project, ".bridge"), { recursive: true });

  // A v4 project mid-flight: linked agents, a watermark matrix, a pending
  // delivery and a recorded git sha.
  const v4 = {
    version: 4,
    project,
    activeAgent: "codex",
    agents: {
      claude: { id: "c-1", transcriptPath: "/tmp/c.jsonl", mark: "2026-07-20T10:00:00.000Z", idle: false },
      codex: { id: "x-1", transcriptPath: "/tmp/x.jsonl", mark: "2026-07-20T11:00:00.000Z", idle: true },
    },
    pendingHandoff: { target: "grok", ready: true, requestedAt: "2026-07-20T12:00:00.000Z" },
    pendingInjection: { agent: "grok", deltaFile: ".bridge/checkpoints/d.md", sources: { claude: "m" } },
    knownBy: { grok: { claude: "2026-07-20T09:00:00.000Z" } },
    git: { sha: "abc123", recordedAt: "2026-07-20T12:00:00.000Z" },
    launcher: { stateVersion: 4, pid: 999, recordedAt: "2026-07-20T12:00:00.000Z" },
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
  fs.writeFileSync(statePath(project), JSON.stringify(v4));

  const s = loadState(project);
  const raw = JSON.parse(fs.readFileSync(statePath(project), "utf8"));
  const lane = raw.lanes[DEFAULT_LANE];

  for (const field of ["activeAgent", "agents", "pendingHandoff", "pendingInjection", "knownBy", "git"]) {
    assert.deepEqual(lane[field], v4[field], `${field} did not survive the move into the lane`);
  }
  assert.deepEqual(raw.launcher, v4.launcher, "the launcher record is the project's, not a lane's");
  assert.equal(raw.activeLane, DEFAULT_LANE);
  assert.ok(fs.existsSync(`${statePath(project)}.v4.backup`), "a one-way migration must leave the original behind");

  // And the loaded object still answers where every caller already asks.
  assert.equal(s.activeAgent, "codex");
  assert.equal(s.agents.claude.id, "c-1");
  assert.equal(s.pendingInjection.agent, "grok");
});

test("the fields callers read are the lane's own objects, not copies of them", async () => {
  const { defaultState, DEFAULT_LANE } = await import("../src/state.mjs");
  const s = defaultState("/tmp/whatever");
  assert.equal(s.agents, s.lanes[DEFAULT_LANE].agents, "a copy would silently drop every write");

  s.pendingHandoff = { target: "codex", ready: true };
  assert.deepEqual(s.lanes[DEFAULT_LANE].pendingHandoff, { target: "codex", ready: true }, "assignment has to land in the lane");

  s.agents.grok.id = "g-1";
  assert.equal(s.lanes[DEFAULT_LANE].agents.grok.id, "g-1", "and so does mutation");
});

test("nothing a lane owns is written back at the project root", async () => {
  const { defaultState, saveState, statePath } = await import("../src/state.mjs");
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lane-root-")));
  const s = defaultState(project);
  s.activeAgent = "claude";
  saveState(project, s);

  const raw = JSON.parse(fs.readFileSync(statePath(project), "utf8"));
  for (const field of ["activeAgent", "agents", "pendingHandoff", "pendingInjection", "knownBy", "git"]) {
    assert.equal(raw[field], undefined, `${field} written twice means two truths and one of them goes stale`);
  }
});
