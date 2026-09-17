import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ensureState, loadState, mutateProject, createLane, isValidLaneName, laneHasLiveLauncher } from "./state.mjs";
import { projectIdentity } from "./storage.mjs";

function git(dir, args) {
  try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error("Worktree operation failed. Check Git availability, repository, ref and destination; existing worktrees are never deleted automatically."); }
}
const canonical = (dir) => fs.realpathSync(dir);
const common = (dir) => canonical(path.resolve(dir, git(dir, ["rev-parse", "--git-common-dir"])));

/** Explicitly optional: only this feature invokes Git as a prerequisite. */
export function createWorktreeLane(projectDir, name, destination, { attach = false, branch = null, base = "HEAD" } = {}) {
  if (!isValidLaneName(name) || name === "main") throw new Error("Choose a valid non-main worktree lane name.");
  const root = canonical(projectDir);
  if (canonical(git(root, ["rev-parse", "--show-toplevel"])) !== root) throw new Error("Create worktree lanes from the repository root.");
  if (typeof destination !== "string" || !destination.trim()) throw new Error("A worktree destination is required.");
  const absolute = path.resolve(root, destination);
  const target = path.join(canonical(path.dirname(absolute)), path.basename(absolute));
  if (target === root || target.startsWith(root + path.sep)) throw new Error("The worktree must be outside the source project directory.");
  if (attach) {
    const actual = canonical(target);
    if (actual === root || actual.startsWith(root + path.sep)) throw new Error("The worktree must be outside the source project directory.");
    if (canonical(git(target, ["rev-parse", "--show-toplevel"])) !== canonical(target) || common(target) !== common(root)) {
      throw new Error("The destination is not a worktree of this repository.");
    }
  } else {
    if (fs.existsSync(target)) throw new Error("Worktree destination already exists; use lane attach for an existing worktree.");
    branch ??= `bridge/${name}-${randomUUID().slice(0, 8)}`;
    git(root, ["check-ref-format", "--branch", branch]);
    // Resolve the commit before any state mutation; do not let a ref become an option.
    base = git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  }
  ensureState(root);
  const parentId = projectIdentity(root).id;
  let result;
  mutateProject(root, (parent) => {
    if (parent.lanes[name]) throw new Error(`Lane '${name}' already exists.`);
    if (!attach) git(root, ["worktree", "add", "-b", branch, "--", target, base]);
    // Preserve a successfully created worktree on later failures. Attach retries
    // can reuse the child lane identified by the same parent and name.
    ensureState(target);
    const childId = projectIdentity(target).id;
    mutateProject(target, (child) => {
      const existing = child.lanes[name];
      if (existing && (existing.worktreeOrigin?.projectId !== parentId || existing.worktreeOrigin?.lane !== name)) {
        throw new Error(`Destination already has an unrelated '${name}' lane.`);
      }
      if (laneHasLiveLauncher(child, name)) throw new Error("Destination lane has a live launcher.");
      const lane = existing ?? createLane(child, name);
      lane.worktreeOrigin = { projectId: parentId, lane: name };
      child.activeLane = name;
    });
    const lane = createLane(parent, name);
    lane.worktree = { root: canonical(target), projectId: childId, lane: name };
    result = { lane: name, path: lane.worktree.root, branch: attach ? git(target, ["branch", "--show-current"]) || null : branch, attached: attach };
  });
  return result;
}

export function laneWorkspace(projectDir, laneName = null) {
  const state = loadState(projectDir, { readOnly: true });
  const name = laneName ?? state?.activeLane;
  const worktree = state?.lanes?.[name]?.worktree;
  if (!worktree) return { projectDir, lane: name, isolated: false };
  if (!fs.existsSync(worktree.root) || projectIdentity(worktree.root).id !== worktree.projectId) {
    throw new Error(`Worktree for lane '${name}' is missing or has changed identity; refusing to launch in another directory.`);
  }
  const child = loadState(worktree.root, { readOnly: true });
  const origin = child?.lanes?.[worktree.lane]?.worktreeOrigin;
  if (origin?.projectId !== projectIdentity(projectDir).id || origin?.lane !== name) {
    throw new Error(`Worktree lane '${name}' has no matching bridge ownership record.`);
  }
  return { projectDir: worktree.root, lane: worktree.lane, isolated: true };
}
