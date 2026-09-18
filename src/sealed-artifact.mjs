import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decodeArtifact } from "./artifact.mjs";
import { readOwnedFile, writeFileExclusive, syncPublishedDirectory, BridgeError } from "./util.mjs";
import { publication } from "./publication.mjs";

export const MAX_SEALED_PLAINTEXT_BYTES = 16 * 1024 * 1024;
export const MAX_ENVELOPE_BYTES = 24 * 1024 * 1024;
const AAD = Buffer.from("context-bridge:sealed-artifact:v1:aes-256-gcm\n");
const fields = ["sealedVersion", "algorithm", "nonce", "tag", "ciphertext"];

function invalid(cause) {
  return new BridgeError("Sealed artifact or key is invalid, unsafe, or unauthenticated. No plaintext was published.", {
    code: "BRIDGE_SEALED_INVALID", cause,
  });
}

function base64(value, length = null) {
  if (typeof value !== "string") throw invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (length !== null && bytes.length !== length)) throw invalid();
  return bytes;
}

/** Shape validation for opaque transport; does not authenticate without the key. */
export function inspectSealedBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ENVELOPE_BYTES) throw invalid();
  const envelope = JSON.parse(bytes.toString("utf8"));
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      Object.keys(envelope).length !== fields.length || fields.some(field => !Object.hasOwn(envelope, field)) ||
      envelope.sealedVersion !== 1 || envelope.algorithm !== "aes-256-gcm") throw invalid();
  const ciphertext = base64(envelope.ciphertext);
  if (ciphertext.length > MAX_SEALED_PLAINTEXT_BYTES) throw invalid();
  return { ciphertext, nonce: base64(envelope.nonce, 12), tag: base64(envelope.tag, 16) };
}

/** Publish ciphertext and its independent key as one private, exclusive bundle. */
export function sealArtifact(input, output, { verifyKey = null } = {}) {
  let bytes;
  try {
    bytes = readOwnedFile(input, { maxBytes: MAX_SEALED_PLAINTEXT_BYTES });
    decodeArtifact(bytes, { verifyKey });
  } catch (cause) { throw invalid(cause); }
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  let staging;
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const envelope = Buffer.from(JSON.stringify({ sealedVersion: 1, algorithm: "aes-256-gcm",
      nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64") }) + "\n");
    const destination = path.resolve(output);
    // Parent must already exist; never create project/runtime directories implicitly.
    staging = fs.mkdtempSync(path.join(path.dirname(destination), ".bridge-seal-"));
    fs.chmodSync(staging, 0o700);
    writeFileExclusive(path.join(staging, "context.cbsealed"), envelope);
    writeFileExclusive(path.join(staging, "key.bin"), key);
    publication.renameExclusive(staging, destination);
    staging = null;
    syncPublishedDirectory(destination);
    return { path: destination, sealedFile: path.join(destination, "context.cbsealed"),
      keyFile: path.join(destination, "key.bin"), bytes: envelope.length,
      hash: crypto.createHash("sha256").update(envelope).digest("hex") };
  } finally {
    key.fill(0);
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Authentication and inner artifact validation complete before output creation. */
export function openSealedArtifact(input, output, { keyFile, verifyKey = null } = {}) {
  let key, plaintext;
  try {
    if (typeof keyFile !== "string" || !keyFile) throw invalid();
    key = readOwnedFile(keyFile, { maxBytes: 32 });
    if (key.length !== 32) throw invalid();
    const { ciphertext, nonce, tag } = inspectSealedBytes(readOwnedFile(input, { maxBytes: MAX_ENVELOPE_BYTES }));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    decodeArtifact(plaintext, { verifyKey });
  } catch (cause) {
    plaintext?.fill(0);
    throw invalid(cause);
  } finally { key?.fill(0); }
  try {
    const destination = path.resolve(output);
    writeFileExclusive(destination, plaintext);
    return { path: destination, bytes: plaintext.length };
  } finally { plaintext.fill(0); }
}
