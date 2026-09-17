import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPiSession, piMark, piActivity } from "../src/agents/pi-records.mjs";

test("Pi reader follows the persisted branch and resends its context when a mark is off-branch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pi-records-"));
  const file = path.join(dir, "session.jsonl");
  const at = "2026-09-17T00:00:00.000Z";
  const header = { type: "session", version: 3, id: "native-session", cwd: dir, timestamp: at };
  const message = (id, parentId, role, text) => ({ type: "message", id, parentId, timestamp: at,
    message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { stopReason: "stop" } : {}) } });
  const rows = [header, message("a", null, "user", "original request"), message("b", "a", "assistant", "abandoned answer")];
  const write = () => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    write();
    const old = piMark(readPiSession(file));
    rows.push(message("c", "a", "user", "new direction"), message("d", "c", "assistant", "current answer"));
    write();
    const session = readPiSession(file);
    const activity = piActivity(session, old);
    assert.equal(activity.branchChanged, true);
    assert.deepEqual(activity.messages.map((entry) => entry.text), ["original request", "new direction", "current answer"]);
    assert.equal(activity.turnsCompleted, 1);
    assert.deepEqual(piActivity(session, piMark(session)).messages, []);
    fs.appendFileSync(file, '{"type":"message"');
    assert.equal(readPiSession(file).incompleteTail, true);
    assert.deepEqual(piMark(readPiSession(file)), piMark(session));
    fs.appendFileSync(file, "\n");
    assert.throws(() => readPiSession(file), /damaged Pi session/);
    rows.push(message("e", "missing-parent", "user", "must not silently disappear"));
    write();
    assert.throws(() => readPiSession(file), /damaged Pi session/);
    rows.pop();
    header.version = 4;
    write();
    assert.throws(() => readPiSession(file), /Unsupported/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
