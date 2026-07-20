import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AGENT_IDS, adapterFor } from "../src/agents/index.mjs";

// The live bug: the launcher starts a fresh session for a prompt-injecting agent
// and nothing writes its id into state. Claude is saved by its SessionStart hook;
// Codex and Grok were linked only if they later ran a handoff themselves. Until
// then `bridge <agent>` refused to resume the very session it had just created,
// and every further handoff minted another one — six Grok sessions in one project
// before anyone noticed. These tests guard the adoption that closes it.

test("every registered agent can identify the session the launcher started", () => {
  for (const id of AGENT_IDS) {
    assert.equal(
      typeof adapterFor(id).adoptStartedSession,
      "function",
      `${id} must be adoptable, or a fresh session through it can never be resumed`
    );
  }
});

test("Grok identifies our own child by pid, not by whichever session is newest", () => {
  const home = fakeGrokHome();
  const project = "/tmp/project-a";
  writeGrokSession(home, project, "aaa", "2026-07-21T00:00:10Z");
  writeGrokSession(home, project, "bbb", "2026-07-21T00:00:20Z");
  registry(home, [
    { session_id: "aaa", pid: 4242, cwd: project, opened_at: "2026-07-21T00:00:10Z" },
    { session_id: "bbb", pid: 9999, cwd: project, opened_at: "2026-07-21T00:00:20Z" },
  ]);

  const found = withGrokHome(home, () =>
    adapterFor("grok").adoptStartedSession(project, { startedAt: "2026-07-21T00:00:00Z", childPid: 4242 })
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "aaa", "the newer session belongs to another terminal and must be left alone");
});

test("two candidates and no pid match means no candidate: never steal another terminal's session", () => {
  const home = fakeGrokHome();
  const project = "/tmp/project-b";
  writeGrokSession(home, project, "one", "2026-07-21T00:00:10Z");
  writeGrokSession(home, project, "two", "2026-07-21T00:00:20Z");
  registry(home, [
    { session_id: "one", pid: 111, cwd: project, opened_at: "2026-07-21T00:00:10Z" },
    { session_id: "two", pid: 222, cwd: project, opened_at: "2026-07-21T00:00:20Z" },
  ]);

  const found = withGrokHome(home, () =>
    adapterFor("grok").adoptStartedSession(project, { startedAt: "2026-07-21T00:00:00Z", childPid: 3333 })
  );
  assert.equal(found.length, 2, "both are returned so the caller can refuse; picking one here would be a guess");
});

test("a session opened before we spawned is not ours", () => {
  const home = fakeGrokHome();
  const project = "/tmp/project-c";
  writeGrokSession(home, project, "old", "2026-07-20T10:00:00Z");
  registry(home, [{ session_id: "old", pid: 55, cwd: project, opened_at: "2026-07-20T10:00:00Z" }]);

  const found = withGrokHome(home, () =>
    adapterFor("grok").adoptStartedSession(project, { startedAt: "2026-07-21T00:00:00Z", childPid: 55 })
  );
  assert.equal(found.length, 0);
});

// The registry is live: entries vanish when a session closes. Adoption therefore
// cannot rely on it alone, or a launcher killed with its terminal would leave the
// session stranded — the exact failure this work exists to remove.
test("after the session closes, the registry is empty and the directory still answers", () => {
  const home = fakeGrokHome();
  const project = "/tmp/project-d";
  writeGrokSession(home, project, "ghost", "2026-07-21T00:00:30Z");
  registry(home, []);

  const found = withGrokHome(home, () =>
    adapterFor("grok").adoptStartedSession(project, { startedAt: "2026-07-21T00:00:00Z", childPid: 777 })
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "ghost");
});

function fakeGrokHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  return home;
}

function withGrokHome(home, fn) {
  const previous = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
  }
}

function writeGrokSession(home, projectDir, id, createdAt) {
  const dir = path.join(home, "sessions", encodeURIComponent(projectDir), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({ info: { id, cwd: projectDir }, created_at: createdAt, updated_at: createdAt })
  );
  fs.writeFileSync(path.join(dir, "chat_history.jsonl"), JSON.stringify({ type: "user", content: "hi" }) + "\n");
  fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ type: "turn_ended" }) + "\n");
}

function registry(home, entries) {
  fs.writeFileSync(path.join(home, "active_sessions.json"), JSON.stringify(entries));
}

// Found while building the above: rollout head records are parsed from a fixed
// 16KB buffer, but codex-cli embeds its full base instructions in that record and
// on 0.144.6 it runs to 22KB. Every parse failed, so no rollout ever matched a
// project and Codex discovery returned null for every session on the machine —
// silently, because a failed parse looks exactly like "a different project".
test("a rollout head record larger than one buffer is still parsed", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "codex-project-"));
  const dir = path.join(home, "sessions", "2026", "07", "21");
  fs.mkdirSync(dir, { recursive: true });

  const id = "019f8888-0000-7000-8000-000000000001";
  const line = JSON.stringify({
    timestamp: "2026-07-21T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd: project, timestamp: "2026-07-21T00:00:00.000Z", base_instructions: { text: "x".repeat(30000) } },
  });
  assert.ok(line.length > 16384, "the fixture must exceed the old buffer or it proves nothing");
  fs.writeFileSync(path.join(dir, `rollout-2026-07-21T00-00-00-${id}.jsonl`), line + "\n");

  // CODEX_HOME is read when the module loads, so this runs in its own process.
  const script = `import("${path.resolve("src/discover.mjs")}").then(({rolloutsForProjectSince}) => {
    const found = rolloutsForProjectSince(process.argv[1], null);
    console.log(JSON.stringify(found.map((f) => f.threadId)));
  });`;
  const out = execFileSync(process.execPath, ["-e", script, project], {
    env: { ...process.env, CODEX_HOME: home },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(out), [id], "a 22KB head record must not read as a foreign project");
});
