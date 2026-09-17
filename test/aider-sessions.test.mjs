import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectIdentity } from "../src/storage.mjs";
import { aiderSessionsDirectory, aiderSessionRef, aiderSessionsForProject, createAiderSession, aiderStartedSessions } from "../src/agents/aider-sessions.mjs";

test("Aider session registry stays outside a non-Git project and refuses foreign identities and redirected files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-aider-sessions-"));
  const saved = { CONTEXT_BRIDGE_HOME: process.env.CONTEXT_BRIDGE_HOME, PATH: process.env.PATH };
  process.env.CONTEXT_BRIDGE_HOME = path.join(root, "home");
  process.env.PATH = "";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project"); fs.mkdirSync(project);
  assert.deepEqual(aiderSessionsForProject(project), []);
  assert.equal(fs.existsSync(process.env.CONTEXT_BRIDGE_HOME), false, "discovery is read-only");
  assert.throws(() => createAiderSession(project, { env: {} }), /absolute interpreter/);
  assert.equal(fs.existsSync(process.env.CONTEXT_BRIDGE_HOME), false, "bad runtime is rejected before writes");
  const parent = aiderSessionsDirectory(project, { create: true });
  const id = randomUUID(), projectId = projectIdentity(project).id;
  const dir = path.join(parent, id); fs.mkdirSync(dir);
  const meta = { version: 1, id, projectId, createdAt: new Date().toISOString(), sdkVersion: "0.86.2", python: process.execPath };
  const file = path.join(dir, "session.json");
  fs.writeFileSync(file, JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ type: "session", version: 1, sessionId: id, projectId }) + "\n");
  for (const name of ["chat.md", "input.txt"]) fs.writeFileSync(path.join(dir, name), "");
  fs.mkdirSync(path.join(parent, ".creating-abandoned"));
  assert.equal(aiderSessionsForProject(project).length, 1);
  assert.equal(aiderSessionRef(project, id).id, id);
  fs.writeFileSync(path.join(dir, "launch.json"), JSON.stringify({ version: 1, sessionId: id, projectId,
    pid: 123, at: "2026-09-17T12:00:00Z" }));
  assert.deepEqual(aiderStartedSessions(project, { startedAt: "2026-09-17T11:59:59Z", childPid: 123 }).map((ref) => ref.id), [id]);
  assert.deepEqual(aiderStartedSessions(project, { startedAt: "2026-09-17T12:00:01Z", childPid: 123 }), []);
  assert.deepEqual(aiderStartedSessions(project, { startedAt: "2026-09-17T11:59:59Z", childPid: 124 }), []);
  fs.writeFileSync(file, JSON.stringify({ ...meta, projectId: randomUUID() }));
  assert.throws(() => aiderSessionRef(project, id), /invalid/);
  fs.writeFileSync(file, JSON.stringify(meta));
  fs.renameSync(path.join(dir, "input.txt"), path.join(dir, "real-input"));
  fs.symlinkSync(path.join(dir, "real-input"), path.join(dir, "input.txt"));
  assert.throws(() => aiderSessionRef(project, id), /invalid/);
  fs.unlinkSync(path.join(dir, "input.txt"));
  fs.renameSync(path.join(dir, "real-input"), path.join(dir, "input.txt"));
  const moved = path.join(root, "moved"); fs.renameSync(project, moved);
  assert.equal(aiderSessionRef(moved, id).projectId, projectId);
  assert.equal(fs.existsSync(path.join(moved, ".bridge")), false);
  assert.throws(() => aiderSessionRef(moved, "../escape"), /invalid/);
});
