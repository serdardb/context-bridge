import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWorktreeLane, laneWorkspace } from "../src/worktree.mjs";
import { loadState, mutateProject, statePath } from "../src/state.mjs";
import { projectStatus } from "../src/status.mjs";
import { handoff } from "../src/handoff.mjs";

const cli = fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url));
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-worktree-")));
  const saved = { home: process.env.CONTEXT_BRIDGE_HOME, mode: process.env.CONTEXT_BRIDGE_STORAGE };
  process.env.CONTEXT_BRIDGE_HOME = path.join(dir, "runtime");
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  t.after(() => {
    for (const [key, value] of [["CONTEXT_BRIDGE_HOME", saved.home], ["CONTEXT_BRIDGE_STORAGE", saved.mode]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const root = path.join(dir, "source"); fs.mkdirSync(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  fs.writeFileSync(path.join(root, "tracked.txt"), "committed\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  return { dir, root, git };
}

test("worktree lanes isolate code and state, launch in the correct cwd and remain usable without Git", (t) => {
  const { dir, root, git } = setup(t);
  fs.writeFileSync(path.join(root, "tracked.txt"), "uncommitted source work\n");
  const target = path.join(dir, "feature");
  const created = spawnSync(process.execPath, [cli, "lane", "new", "feature", `--worktree=${target}`, "--json"], {
    cwd: root, env: process.env, encoding: "utf8",
  });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).path, target);
  assert.equal(fs.readFileSync(path.join(target, "tracked.txt"), "utf8"), "committed\n");
  fs.writeFileSync(path.join(target, "tracked.txt"), "isolated work\n");
  assert.equal(fs.readFileSync(path.join(root, "tracked.txt"), "utf8"), "uncommitted source work\n");
  assert.notEqual(statePath(root), statePath(target));
  assert.equal(fs.existsSync(path.join(target, ".bridge")), false);
  assert.equal(fs.existsSync(path.join(root, ".bridge")), false);
  assert.equal(laneWorkspace(root, "feature").projectDir, target);
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  const observed = path.join(dir, "launched.json");
  fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify({cwd:process.cwd(),lane:process.env.CONTEXT_BRIDGE_LANE}));\n`, { mode: 0o755 });
  const launched = spawnSync(process.execPath, [cli, "claude", "--resume", "feature"], {
    cwd: root, env: { ...process.env, HOME: dir, PATH: bin }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(launched.status, 0, launched.stderr + launched.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(observed)), { cwd: target, lane: "feature" });
  assert.equal(loadState(target).activeLane, "feature");
  assert.equal(loadState(root).lanes.feature.agents.claude.id, null, "child sessions never leak into the parent link");
  const report = projectStatus(root);
  assert.deepEqual(report.workspace, { kind: "git-worktree", available: true });
  assert.throws(() => handoff(root, "codex", { from: "claude", dryRun: true }), /worktree directory/);
  assert.match(git("worktree", "list", "--porcelain"), /feature/);
  const link = loadState(root).lanes.feature.worktree;
  for (const invalid of [null, false, "", [], {}, { ...link, root: "relative-path" }]) {
    mutateProject(root, state => { state.lanes.feature.worktree = invalid; });
    fs.rmSync(observed, { force: true });
    const refused = spawnSync(process.execPath, [cli, "claude", "--resume", "feature"], {
      cwd: root, env: { ...process.env, HOME: dir, PATH: bin }, encoding: "utf8", timeout: 15000,
    });
    assert.notEqual(refused.status, 0, "malformed workspace must not launch in the parent project");
    assert.equal(fs.existsSync(observed), false);
    assert.throws(() => laneWorkspace(root, "feature"), /invalid worktree/i);
    assert.equal(projectStatus(root).workspace.available, false);
  }
  mutateProject(root, state => { state.lanes.feature.worktree = link; });
  fs.renameSync(target, `${target}-moved`);
  fs.mkdirSync(target);
  assert.throws(() => laneWorkspace(root, "feature"), /changed identity/);
  assert.equal(projectStatus(root).workspace.available, false);
});

test("worktree attachment recovers a missing parent link without deleting code or commandeering another repository", (t) => {
  const { dir, root } = setup(t);
  const target = path.join(dir, "recovery");
  createWorktreeLane(root, "recovery", target);
  fs.writeFileSync(path.join(target, "precious.txt"), "keep");
  mutateProject(root, (state) => { delete state.lanes.recovery; });
  const recovered = createWorktreeLane(root, "recovery", target, { attach: true });
  assert.equal(recovered.attached, true);
  assert.equal(fs.readFileSync(path.join(target, "precious.txt"), "utf8"), "keep");
  assert.throws(() => createWorktreeLane(root, "inside", path.join(root, "nested")), /outside/);
  const alias = path.join(dir, "source-alias"); fs.symlinkSync(root, alias);
  assert.throws(() => createWorktreeLane(root, "self", alias, { attach: true }), /outside/);
  const other = path.join(dir, "unrelated"); fs.mkdirSync(other);
  execFileSync("git", ["-C", other, "init"], { stdio: "ignore" });
  assert.throws(() => createWorktreeLane(root, "foreign", other, { attach: true }), /not a worktree/);
  assert.equal(loadState(root).lanes.foreign, undefined);
  const removed = spawnSync(process.execPath, [cli, "lane", "rm", "recovery", "--yes"], { cwd: root, env: process.env, encoding: "utf8" });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(loadState(root).lanes.recovery, undefined);
  assert.equal(fs.readFileSync(path.join(target, "precious.txt"), "utf8"), "keep");
  assert.ok(loadState(target).lanes.recovery, "removing a parent link does not erase the child state");
  const plain = path.join(dir, "no-git-project"); fs.mkdirSync(plain);
  const unavailable = spawnSync(process.execPath, [cli, "lane", "new", "isolated", "--worktree", path.join(dir, "never-created")], {
    cwd: plain, env: { ...process.env, PATH: "" }, encoding: "utf8",
  });
  assert.notEqual(unavailable.status, 0);
  assert.deepEqual(fs.readdirSync(plain), []);
  const noGit = spawnSync(process.execPath, [cli, "lane", "new", "ordinary"], {
    cwd: plain, env: { ...process.env, PATH: "" }, encoding: "utf8",
  });
  assert.equal(noGit.status, 0, noGit.stderr);
  assert.ok(loadState(plain).lanes.ordinary, "ordinary lanes must still work without Git or a Git repository");
});
