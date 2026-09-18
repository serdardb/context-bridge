// Opt-in multi-process quota and interrupted publication acceptance.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startArtifactServer, sendArtifact, fetchArtifact } from "../../src/remote-artifact.mjs";
import { sealArtifact, MAX_ENVELOPE_BYTES, MAX_SEALED_PLAINTEXT_BYTES } from "../../src/sealed-artifact.mjs";
import { publication } from "../../src/publication.mjs";
import { ensureState, writeCheckpoint } from "../../src/state.mjs";
import { exportArtifact } from "../../src/artifact.mjs";

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === "--worker") {
  const [directory, tokenFile, quota, mode, marker] = process.argv.slice(3);
  if (mode === "barrier") {
    const canonicalDirectory = fs.realpathSync(directory);
    const { observeKernelContention } = await import("../helpers/observe-kernel-contention.mjs");
    observeKernelContention(() => fs.writeFileSync(`${marker}.blocked`, "blocked"));
    const open = fs.openSync;
    fs.openSync = (file, ...args) => {
      if (typeof file === "string" && path.dirname(file) === canonicalDirectory && /^\.[a-f0-9]{64}\.tmp-/.test(path.basename(file))) {
        // Pause before creating any temporary record: quota cannot accidentally
        // be protected by another writer's already-visible staging bytes.
        fs.writeFileSync(`${marker}.ready`, "ready");
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(path.join(path.dirname(marker), "release"))) {
          if (Date.now() > deadline) throw new Error("Publication barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return open(file, ...args);
    };
  } else if (mode.startsWith("crash-")) {
    const fault = Number(mode.slice(6));
    let calls = 0;
    for (const [object, name] of [[fs, "writeFileSync"], [fs, "fsyncSync"], [publication, "renameExclusive"]]) {
      const original = object[name];
      object[name] = (...args) => {
        const result = original(...args);
        if (++calls === fault) process.exit(79);
        return result;
      };
    }
  }
  const { server, endpoint } = await startArtifactServer({ directory, tokenFile, quotaBytes: Number(quota) });
  process.send({ endpoint });
  await new Promise(resolve => {
    process.once("SIGTERM", () => { server.close(resolve); server.closeAllConnections(); });
  });
  process.disconnect();
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-remote-store-"));
  const previous = process.env.CONTEXT_BRIDGE_HOME;
  const previousMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = path.join(root, "runtime");
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  const workers = [];
  const start = async (directory, tokenFile, quota, mode = "normal", marker = "unused") => {
    const child = spawn(process.execPath, [self, "--worker", directory, tokenFile, String(quota), mode, marker], {
      env: { ...process.env, PATH: "" }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    const closed = new Promise(resolve => child.once("close", status => resolve({ status, stderr })));
    workers.push({ child, closed });
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup deadline")), 5000);
      child.once("message", message => { clearTimeout(timer); resolve(message.endpoint); });
      child.once("close", () => { clearTimeout(timer); reject(new Error(stderr || "Early worker exit")); });
    });
    return { child, closed, endpoint, tokenFile, allowLoopbackHttp: true, apply: true };
  };
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < deadline, "Barrier observation deadline"); await delay(5); }
  };
  try {
    const project = path.join(root, "project"); fs.mkdirSync(project);
    const tokenFile = path.join(root, "token"); fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    ensureState(project);
    writeCheckpoint(project, "main", "2026-09-18T00-00-00-000Z-claude-to-codex-full.md", "Synthetic shared-quota and process-exit acceptance.");
    const artifact = path.join(root, "source.cbctx"); exportArtifact(project, artifact);
    const first = sealArtifact(artifact, path.join(root, "first"));
    const second = sealArtifact(artifact, path.join(root, "second"));
    const quota = JSON.stringify({ version: 1, expiresAt: Date.now() + 86400000,
      envelope: fs.readFileSync(first.sealedFile).toString("base64") }).length + 10;
    const racing = path.join(root, "racing"); fs.mkdirSync(racing, { mode: 0o700 });
    const markerA = path.join(root, "a"), markerB = path.join(root, "b");
    const a = await start(racing, tokenFile, quota, "barrier", markerA);
    const b = await start(racing, tokenFile, quota, "barrier", markerB);
    const capture = promise => promise.then(value => ({ value }), error => ({ error }));
    const sendA = capture(sendArtifact(first.sealedFile, a));
    await until(() => fs.existsSync(`${markerA}.ready`));
    const sendB = capture(sendArtifact(second.sealedFile, b));
    await until(() => fs.existsSync(`${markerB}.blocked`) || fs.existsSync(`${markerB}.ready`));
    assert.equal(fs.existsSync(`${markerB}.blocked`), true, "second process must contend on the actual kernel guard");
    fs.writeFileSync(path.join(root, "release"), "release");
    const outcomes = await Promise.all([sendA, sendB]);
    assert.ok(outcomes[0].value);
    assert.match(outcomes[1].error?.message ?? "", /HTTP 507/);
    const records = fs.readdirSync(racing).filter(name => /^[a-f0-9]{64}$/.test(name));
    assert.deepEqual(records, [first.hash]);
    assert.ok(fs.statSync(path.join(racing, first.hash)).size <= quota);

    // Windows has file write/flush and exclusive rename, but no directory fsync.
    const exitBoundaries = process.platform === "win32" ? 3 : 4;
    for (let fault = 1; fault <= exitBoundaries; fault++) {
      const directory = path.join(root, `crash-${fault}`); fs.mkdirSync(directory, { mode: 0o700 });
      const crashed = await start(directory, tokenFile, 1024 * 1024, `crash-${fault}`);
      await assert.rejects(sendArtifact(first.sealedFile, crashed));
      assert.equal((await crashed.closed).status, 79, "fault must terminate the real server");
      const file = path.join(directory, first.hash);
      const existing = fs.existsSync(file) ? fs.readFileSync(file) : null;
      assert.equal(Boolean(existing), fault >= 3, "record visibility follows the atomic rename boundary");
      const recovered = await start(directory, tokenFile, 1024 * 1024);
      if (!existing) await assert.rejects(fetchArtifact(first.hash, path.join(root, `absent-${fault}`), recovered), /HTTP 404/);
      await sendArtifact(first.sealedFile, recovered);
      const downloaded = path.join(root, `recovered-${fault}.cbsealed`);
      await fetchArtifact(first.hash, downloaded, recovered);
      assert.deepEqual(fs.readFileSync(downloaded), fs.readFileSync(first.sealedFile));
      if (existing) assert.deepEqual(fs.readFileSync(file), existing, "retry must retain original expiry and bytes");
    }

    const largeDirectory = path.join(root, "large"); fs.mkdirSync(largeDirectory, { mode: 0o700 });
    const large = await start(largeDirectory, tokenFile, MAX_ENVELOPE_BYTES * 3);
    // Transport validates shape, not authenticity. Padding isolates the wire
    // boundary while the synthetic ciphertext exercises its independent limit.
    const envelope = Buffer.from(JSON.stringify({ sealedVersion: 1, algorithm: "aes-256-gcm",
      nonce: Buffer.alloc(12).toString("base64"), tag: Buffer.alloc(16).toString("base64"),
      ciphertext: Buffer.alloc(MAX_SEALED_PLAINTEXT_BYTES).toString("base64") }));
    const maximum = Buffer.alloc(MAX_ENVELOPE_BYTES, 32); envelope.copy(maximum);
    const maximumFile = path.join(root, "maximum.cbsealed"); fs.writeFileSync(maximumFile, maximum);
    const maximumSent = await sendArtifact(maximumFile, large);
    const maximumDownload = path.join(root, "maximum-downloaded.cbsealed");
    await fetchArtifact(maximumSent.hash, maximumDownload, large);
    assert.deepEqual(fs.readFileSync(maximumDownload), maximum);
    const oversized = Buffer.concat([maximum, Buffer.from(" ")]);
    const oversizedHash = crypto.createHash("sha256").update(oversized).digest("hex");
    for (const chunked of [false, true]) {
      const status = await new Promise((resolve, reject) => {
        const req = http.request(`${large.endpoint}/v1/artifacts/${oversizedHash}`, { method: "PUT", headers: {
          Authorization: `Bearer ${fs.readFileSync(tokenFile, "utf8")}`, "X-Bridge-TTL": "60",
          ...(chunked ? {} : { "Content-Length": oversized.length }),
        } }, res => { res.resume(); res.once("end", () => resolve(res.statusCode)); res.once("error", reject); });
        req.setTimeout(10000, () => req.destroy(new Error("Upload boundary deadline")));
        req.once("error", reject);
        // Explicit writes force chunked encoding when no Content-Length exists.
        req.write(maximum); req.end(Buffer.from(" "));
      });
      assert.equal(status, 413, "server must bound both declared and chunked uploads");
      assert.equal(fs.existsSync(path.join(largeDirectory, oversizedHash)), false);
    }
    assert.deepEqual(fs.readdirSync(largeDirectory).sort(), [".share.guard", maximumSent.hash].sort());
    assert.deepEqual(fs.readdirSync(project), []);
    console.log(JSON.stringify({ passed: true, platform: process.platform, arch: process.arch, node: process.version,
      crossProcessQuota: true, actualKernelContention: true, serverExitBoundaries: exitBoundaries, restartRoundtrip: true,
      maximumUploadRoundtripBytes: maximum.length, oversizedDeclaredAndChunked: "413 without publication",
      scope: "two cooperating processes, observed atomic publication boundaries; not distributed quota, hostile directory races or power loss" }, null, 2));
  } finally {
    for (const { child, closed } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = previous;
    if (previousMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = previousMode;
  }
}
