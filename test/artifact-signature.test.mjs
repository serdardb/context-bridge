import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { exportArtifact, importArtifact, verifyArtifact } from "../src/artifact.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

test("signed artifacts require caller trust and reject rehashed tampering before touching the target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-signature-"));
  const source = path.join(root, "source"), target = path.join(root, "target");
  fs.mkdirSync(source); fs.mkdirSync(target);
  const pair = () => crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  try {
    const keys = pair();
    const signing = path.join(root, "private.pem"), trusted = path.join(root, "public.pem"), wrong = path.join(root, "other.pem");
    fs.writeFileSync(signing, keys.privateKey, { mode: 0o600 });
    fs.writeFileSync(trusted, keys.publicKey);
    fs.writeFileSync(wrong, pair().publicKey);
    const file = path.join(root, "signed.cbctx");
    const result = exportArtifact(source, file, { signKey: signing });
    assert.equal(result.signed, true);
    const original = verifyArtifact(file, { verifyKey: trusted });
    const payload = Object.fromEntries(Object.entries(original).filter(([key]) => !["integrity", "signature"].includes(key)));
    assert.equal(crypto.verify(null, Buffer.from(`context-bridge:artifact:v1\n${JSON.stringify(canonical(payload))}`),
      keys.publicKey, Buffer.from(original.signature.value, "base64")), true);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /PRIVATE KEY/);
    assert.throws(() => verifyArtifact(file), /explicitly trusted/);
    assert.throws(() => importArtifact(file, { projectDir: target, apply: true, verifyKey: wrong }), /verification failed/);
    assert.deepEqual(fs.readdirSync(target), []);
    for (const kind of ["removed", "changed", "algorithm", "value", "fingerprint"]) {
      const artifact = structuredClone(original);
      if (kind === "removed") delete artifact.signature;
      if (kind === "changed") {
        artifact.context = "an attacker changed the handoff and recomputed its hash";
        const changed = Object.fromEntries(Object.entries(artifact).filter(([key]) => !["integrity", "signature"].includes(key)));
        artifact.integrity.payload = crypto.createHash("sha256").update(JSON.stringify(canonical(changed))).digest("hex");
      }
      if (kind === "algorithm") artifact.signature.algorithm = "RSA";
      if (kind === "value") artifact.signature.value = Buffer.alloc(64).toString("base64");
      if (kind === "fingerprint") artifact.signature.keyId = "not-the-trusted-key";
      fs.writeFileSync(file, JSON.stringify(artifact));
      assert.throws(() => importArtifact(file, { projectDir: target, apply: true, verifyKey: trusted }), /signature/i, kind);
      assert.deepEqual(fs.readdirSync(target), [], "rejected signatures must precede initialization");
    }
    fs.writeFileSync(file, JSON.stringify(original));
    const cli = path.resolve("bin/bridge.mjs");
    for (const [cwd, args] of [[source, ["artifact", "export", "--sign-key", signing, file]],
      [target, ["artifact", "import", file, "--verify-key", trusted, "--apply"]]]) {
      const run = spawnSync(process.execPath, [cli, ...args, "--json"], {
        cwd, env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 15000,
      });
      assert.equal(run.status, 0, run.stderr);
    }
    assert.equal(verifyArtifact(file, { verifyKey: trusted }).signature.algorithm, "Ed25519");
    const before = fs.readFileSync(file);
    assert.throws(() => exportArtifact(source, file, { signKey: wrong }), /private signing/);
    assert.deepEqual(fs.readFileSync(file), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unsigned artifacts remain usable but cannot satisfy an explicit trusted-key requirement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-unsigned-"));
  try {
    const file = path.join(root, "plain.cbctx");
    exportArtifact(root, file);
    assert.equal(verifyArtifact(file).signature, undefined);
    assert.throws(() => verifyArtifact(file, { verifyKey: "unused.pem" }), /signature is required/);
    assert.throws(() => verifyArtifact(file, { verifyKey: "" }), /non-empty trusted/);
    assert.throws(() => exportArtifact(root, file, { signKey: "" }), /non-empty private/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
