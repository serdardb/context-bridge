import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ensureState, writeCheckpoint } from "../src/state.mjs";
import { exportArtifact } from "../src/artifact.mjs";
import { sealArtifact, openSealedArtifact } from "../src/sealed-artifact.mjs";
import { startArtifactServer, sendArtifact, fetchArtifact, removeRemoteArtifact } from "../src/remote-artifact.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-remote-"));
  const project = path.join(root, "project"), directory = path.join(root, "store");
  fs.mkdirSync(project); fs.mkdirSync(directory, { mode: 0o700 });
  ensureState(project);
  writeCheckpoint(project, "main", "2026-09-18T00-00-00-000Z-claude-to-codex-full.md", "Synthetic PRIVATE_CONTEXT never visible to the opaque server.");
  const artifact = path.join(root, "source.cbctx"), tokenFile = path.join(root, "token");
  exportArtifact(project, artifact);
  const sealed = sealArtifact(artifact, path.join(root, "bundle"));
  fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  return { root, project, directory, artifact, tokenFile, ...sealed };
}

function cli(cwd, args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.resolve("bin/bridge.mjs"), ...args], {
      cwd, env: { ...process.env, PATH: "", ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

async function cliServer(f) {
  const child = spawn(process.execPath, [path.resolve("bin/bridge.mjs"), "share", "serve", "--dir", f.directory,
    "--token-file", f.tokenFile, "--json"], { cwd: f.project,
    env: { ...process.env, PATH: "", CONTEXT_BRIDGE_HOME: path.join(f.root, "unused-runtime") }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  let stdout = "", stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server readiness timed out")), 5000);
      child.once("close", () => { clearTimeout(timer); reject(new Error(stderr || "Server exited before readiness")); });
      child.stdout.on("data", data => {
        stdout += data;
        if (stdout.includes("\n")) {
          clearTimeout(timer);
          try { resolve(JSON.parse(stdout.split("\n")[0]).endpoint); } catch (error) { reject(error); }
        }
      });
    });
    return { endpoint, stop: async () => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { assert.equal(await closed, 0, stderr); } finally { clearTimeout(timer); }
    } };
  } catch (error) { child.kill("SIGKILL"); await closed; throw error; }
}

test("real remote CLI keeps sharing explicit, opaque, expiring and separate from import", async () => {
  const f = fixture();
  let service;
  try {
    const unavailable = path.join(f.root, "missing-native.cjs");
    fs.writeFileSync(unavailable, `const Module = require('node:module');
const load = Module._load;
Module._load = function(name, ...args) {
  if (name === 'koffi') throw Object.assign(new Error('synthetic missing native backend'), { code: 'MODULE_NOT_FOUND' });
  return load.call(this, name, ...args);
};`);
    const refused = await cli(f.project, ["share", "serve", "--dir", f.directory,
      "--token-file", f.tokenFile, "--json"], {
      NODE_OPTIONS: `--require=${unavailable}`, CONTEXT_BRIDGE_HOME: path.join(f.root, "unused-runtime"),
    });
    assert.equal(refused.status, 1, "unusable storage must refuse before reporting a listening server");
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /Native locking is unavailable/);
    assert.match(refused.stderr, /bridge doctor --json/);
    assert.equal(refused.stderr.includes("synthetic missing native backend"), false);
    assert.deepEqual(fs.readdirSync(f.directory), []);
    const started = await cliServer(f); service = started;
    const options = { endpoint: started.endpoint, tokenFile: f.tokenFile, allowLoopbackHttp: true };
    const env = { CONTEXT_BRIDGE_HOME: path.join(f.root, "unused-runtime") };
    const common = ["--endpoint", started.endpoint, "--allow-loopback-http", "--token-file", f.tokenFile, "--json"];
    const preview = await cli(f.project, ["share", "send", f.sealedFile, ...common], env);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).applied, false);
    assert.deepEqual(fs.readdirSync(f.directory), [".share.guard"]);
    const sent = await cli(f.project, ["share", "send", f.sealedFile, ...common, "--apply"], env);
    assert.equal(sent.status, 0, sent.stderr);
    const hash = JSON.parse(sent.stdout).hash;
    assert.equal(hash, f.hash);
    const stored = fs.readFileSync(path.join(f.directory, hash), "utf8");
    assert.equal(stored.includes("PRIVATE_CONTEXT"), false);
    assert.equal(stored.includes(fs.readFileSync(f.keyFile).toString("base64")), false);
    assert.equal(stored.includes(fs.readFileSync(f.tokenFile, "utf8")), false);
    const downloaded = path.join(f.root, "downloaded.cbsealed");
    const fetched = await cli(f.project, ["share", "fetch", hash, ...common, "--out", downloaded], env);
    assert.equal(fetched.status, 0, fetched.stderr);
    assert.deepEqual(fs.readFileSync(downloaded), fs.readFileSync(f.sealedFile));
    const output = path.join(f.root, "opened.cbctx");
    openSealedArtifact(downloaded, output, { keyFile: f.keyFile });
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(f.artifact));
    assert.equal(fs.existsSync(env.CONTEXT_BRIDGE_HOME), false);
    assert.deepEqual(fs.readdirSync(f.project), []);
    const repeated = await sendArtifact(f.sealedFile, { ...options, apply: true });
    assert.equal(repeated.hash, hash);
    assert.equal(fs.readFileSync(path.join(f.directory, hash), "utf8"), stored, "retry must not extend retention");
    await removeRemoteArtifact(hash, options);
    assert.equal(fs.existsSync(path.join(f.directory, hash)), true, "remove preview must not contact the store");
    await removeRemoteArtifact(hash, { ...options, apply: true });
    assert.equal(fs.existsSync(path.join(f.directory, hash)), false);
    await sendArtifact(f.sealedFile, { ...options, apply: true, ttl: 1 });
    await delay(1100);
    await assert.rejects(fetchArtifact(hash, path.join(f.root, "expired"), options), /HTTP 404/);
    await assert.rejects(sendArtifact(f.sealedFile, { ...options, apply: true }), /HTTP 409/);
    assert.equal(fs.existsSync(path.join(f.root, "expired")), false);
  } finally {
    await service?.stop();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("remote boundaries reject plaintext, unauthorized traffic, quota excess and redirected or altered downloads", async () => {
  const f = fixture();
  const servers = [];
  try {
    const service = await startArtifactServer({ ...f, quotaBytes: 1 }); servers.push(service.server);
    const options = { endpoint: service.endpoint, tokenFile: f.tokenFile, allowLoopbackHttp: true, apply: true };
    await assert.rejects(sendArtifact(f.artifact, options), /sealed envelope/);
    await assert.rejects(sendArtifact(f.keyFile, options), /sealed envelope/);
    await assert.rejects(sendArtifact(f.sealedFile, { ...options, allowLoopbackHttp: false }), /HTTPS/);
    await assert.rejects(sendArtifact(f.sealedFile, { ...options, endpoint: "https://user:password@example.test/" }), /HTTPS/);
    const wrong = path.join(f.root, "wrong-token"); fs.writeFileSync(wrong, "a".repeat(64), { mode: 0o600 });
    await assert.rejects(sendArtifact(f.sealedFile, { ...options, tokenFile: wrong }), /HTTP 401/);
    await assert.rejects(sendArtifact(f.sealedFile, options), /HTTP 507/);
    assert.equal(fs.existsSync(path.join(f.directory, f.hash)), false);
    let response = "redirect", requests = 0;
    const hostile = http.createServer((req, res) => {
      requests++;
      if (response === "redirect") res.writeHead(302, { Location: `${service.endpoint}/v1/artifacts/${f.hash}` }).end("private-token-in-body");
      else res.end("changed ciphertext");
    });
    await new Promise(resolve => hostile.listen(0, "127.0.0.1", resolve)); servers.push(hostile);
    const destination = path.join(f.root, "download");
    const hostileOptions = { ...options, endpoint: `http://127.0.0.1:${hostile.address().port}` };
    await assert.rejects(fetchArtifact(f.hash, destination, hostileOptions), error => /HTTP 302/.test(error.message) && !error.message.includes("private-token"));
    assert.equal(requests, 1);
    response = "altered";
    await assert.rejects(fetchArtifact(f.hash, destination, hostileOptions), /does not match/);
    assert.equal(fs.existsSync(destination), false);
    const interrupted = http.request(`${service.endpoint}/v1/artifacts/${f.hash}`, { method: "PUT", headers: {
      Authorization: `Bearer ${fs.readFileSync(f.tokenFile, "utf8")}`, "X-Bridge-TTL": "60", "Content-Length": "10000",
    } });
    interrupted.on("error", () => {});
    const closed = new Promise(resolve => interrupted.once("close", resolve));
    interrupted.write("partial");
    await delay(30); interrupted.destroy(); await closed;
    assert.equal(fs.existsSync(path.join(f.directory, f.hash)), false);
  } finally {
    for (const server of servers) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
