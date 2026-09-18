import "../lane-environment.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { ensureState, writeCheckpoint } from '../../src/state.mjs';
import { exportArtifact } from '../../src/artifact.mjs';
import { sealArtifact, openSealedArtifact } from '../../src/sealed-artifact.mjs';
import { startArtifactServer, sendArtifact, fetchArtifact, removeRemoteArtifact } from '../../src/remote-artifact.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-public-tls-'));
const project = path.join(root, 'project'), home = path.join(root, 'home');
fs.mkdirSync(project); fs.mkdirSync(home);
process.env.CONTEXT_BRIDGE_HOME = path.join(root, 'runtime');
delete process.env.CONTEXT_BRIDGE_STORAGE;
let service, tunnel, closed;
const binary = process.argv[2];
assert.ok(binary && path.isAbsolute(binary), 'Supply the pinned cloudflared executable');
try {
  ensureState(project);
  writeCheckpoint(project, 'main', '2026-09-18T00-00-00-000Z-claude-to-codex-full.md',
    'Synthetic public transport acceptance. No user data.\n');
  const artifact = path.join(root, 'sample.cbctx');
  exportArtifact(project, artifact);
  const sealed = sealArtifact(artifact, path.join(root, 'sealed'));
  const store = path.join(root, 'store'), tokenFile = path.join(root, 'token');
  fs.mkdirSync(store, { mode: 0o700 });
  fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  service = await startArtifactServer({ directory: store, tokenFile });
  tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', service.endpoint], {
    cwd: root, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = new Promise(resolve => tunnel.once('close', resolve));
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Public tunnel startup deadline exceeded')), 60000);
    let log = '';
    const read = chunk => {
      log = (log + chunk).slice(-12000);
      const match = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    tunnel.stdout.on('data', read); tunnel.stderr.on('data', read);
    tunnel.once('error', error => { clearTimeout(timer); reject(error); });
    tunnel.once('close', code => { clearTimeout(timer); reject(new Error(`Tunnel exited before readiness: ${code}`)); });
  });
  console.log(JSON.stringify({ tunnelEndpoint: endpoint }));
  // Only read-only readiness requests retry; artifact mutations never do.
  let denied = false;
  const observations = new Set();
  const readinessDeadline = Date.now() + 120000;
  while (Date.now() < readinessDeadline) {
    try {
      const status = await new Promise((resolve, reject) => {
        const request = https.get(`${endpoint}/v1/artifacts/${sealed.hash}`, { signal: AbortSignal.timeout(5000) }, response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
          response.once('error', reject);
        });
        request.once('error', reject);
      });
      denied = status === 401;
      observations.add(`HTTP ${status}`);
      if (denied) break;
    } catch (error) { observations.add(error.cause?.code || error.code || error.name); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(denied, true, `public TLS must reach the authenticated origin: ${[...observations].join(', ')}`);
  const options = { endpoint, tokenFile };
  const sent = await sendArtifact(sealed.sealedFile, { ...options, apply: true });
  const fetched = path.join(root, 'fetched.cbsealed');
  await fetchArtifact(sent.hash, fetched, options);
  assert.deepEqual(fs.readFileSync(fetched), fs.readFileSync(sealed.sealedFile));
  const plain = path.join(root, 'opened.cbctx');
  openSealedArtifact(fetched, plain, { keyFile: sealed.keyFile });
  assert.deepEqual(fs.readFileSync(plain), fs.readFileSync(artifact));
  await removeRemoteArtifact(sent.hash, { ...options, apply: true });
  await assert.rejects(fetchArtifact(sent.hash, path.join(root, 'deleted.cbsealed'), options), /HTTP 404/);
  console.log(JSON.stringify({ publicHttps: true, anonymousDenied: true, ciphertextExact: true,
    localDecryptionExact: true, remoteDeletionVerified: true, credentialsLogged: false,
    dns: 'Runner system DNS; TLS certificate verification enabled',
    scope: 'Temporary real public TLS tunnel and synthetic data; not uptime, independent-client or physical-power-loss acceptance.' }));
} finally {
  if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
    tunnel.kill('SIGTERM');
    const timer = setTimeout(() => tunnel.kill('SIGKILL'), 5000);
    await closed; clearTimeout(timer);
  }
  if (service) {
    service.server.closeAllConnections();
    await new Promise(resolve => service.server.close(resolve));
  }
  fs.rmSync(root, { recursive: true, force: true });
}
