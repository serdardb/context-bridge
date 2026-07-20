import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureState, loadState } from "../src/state.mjs";

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
  assert.equal(loadState(project).version, 4);
});
