// Opt-in actual TLS, streaming bounds and wall-deadline acceptance.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureState, writeCheckpoint } from "../../src/state.mjs";
import { exportArtifact } from "../../src/artifact.mjs";
import { sealArtifact, MAX_ENVELOPE_BYTES } from "../../src/sealed-artifact.mjs";
import { startArtifactServer } from "../../src/remote-artifact.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sharing-tls-"));
const previous = process.env.CONTEXT_BRIDGE_HOME;
const previousMode = process.env.CONTEXT_BRIDGE_STORAGE;
process.env.CONTEXT_BRIDGE_HOME = path.join(root, "runtime");
delete process.env.CONTEXT_BRIDGE_STORAGE;
const cli = fileURLToPath(new URL("../../bin/bridge.mjs", import.meta.url));
const servers = [];
const project = path.join(root, "project"), directory = path.join(root, "store");
const certificate = path.join(root, "cert.pem"), key = path.join(root, "tls-key.pem");
const tokenFile = path.join(root, "token");
const command = (args, trusted = true) => new Promise(resolve => {
  const env = { ...process.env, PATH: "", NODE_TLS_REJECT_UNAUTHORIZED: "1",
    CONTEXT_BRIDGE_HOME: path.join(root, "unused-client-runtime") };
  if (trusted) env.NODE_EXTRA_CA_CERTS = certificate;
  else delete env.NODE_EXTRA_CA_CERTS;
  const child = spawn(process.execPath, [cli, "share", ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", forced = false;
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 45000);
  child.once("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr, forced }); });
});

try {
  fs.mkdirSync(project); fs.mkdirSync(directory, { mode: 0o700 });
  const config = path.join(root, "openssl.cnf");
  fs.writeFileSync(config, "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=bridge-local-acceptance\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n");
  const supplied = process.argv[2];
  if (supplied) {
    assert.ok(path.isAbsolute(supplied), "optional synthetic TLS fixture directory must be absolute");
    fs.copyFileSync(path.join(supplied, "cert.pem"), certificate);
    fs.copyFileSync(path.join(supplied, "key.pem"), key);
    fs.chmodSync(key, 0o600);
  } else {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-config", config, "-keyout", key, "-out", certificate], { stdio: "ignore", timeout: 30000 });
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  ensureState(project);
  writeCheckpoint(project, "main", "2026-09-18T00-00-00-000Z-claude-to-codex-full.md", "Synthetic TLS acceptance; no user conversation.");
  const artifact = path.join(root, "source.cbctx");
  exportArtifact(project, artifact);
  const sealed = sealArtifact(artifact, path.join(root, "bundle"));
  const backend = await startArtifactServer({ directory, tokenFile }); servers.push(backend.server);
  let mode = "forward", requests = 0;
  const proxy = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(certificate) }, (req, res) => {
    requests++;
    if (mode === "stall") return;
    if (mode === "oversize") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      // No Content-Length: the client must count the bytes actually received.
      res.end(Buffer.alloc(MAX_ENVELOPE_BYTES + 1, 65)); return;
    }
    const upstream = http.request(new URL(req.url, backend.endpoint), { method: req.method, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve)); servers.push(proxy);
  const endpoint = `https://127.0.0.1:${proxy.address().port}`;
  const common = ["--endpoint", endpoint, "--token-file", tokenFile, "--json"];
  const untrusted = await command(["send", sealed.sealedFile, ...common, "--apply"], false);
  assert.equal(untrusted.status, 1); assert.equal(untrusted.forced, false);
  assert.equal(requests, 0, "untrusted TLS must fail before an HTTP request reaches the proxy");
  const sent = await command(["send", sealed.sealedFile, ...common, "--apply"]);
  assert.equal(sent.status, 0, sent.stderr);
  const downloaded = path.join(root, "downloaded.cbsealed");
  const fetched = await command(["fetch", sealed.hash, ...common, "--out", downloaded]);
  assert.equal(fetched.status, 0, fetched.stderr);
  assert.deepEqual(fs.readFileSync(downloaded), fs.readFileSync(sealed.sealedFile));
  mode = "oversize";
  const oversized = await command(["fetch", sealed.hash, ...common, "--out", path.join(root, "oversize")]);
  assert.equal(oversized.status, 1); assert.match(oversized.stderr, /byte limit/);
  assert.equal(oversized.forced, false); assert.equal(fs.existsSync(path.join(root, "oversize")), false);

  // Exercise both real 30-second timers in one wall-clock interval.
  mode = "stall";
  const started = Date.now();
  const slowUpload = http.request(`${backend.endpoint}/v1/artifacts/${"0".repeat(64)}`, { method: "PUT", headers: {
    Authorization: `Bearer ${token}`, "X-Bridge-TTL": "60", "Content-Length": "10000",
  } });
  slowUpload.on("error", () => {});
  const uploadClosed = new Promise(resolve => slowUpload.once("close", () => resolve(Date.now() - started)));
  const uploadFallback = setTimeout(() => slowUpload.destroy(), 45000);
  slowUpload.write("incomplete");
  const deadline = await command(["fetch", sealed.hash, ...common, "--out", path.join(root, "stalled")]);
  const uploadMs = await uploadClosed; clearTimeout(uploadFallback);
  assert.equal(deadline.status, 1); assert.match(deadline.stderr, /deadline/);
  assert.equal(deadline.forced, false);
  assert.ok(uploadMs >= 29000 && uploadMs < 40000, `server upload deadline: ${uploadMs}ms`);
  assert.equal(fs.existsSync(path.join(directory, "0".repeat(64))), false);
  assert.equal(fs.existsSync(path.join(root, "stalled")), false);
  for (const result of [untrusted, sent, fetched, oversized, deadline]) assert.equal((result.stdout + result.stderr).includes(token), false);
  assert.equal(fs.existsSync(path.join(root, "unused-client-runtime")), false);
  assert.deepEqual(fs.readdirSync(project), []);
  console.log(JSON.stringify({ passed: true, platform: process.platform, arch: process.arch, node: process.version,
    untrustedTlsRefused: true, trustedTlsRoundtrip: true, chunkedResponseLimit: true,
    clientDeadline: true, serverUploadDeadlineMs: uploadMs, credentialsInOutput: false,
    scope: "real local TLS proxy and actual CLI on the reported platform, ephemeral certificate trust; not public deployment or general load acceptance" }, null, 2));
} finally {
  for (const server of servers.reverse()) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = previous;
  if (previousMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = previousMode;
}
