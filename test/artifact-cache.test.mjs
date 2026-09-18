import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { cacheArtifact, exportArtifact, importArtifact, verifyArtifact } from "../src/artifact.mjs";

test("artifact cache is global, idempotent, content-addressed and verifies every read", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-content-address-"));
  const home = path.join(root, "home"), source = path.join(root, "source"), target = path.join(root, "target");
  fs.mkdirSync(source); fs.mkdirSync(target);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    const file = path.join(root, "context.cbctx");
    exportArtifact(source, file);
    const original = fs.readFileSync(file);
    const cached = cacheArtifact(file);
    if (process.platform !== "win32") {
      for (const dir of [home, path.join(home, "artifacts"), path.join(home, "artifacts", "sha256")]) {
        assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "durable cache creation retains private directory permissions");
      }
    }
    assert.equal(cached.reference, `sha256:${crypto.createHash("sha256").update(original).digest("hex")}`);
    assert.equal(cached.path, path.join(home, "artifacts", "sha256", cached.reference.slice(7) + ".cbctx"));
    assert.equal(cached.created, true);
    assert.equal(cacheArtifact(file).created, false);
    assert.equal(cacheArtifact(cached.reference).created, false);
    assert.deepEqual(fs.readdirSync(source), []);
    assert.deepEqual(fs.readdirSync(home), ["artifacts"], "cache must not register a project or require Git");
    const cli = path.resolve("bin/bridge.mjs");
    const imported = spawnSync(process.execPath, [cli, "artifact", "import", cached.reference, "--apply", "--json"], {
      cwd: target, env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 15000,
    });
    assert.equal(imported.status, 0, imported.stderr);
    assert.deepEqual(fs.readdirSync(target), []);
    const changedBytes = Buffer.concat([original, Buffer.from("\n")]);
    fs.writeFileSync(cached.path, changedBytes);
    assert.throws(() => verifyArtifact(cached.reference), /does not match/);
    assert.throws(() => cacheArtifact(file), /different bytes/);
    assert.deepEqual(fs.readFileSync(cached.path), changedBytes);
    fs.unlinkSync(cached.path);
    fs.symlinkSync(file, cached.path);
    assert.throws(() => verifyArtifact(cached.reference), /symlinked/);
    assert.throws(() => cacheArtifact(file), /symlinked/);
    assert.deepEqual(fs.readFileSync(file), original);
    fs.unlinkSync(cached.path);

    const launch = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "artifact", "cache", file, "--json"], {
        cwd: source, env: { ...process.env, PATH: "" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      child.stdout.on("data", (data) => { out += data; });
      child.stderr.on("data", (data) => { err += data; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
    });
    const racers = await Promise.all([launch(), launch()]);
    assert.deepEqual(racers.map((item) => item.created).sort(), [false, true]);
    assert.equal(racers[0].reference, racers[1].reference);
    assert.deepEqual(fs.readFileSync(cached.path), original);
    assert.deepEqual(fs.readdirSync(path.dirname(cached.path)), [path.basename(cached.path)]);
    for (const bad of ["sha256:../escape", "sha256:", "sha256:" + "f".repeat(63)]) {
      assert.throws(() => importArtifact(bad, { projectDir: target, apply: true }), /Invalid artifact content reference/);
    }
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cached signatures still require external trust on every import", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cache-signature-"));
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const home = path.join(root, "home");
  process.env.CONTEXT_BRIDGE_HOME = home;
  try {
    const pair = crypto.generateKeyPairSync("ed25519");
    const privateFile = path.join(root, "sign.pem"), publicFile = path.join(root, "verify.pem");
    fs.writeFileSync(privateFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(publicFile, pair.publicKey.export({ type: "spki", format: "pem" }));
    const file = path.join(root, "signed.cbctx");
    exportArtifact(root, file, { signKey: privateFile });
    assert.throws(() => cacheArtifact(file), /explicitly trusted/);
    assert.equal(fs.existsSync(home), false);
    const cached = cacheArtifact(file, { verifyKey: publicFile });
    assert.throws(() => importArtifact(cached.reference), /explicitly trusted/);
    assert.equal(importArtifact(cached.reference, { verifyKey: publicFile }).artifact.signature.algorithm, "Ed25519");
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("artifact cache validates before creating storage and refuses linked store directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cache-trust-"));
  const home = path.join(root, "home"), outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  process.env.CONTEXT_BRIDGE_HOME = home;
  try {
    const file = path.join(root, "invalid.cbctx");
    fs.writeFileSync(file, "{}");
    assert.throws(() => cacheArtifact(file), /invalid context artifact/);
    assert.equal(fs.existsSync(home), false);
    exportArtifact(root, file);
    fs.mkdirSync(home);
    fs.symlinkSync(outside, path.join(home, "artifacts"));
    assert.throws(() => cacheArtifact(file), /Unsafe artifact store/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
