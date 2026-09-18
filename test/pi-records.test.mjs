import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPiSession, piMark, piActivity, piAudit } from "../src/agents/pi-records.mjs";

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
    assert.equal(activity.sourceRewritten, true, 'replayed branch history is not a new delivery receipt');
    assert.deepEqual(piActivity(session, piMark(session)).messages, []);
    const mark = piMark(session);
    rows.at(-1).message.content[0].text = 'corrected answer with the same id';
    write();
    const revised = readPiSession(file);
    assert.equal(piActivity(revised, mark).sourceRewritten, true);
    assert.equal(piActivity(revised, mark).messages.at(-1).text, 'corrected answer with the same id');
    const legacy = { version: 1, sessionId: header.id, entryId: 'd' };
    assert.deepEqual(piActivity(revised, legacy).messages, [], 'legacy id-only marks remain supported but cannot attest content');
    rows.push({ ...message('tool', 'd', 'assistant', ''), message: { role: 'assistant',
      content: [{ type: 'toolCall', id: 'call', name: 'edit', arguments: { path: 'file.txt' } }] } },
    { ...message('result', 'tool', 'assistant', ''), message: { role: 'toolResult', toolCallId: 'call', isError: false } });
    write();
    const auditMark = piMark(readPiSession(file));
    rows.at(-1).message.isError = true;
    write();
    const correctedAudit = piAudit(readPiSession(file), auditMark);
    assert.equal(correctedAudit.sourceRewritten, true);
    assert.equal(correctedAudit.commands[0].ok, false);
    assert.deepEqual(correctedAudit.filesChanged, []);
    rows.splice(-2);
    write();
    assert.equal(piActivity(readPiSession(file), auditMark).sourceRewritten, true, 'shortened history is not empty activity');
    rows.at(-1).message.content[0].text = 'current answer';
    write();
    fs.appendFileSync(file, '{"type":"message"');
    assert.equal(readPiSession(file).incompleteTail, true);
    assert.equal(piActivity(readPiSession(file)).sourceComplete, false);
    assert.equal(piAudit(readPiSession(file)).sourceComplete, false);
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
