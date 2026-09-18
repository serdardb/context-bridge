import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { exportArtifact } from "../src/artifact.mjs";
import { sealArtifact, openSealedArtifact } from "../src/sealed-artifact.mjs";
import { ensureState, writeCheckpoint } from "../src/state.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sealed-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  ensureState(project);
  writeCheckpoint(project, "main", "2026-09-18T00-00-00-000Z-claude-to-codex-full.md", "Sensitive narrative retained for the intended recipient.");
  const input = path.join(root, "source.cbctx");
  exportArtifact(project, input);
  return { root, project, input };
}

test("sealed artifacts roundtrip through actual Git-less CLI with independent signature trust", () => {
  const { root, project, input } = fixture();
  try {
    const pair = crypto.generateKeyPairSync("ed25519");
    const privateFile = path.join(root, "sign.pem"), publicFile = path.join(root, "trust.pem");
    fs.writeFileSync(privateFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
    fs.writeFileSync(publicFile, pair.publicKey.export({ type: "spki", format: "pem" }));
    exportArtifact(project, input, { signKey: privateFile });
    const home = path.join(root, "unused-runtime");
    const run = args => spawnSync(process.execPath, [path.resolve("bin/bridge.mjs"), "artifact", ...args], {
      cwd: project, env: { ...process.env, PATH: "", CONTEXT_BRIDGE_HOME: home }, encoding: "utf8", timeout: 15000,
    });
    const bundle = path.join(root, "bundle");
    const refused = run(["seal", input, "--out", bundle]);
    assert.notEqual(refused.status, 0);
    assert.equal(fs.existsSync(bundle), false);
    const sealed = run(["seal", input, "--out", bundle, "--verify-key", publicFile, "--json"]);
    assert.equal(sealed.status, 0, sealed.stderr);
    const receipt = JSON.parse(sealed.stdout);
    const bytes = fs.readFileSync(receipt.sealedFile);
    assert.equal(bytes.includes(Buffer.from("Sensitive narrative")), false);
    assert.equal(sealed.stdout.includes(fs.readFileSync(receipt.keyFile).toString("base64")), false);
    const output = path.join(root, "opened.cbctx");
    assert.notEqual(run(["open", receipt.sealedFile, "--key-file", receipt.keyFile, "--out", output]).status, 0);
    assert.equal(fs.existsSync(output), false);
    const opened = run(["open", receipt.sealedFile, "--key-file", receipt.keyFile, "--out", output, "--verify-key", publicFile]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(input));
    assert.notEqual(run(["open", receipt.sealedFile, "--key-file", receipt.keyFile, "--out", output, "--verify-key", publicFile]).status, 0);
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(input));
    assert.equal(fs.existsSync(home), false);
    assert.deepEqual(fs.readdirSync(project), []);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(bundle).mode & 0o777, 0o700);
      for (const file of [receipt.keyFile, receipt.sealedFile, output]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("sealed input corruption, unsafe leaves and failed publication never publish plaintext or replace a bundle", () => {
  const { root, input } = fixture();
  try {
    const bundle = path.join(root, "bundle");
    const receipt = sealArtifact(input, bundle);
    const original = fs.readFileSync(receipt.sealedFile);
    const originalKey = fs.readFileSync(receipt.keyFile);
    assert.throws(() => sealArtifact(input, bundle));
    assert.deepEqual(fs.readFileSync(receipt.keyFile), originalKey);
    assert.deepEqual(fs.readFileSync(receipt.sealedFile), original);
    const output = path.join(root, "opened.cbctx");
    const corrupt = path.join(root, "bad.cbsealed");
    const envelope = JSON.parse(original);
    for (const field of ["sealedVersion", "algorithm", "nonce", "tag", "ciphertext", "extra"]) {
      fs.writeFileSync(corrupt, JSON.stringify({ ...envelope, [field]: "invalid" }));
      assert.throws(() => openSealedArtifact(corrupt, output, { keyFile: receipt.keyFile }), { code: "BRIDGE_SEALED_INVALID" });
      assert.equal(fs.existsSync(output), false);
    }
    // Valid shape and untouched ciphertext: only GCM authentication can reject it.
    const badTag = Buffer.from(envelope.tag, "base64");
    badTag[0] ^= 1;
    fs.writeFileSync(corrupt, JSON.stringify({ ...envelope, tag: badTag.toString("base64") }));
    assert.throws(() => openSealedArtifact(corrupt, output, { keyFile: receipt.keyFile }), { code: "BRIDGE_SEALED_INVALID" });
    assert.equal(fs.existsSync(output), false);
    fs.writeFileSync(receipt.keyFile, crypto.randomBytes(32));
    assert.throws(() => openSealedArtifact(receipt.sealedFile, output, { keyFile: receipt.keyFile }), { code: "BRIDGE_SEALED_INVALID" });
    fs.writeFileSync(receipt.keyFile, originalKey);
    const oversized = path.join(root, "oversized");
    const fd = fs.openSync(oversized, "wx");
    try { fs.ftruncateSync(fd, 24 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
    assert.throws(() => openSealedArtifact(oversized, output, { keyFile: receipt.keyFile }), { code: "BRIDGE_SEALED_INVALID" });
    assert.throws(() => sealArtifact(oversized, path.join(root, "too-large")), { code: "BRIDGE_SEALED_INVALID" });
    assert.equal(fs.existsSync(path.join(root, "too-large")), false);
    const linked = path.join(root, "linked");
    fs.linkSync(receipt.sealedFile, linked);
    assert.throws(() => openSealedArtifact(linked, output, { keyFile: receipt.keyFile }), { code: "BRIDGE_SEALED_INVALID" });
    fs.unlinkSync(linked);
    fs.symlinkSync(receipt.sealedFile, linked);
    assert.throws(() => openSealedArtifact(linked, output, { keyFile: receipt.keyFile }), { code: "BRIDGE_SEALED_INVALID" });
    fs.unlinkSync(linked);
    const sync = fs.fsyncSync;
    try {
      fs.fsyncSync = () => { throw Object.assign(new Error("injected flush failure"), { code: "EIO" }); };
      assert.throws(() => sealArtifact(input, path.join(root, "failed")), { code: "EIO" });
      assert.throws(() => openSealedArtifact(receipt.sealedFile, output, { keyFile: receipt.keyFile }), { code: "EIO" });
    } finally { fs.fsyncSync = sync; }
    assert.equal(fs.existsSync(output), false);
    assert.equal(fs.existsSync(path.join(root, "failed")), false);
    assert.equal(fs.readdirSync(root).some(name => name.startsWith(".bridge-seal-")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
