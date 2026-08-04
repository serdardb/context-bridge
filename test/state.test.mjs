import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureState, loadState, STATE_VERSION, safeCheckpointPath } from "../src/state.mjs";

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

// The rollback path was silent. The backup has always been written and nothing
// ever mentioned it, so going back looked impossible when it is a copy away, and
// an older bridge refuses a v5 file outright rather than guessing. Said once, at
// the only moment it is true and the only moment anyone can act on it.
test("a migration says what it did and where the original went, exactly once", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-migsay-"));
  fs.mkdirSync(path.join(project, ".bridge"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".bridge", "state.json"),
    JSON.stringify({ version: 4, project, activeAgent: "claude", agents: {}, knownBy: {}, git: {} })
  );

  const said = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    said.push(String(chunk));
    return original(chunk, ...rest);
  };
  try {
    loadState(project);
    loadState(project);
  } finally {
    process.stdout.write = original;
  }

  const spoke = said.join("").split("\n").filter((l) => l.trim());
  assert.equal(spoke.length, 2, "one migration, one two-line notice, and nothing on the second read");
  assert.match(spoke[0], /from v4 to v5/, "it has to name both versions or it is not actionable");
  assert.match(spoke[0], /state\.json\.v4\.backup/, "and the file that makes going back possible");
  assert.match(spoke[1], /cannot read the new file/, "one way is the part nobody would guess");
  assert.ok(fs.existsSync(path.join(project, ".bridge", "state.json.v4.backup")));
});

// safeCheckpointPath is the single gate every state-derived checkpoint path passes
// through before it is read, renamed, appended to or deleted. State can be corrupt
// or hostile, so each of these shapes must be refused (null), and the legitimate
// shape must be allowed. Each assertion bites: removing the matching check in
// safeCheckpointPath flips exactly one of these from null to a path.
test("safeCheckpointPath allows a real checkpoint path and refuses every escape", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-safe-")));
  fs.mkdirSync(path.join(project, ".bridge", "checkpoints"), { recursive: true });
  const name = "2026-01-01T00-00-00-000Z-claude-to-codex.md";

  // legitimate: flat main checkpoints
  assert.equal(
    safeCheckpointPath(project, path.join(".bridge", "checkpoints", name)),
    path.join(project, ".bridge", "checkpoints", name),
    "a real .bridge/checkpoints path resolves"
  );
  // legitimate: a lane's checkpoints
  fs.mkdirSync(path.join(project, ".bridge", "lanes", "feature", "checkpoints"), { recursive: true });
  assert.equal(
    safeCheckpointPath(project, path.join(".bridge", "lanes", "feature", "checkpoints", name)),
    path.join(project, ".bridge", "lanes", "feature", "checkpoints", name),
    "a real lane checkpoints path resolves"
  );

  // .. traversal (target may not even exist) -> refused lexically
  assert.equal(safeCheckpointPath(project, path.join("..", "evil", name)), null, "a .. climb is refused");
  // a contained path whose parent is not a checkpoints dir -> refused structurally
  assert.equal(safeCheckpointPath(project, path.join(".bridge", "state.json")), null, "a non-checkpoints path is refused");
  // empty / non-string
  assert.equal(safeCheckpointPath(project, ""), null);
  assert.equal(safeCheckpointPath(project, null), null);

  fs.rmSync(project, { recursive: true });
});

test("safeCheckpointPath refuses a symlinked checkpoints directory and a symlinked .bridge root", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-safe-")));
  fs.mkdirSync(path.join(project, ".bridge"), { recursive: true });
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-outside-")));
  const name = "2026-01-01T00-00-00-000Z-claude-to-codex.md";
  fs.writeFileSync(path.join(outside, name), "external");

  // a lane checkpoints directory that is a symlink out
  fs.mkdirSync(path.join(project, ".bridge", "lanes", "feature"), { recursive: true });
  fs.symlinkSync(outside, path.join(project, ".bridge", "lanes", "feature", "checkpoints"));
  assert.equal(
    safeCheckpointPath(project, path.join(".bridge", "lanes", "feature", "checkpoints", name)),
    null,
    "a symlinked checkpoints directory is refused"
  );

  // .bridge root itself a symlink out (build a fresh project so .bridge can be the link)
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-root-")));
  const proj2 = path.join(base, "proj");
  fs.mkdirSync(proj2);
  const evil = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-evil-")));
  fs.mkdirSync(path.join(evil, "checkpoints"), { recursive: true });
  fs.writeFileSync(path.join(evil, "checkpoints", name), "external");
  fs.symlinkSync(evil, path.join(proj2, ".bridge"));
  assert.equal(
    safeCheckpointPath(proj2, path.join(".bridge", "checkpoints", name)),
    null,
    "a symlinked .bridge root is refused"
  );

  fs.rmSync(project, { recursive: true });
  fs.rmSync(outside, { recursive: true });
  fs.rmSync(base, { recursive: true });
  fs.rmSync(evil, { recursive: true });
});

// The init-time twin of the write gate: ensureState builds the whole .bridge layout
// on first run, so a symlinked .bridge root would write this project's state and
// checkpoints outside it before any per-write gate is reached. It refuses up front.
// Remove the guard and saveState writes state.json into the external directory.
test("ensureState refuses to initialise a project through a symlinked .bridge", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-init-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-outside-")));
  fs.symlinkSync(outside, path.join(project, ".bridge"));

  assert.throws(() => ensureState(project), /\.bridge is a symlink/, "a symlinked .bridge root must refuse init");
  assert.equal(fs.existsSync(path.join(outside, "state.json")), false, "no state written into the external directory");
  assert.equal(fs.existsSync(path.join(outside, "checkpoints")), false, "no checkpoints dir created outside");

  fs.rmSync(project, { recursive: true });
  fs.rmSync(outside, { recursive: true });
});
