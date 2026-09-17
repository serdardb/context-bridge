import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { searchProject } from "../src/search.mjs";
import { buildManifest, writeManifest } from "../src/audit.mjs";
import { ensureState, writeCheckpoint, checkpointsDir } from "../src/state.mjs";

test("branch search uses recorded history rather than the current checkout and needs no Git at read time", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-search-branch-"));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git("init", "-q");
    ensureState(project);
    const first = "2026-09-16T00-00-00-000Z-claude-to-codex";
    const second = "2026-09-16T01-00-00-000Z-claude-to-codex";
    for (const [stem, branch] of [[first, "feature/first"], [second, "feature/second"]]) {
      git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
      const manifest = buildManifest(project, { source: "claude", target: "codex" });
      assert.equal(manifest.git.branch, branch);
      writeManifest(project, "main", stem, manifest);
      writeCheckpoint(project, "main", `${stem}.md.consumed`, "historical migration decision");
    }
    writeCheckpoint(project, "main", "2026-09-16T02-00-00-000Z-claude-to-codex.md", "historical migration decision without branch metadata");
    const cli = fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "search", "migration", "--branch", "feature/first", "--json"], {
      cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" },
    });
    assert.equal(result.status, 1, "unknown historical branch metadata must be disclosed");
    assert.equal(JSON.parse(result.stdout).incomplete, true);
    assert.deepEqual(JSON.parse(result.stdout).results.map((entry) => entry.file), [`${first}.md.consumed`]);
    assert.equal(searchProject(project, "migration").results.length, 3);
    const withoutGit = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { buildManifest } from ${JSON.stringify(new URL("../src/audit.mjs", import.meta.url).href)};
      console.log(JSON.stringify(buildManifest(${JSON.stringify(project)}, { source: 'claude', target: 'codex' }).git));
    `], { encoding: "utf8", env: { ...process.env, PATH: "" } });
    assert.equal(withoutGit.status, 0, withoutGit.stderr);
    assert.deepEqual(JSON.parse(withoutGit.stdout), { branch: null, sha: null });
    assert.deepEqual(searchProject(project, "migration", { branch: "missing" }).results, []);
    assert.throws(() => searchProject(project, "migration", { branch: "" }), /must not be empty/);
    fs.unlinkSync(path.join(checkpointsDir(project), `${first}-audit.json`));
    fs.symlinkSync(path.join(checkpointsDir(project), `${second}-audit.json`), path.join(checkpointsDir(project), `${first}-audit.json`));
    assert.deepEqual(searchProject(project, "migration", { branch: "feature/first" }).results, []);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("search finds evidence across checkpoint kinds without exposing physical paths", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-search-"));
  ensureState(project);
  writeCheckpoint(project, "main", "2026-09-16T00-00-00-000Z-claude-to-codex.md", "The migration decision is durable.");
  writeCheckpoint(project, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", "The migration decision is durable.");
  writeCheckpoint(project, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-audit.json", JSON.stringify({ command: "migration" }));
  const { results, incomplete } = searchProject(project, "MIGRATION");
  assert.equal(incomplete, false);
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.lane === "main" && !result.file.includes(project)));
});

test("search rejects an empty query", () => {
  assert.throws(() => searchProject(os.tmpdir(), "   "), /non-empty query/);
});

test("search CLI keeps option values out of the query and searches consumed inbound and outbound evidence", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-search-cli-"));
  ensureState(project);
  const names = [
    "2026-09-15T23-59-59-999Z-claude-to-codex.md.consumed",
    "2026-09-16T00-00-00-000Z-claude-to-codex.md.consumed",
    "2026-09-16T23-59-59-999Z-codex-to-claude.md.consumed",
    "2026-09-17T00-00-00-000Z-claude-to-codex.md",
    "2026-09-16T12-00-00-000Z-grok-to-opencode.md",
  ];
  for (const name of names) writeCheckpoint(project, "main", name, "migration decision");
  const cli = fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "search", "migration", "decision", "--lane", "main", "--agent=claude", "--since", "2026-09-16", "--until=2026-09-16", "--json"], { cwd: project, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).results.map((entry) => entry.file), [names[2], names[1]]);
  const invalid = spawnSync(process.execPath, [cli, "search", "migration", "--lane"], { cwd: project, encoding: "utf8" });
  assert.notEqual(invalid.status, 0, "missing flag values must not silently broaden the search");
});

test("search refuses invalid date ranges and discloses unreadable or unsafe evidence", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-search-links-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  ensureState(project);
  const external = path.join(project, "private.txt");
  fs.writeFileSync(external, "private needle");
  fs.symlinkSync(external, path.join(checkpointsDir(project), "2026-09-16T00-00-00-000Z-claude-to-codex.md"));
  const report = searchProject(project, "needle");
  assert.deepEqual(report.results, []);
  assert.equal(report.incomplete, true);
  assert.equal(report.issues[0].reason, "unsafe-checkpoint");
  const cli = fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "search", "needle", "--json"], { cwd: project, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.deepEqual(JSON.parse(run.stdout), report);
  assert.ok(!run.stdout.includes(external), "physical target paths must not leak");
  const original = fs.readdirSync;
  fs.readdirSync = (dir, ...args) => {
    if (dir === checkpointsDir(project)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original(dir, ...args);
  };
  try {
    assert.equal(searchProject(project, "needle").issues[0].reason, "unreadable-checkpoints-directory");
  } finally { fs.readdirSync = original; }
  assert.throws(() => searchProject(project, "needle", { since: "2026-02-30" }), /Invalid search date/);
  assert.throws(() => searchProject(project, "needle", { since: "2026-09-17", until: "2026-09-16" }), /must not be after/);
  assert.throws(() => searchProject(project, "needle", { agent: "unknown" }), /Unknown search agent/);
});
