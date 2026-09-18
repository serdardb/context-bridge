import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { processCreationToken } from "../../src/locking.mjs";
import { projectIdentity, projectOperations, recoverProjectOperations } from "../../src/storage.mjs";

assert.equal(process.platform, "win32");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-operation-owner-"));
const project = path.join(root, "project");
fs.mkdirSync(project);
process.env.CONTEXT_BRIDGE_HOME = path.join(root, "home");
process.env.CONTEXT_BRIDGE_STORAGE = "";
try {
  const own = processCreationToken(process.pid);
  assert.match(own, /^[0-9a-f]{16}$/);
  assert.equal(processCreationToken(process.pid), own);
  const module = new URL("../../src/storage.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {withProjectOperation} from ${JSON.stringify(module)};
    withProjectOperation(${JSON.stringify(project)}, 'handoff', () => process.exit(79));
  `], { env: process.env, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 79, child.stderr);
  const { id } = projectIdentity(project);
  const names = projectOperations(id);
  assert.equal(names.length, 1);
  const file = path.join(process.env.CONTEXT_BRIDGE_HOME, "operations", id, names[0]);
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.match(old.ownerCreationToken, /^[0-9a-f]{16}$/);
  assert.notEqual(old.ownerCreationToken, own);
  const write = record => fs.writeFileSync(file, JSON.stringify(record));
  // Model PID reuse using two actual native creation identities. The live
  // current process must not own the terminated child's reservation.
  write({ ...old, pid: process.pid, ownerCreationToken: own });
  assert.equal(recoverProjectOperations(id, { apply: true }).retained.length, 1);
  const legacy = { ...old, pid: process.pid };
  delete legacy.ownerCreationToken;
  write(legacy);
  assert.equal(recoverProjectOperations(id, { apply: true }).retained.length, 1);
  write({ ...old, pid: process.pid, ownerCreationToken: "invalid" });
  assert.equal(recoverProjectOperations(id, { apply: true }).complete, false);
  write({ ...old, pid: process.pid });
  const preview = recoverProjectOperations(id);
  assert.deepEqual(preview.recoverable, names);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(recoverProjectOperations(id, { apply: true }).removed, names);
  assert.deepEqual(projectOperations(id), []);
  assert.equal(processCreationToken(process.pid), own, "the unrelated live process is untouched");
  console.log(JSON.stringify({ passed: true, nativeCreationIdentity: true,
    reusedPidModeled: true, liveAndLegacyOwnersPreserved: true }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
