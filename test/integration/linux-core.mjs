// Run in a disposable Linux environment without Git; no network or home mounts.
import "../lane-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "linux", "this acceptance requires a real Linux runtime");
assert.equal(spawnSync("git", ["--version"]).error?.code, "ENOENT", "Git must actually be absent");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-linux-core-"));
const cwd = fileURLToPath(new URL("../../", import.meta.url));
const files = ["storage", "artifact", "artifact-cache", "artifact-signature", "aider-lifeline",
  "aider-records", "aider-sessions", "pi-records"];
// These tests explicitly exercise Git repositories. All other tests in these
// modules run; Git-only cases belong to the separate Git-installed matrix.
const excluded = "real clones and worktrees|a Git project is locatable|two clones without a marker|Git fixture";
try {
  fs.writeFileSync(path.join(root, "Case"), "upper");
  fs.writeFileSync(path.join(root, "case"), "lower");
  assert.notEqual(fs.statSync(path.join(root, "Case")).ino, fs.statSync(path.join(root, "case")).ino);
  const result = spawnSync(process.execPath, ["--import", "./test/setup.mjs", "--test", "--test-skip-pattern", excluded,
    ...files.map((name) => `test/${name}.test.mjs`)], {
    cwd, stdio: "inherit", timeout: 180000,
    env: { ...process.env, HOME: root, CONTEXT_BRIDGE_HOME: path.join(root, "runtime") },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, "Linux no-Git acceptance failed");
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version,
    gitAbsent: true, caseSensitiveFixtures: true, files, excluded,
    nativeAgentsVerified: false, fullSuite: false }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
