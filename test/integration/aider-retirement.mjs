import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { projectIdentity, projectOperations, recoverProjectOperations } from '../../src/storage.mjs';
import { projectLifecycle } from '../../src/project-lifecycle.mjs';

// Isolated transport fixture, not an Aider SDK/model acceptance experiment.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-aider-retirement-'));
const saved = process.env.CONTEXT_BRIDGE_HOME;
const savedTimeout = process.env.CONTEXT_BRIDGE_LOCK_TIMEOUT_MS;
process.env.CONTEXT_BRIDGE_LOCK_TIMEOUT_MS = '150';
process.env.CONTEXT_BRIDGE_HOME = path.join(root, 'home');
const project = path.join(root, 'project');
fs.mkdirSync(project);
const ready = path.join(root, 'ready');
const python = path.join(root, 'python-fixture');
fs.writeFileSync(python, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('-c')) {
  console.log(JSON.stringify({python:[3,11,0],prefix:${JSON.stringify(root)},isolated:1,aider:'0.86.2'}));
} else {
  import(${JSON.stringify(new URL('../../src/locking.mjs', import.meta.url).href)}).then(({withKernelLockSync}) => {
    const dir = process.argv[process.argv.indexOf('--session-dir') + 1];
    withKernelLockSync(require('node:path').join(dir, 'session.lock'), () => {
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  });
}
`, { mode: 0o700 });
let child, driverPid;
try {
  child = spawn(process.execPath, [new URL('../../src/agents/aider-entry.mjs', import.meta.url).pathname,
    '--new', '--once', '--prompt', 'fixture'], {
    cwd: project, env: { ...process.env, CONTEXT_BRIDGE_AIDER_PYTHON: python }, stdio: 'ignore',
  });
  const closed = once(child, 'close');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && Date.now() < deadline && child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(ready), 'entry must reach its real child-spawn boundary');
  driverPid = Number(fs.readFileSync(ready, 'utf8'));
  process.kill(child.pid, 0);
  process.kill(driverPid, 0);
  const id = projectIdentity(project).id;
  const preview = projectLifecycle(id, 'retire');
  const result = projectLifecycle(id, 'retire', { apply: true });
  console.log(JSON.stringify({ wrapperAlive: true, childAlive: true,
    blockers: preview.blockers, lifecycle: result.lifecycle }, null, 2));
  assert.equal(result.lifecycle, 'active', 'live entry must prevent retirement');
  assert.equal(projectOperations(id).length, 1);
  child.kill('SIGKILL');
  await closed;
  assert.equal(recoverProjectOperations(id, { apply: true }).removed.length, 0,
    'dead wrapper does not prove its child stopped writing');
  assert.equal(projectOperations(id).length, 1);
  process.kill(driverPid, 'SIGKILL');
  const recovered = recoverProjectOperations(id, { apply: true });
  assert.equal(recovered.removed.length, 1, JSON.stringify(recovered));
  assert.deepEqual(projectOperations(id), []);
  assert.equal(projectLifecycle(id, 'retire', { apply: true }).lifecycle, 'retired');
  console.log('PASS: active writer blocked, dead wrapper retained, stopped writer recovered');
} finally {
  if (child?.exitCode === null && child?.signalCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
  }
  if (driverPid) { try { process.kill(driverPid, 'SIGKILL'); } catch {} }
  if (savedTimeout === undefined) delete process.env.CONTEXT_BRIDGE_LOCK_TIMEOUT_MS;
  else process.env.CONTEXT_BRIDGE_LOCK_TIMEOUT_MS = savedTimeout;
  if (saved === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
  else process.env.CONTEXT_BRIDGE_HOME = saved;
  fs.rmSync(root, { recursive: true, force: true });
}
