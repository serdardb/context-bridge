import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureRuntimeStore, gitRoot, projectIdentity, storageHome, withProjectRuntimeLock } from "./storage.mjs";
import { ensureState, loadState, mutateState, withProjectStateReadLock, readableCheckpointsDir, writeCheckpoint, checkpointRel, safeCheckpointPath, isValidLaneName, CHECKPOINT_KINDS, DEFAULT_LANE } from "./state.mjs";
import { writeJsonAtomic, writeFileExclusive } from "./util.mjs";
import { readFullContextSections, transformFullContext } from "./delta.mjs";
import { withKernelLockSync, waitForLock } from "./locking.mjs";

export const ARTIFACT_VERSION = 1;
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function withImportLock(hash, fn) {
  return withKernelLockSync(path.join(storageHome(), "locks", `${hash}.import.guard`), () => withImportPidLock(hash, fn));
}

function withImportPidLock(hash, fn) {
  const dir = path.join(storageHome(), "imports");
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `${hash}.lock`);
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      try {
        fs.writeFileSync(fd, Buffer.from(`${process.pid}\n`));
        fs.closeSync(fd);
      }
      catch (error) {
        try { fs.closeSync(fd); } catch {}
        try { fs.rmSync(lock, { force: true }); } catch {}
        throw error;
      }
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let owner = null;
      try { owner = Number(fs.readFileSync(lock, "utf8").trim()); } catch {}
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
      let alive = true;
      if (Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); } catch (error) {
          if (error.code === "ESRCH") alive = false;
          else throw new Error("Cannot verify the artifact import lock owner; refusing to remove its lock.", { cause: error });
        }
      } else if (age > 15000) {
        throw new Error("Artifact import lock has no valid owner; refusing automatic removal.");
      }
      if (age > 15000 && !alive) { try { fs.rmSync(lock, { force: true }); } catch {} }
      waitForLock(lock);
    }
  }
  try { return fn(dir); } finally { try { fs.rmSync(lock, { force: true }); } catch {} }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function digest(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}

function signingData(payload) {
  return Buffer.from(`context-bridge:artifact:v1\n${JSON.stringify(stable(payload))}`, "utf8");
}

function artifactKey(file, privateKey) {
  let key;
  try {
    const pem = fs.readFileSync(file);
    key = privateKey ? crypto.createPrivateKey(pem) : crypto.createPublicKey(pem);
  } catch { throw new Error(`Cannot read a valid ${privateKey ? "private signing" : "trusted public"} key.`); }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Artifact signatures require an Ed25519 key.");
  return key;
}

function keyId(key) {
  const publicKey = key.type === "private" ? crypto.createPublicKey(key) : key;
  return crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

const SECRET_KEYS = "token|access_token|refresh_token|api[_-]?key|password|passwd|secret|cookie|authorization|aws_access_key_id|aws_secret_access_key|private_key";
const SECRET_KEY = new RegExp(`^(?:${SECRET_KEYS})$`, "i");
const SECRET_ASSIGNMENT = new RegExp(
  `\\b(?:${SECRET_KEYS})(["']?)\\s*[:=]\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:Bearer|Basic)\\s+[^\\s,;]+|[^\\s,;]+)`, "gi",
);

function redact(text, projectDir) {
  let value = String(text ?? "");
  // Replace the most specific path first: a project normally lives under home.
  const paths = [[path.resolve(projectDir), "<project>"], [os.homedir(), "<home>"]]
    .sort((a, b) => b[0].length - a[0].length);
  for (const [needle, replacement] of paths) {
    if (needle) value = value.split(needle).join(replacement);
  }
  return value
    .replace(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, "<redacted-private-key>")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted-key>")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<redacted-key>")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<redacted-key>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted-token>")
    .replace(/^([ \t]*(?:Authorization|Cookie)[ \t]*:[ \t]*)[^\r\n]+/gmi, "$1<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "<redacted-key>")
    .replace(SECRET_ASSIGNMENT, (match, keyQuote, secret) => {
      const quote = /^["']/.test(secret) ? secret[0] : "";
      return match.slice(0, -secret.length) + quote + "<redacted>" + quote;
    })
    .replace(/(?:^|\s)(\/(?:Users|home|private|var|tmp)\/[^\s,;]+)/g, (match, absolute) => match.replace(absolute, "<path>"));
}

function redactValue(value, projectDir) {
  if (typeof value === "string") return redact(value, projectDir);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, projectDir));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      SECRET_KEY.test(key)
        ? "<redacted>" : redactValue(entry, projectDir),
    ]));
  }
  return value;
}

function validatePayload(payload) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(payload) || payload.artifactVersion !== ARTIFACT_VERSION || payload.kind !== "context-bridge-context" ||
      typeof payload.createdAt !== "string" || !Number.isFinite(Date.parse(payload.createdAt)) ||
      !object(payload.project) || typeof payload.project.name !== "string" || typeof payload.project.git !== "boolean" ||
      !isValidLaneName(payload.lane) ||
      !["context", "summary", "decisions", "next", "conversation"].every((key) => typeof payload[key] === "string") ||
      (payload.audit !== null && !object(payload.audit)) || !object(payload.source) ||
      typeof payload.source.bridgeVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(payload.source.bridgeVersion) ||
      (payload.source.sectionFormat !== undefined && !["indexed-v1", "opaque"].includes(payload.source.sectionFormat)) ||
      !(payload.source.stateVersion === null || Number.isInteger(payload.source.stateVersion) && payload.source.stateVersion > 0) ||
      payload.source.nativeSessionsIncluded !== false || payload.source.portableContextOnly !== true) {
    throw new Error("Invalid context artifact schema; refusing to apply it.");
  }
}

function latestFullContext(projectDir, lane) {
  const dir = readableCheckpointsDir(projectDir, lane);
  if (!dir) return null;
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(CHECKPOINT_KINDS.fullContext)).sort(); } catch { return null; }
  const name = names.at(-1);
  if (!name) return null;
  const context = readEvidence(path.join(dir, name), "full context checkpoint");
  const auditName = name.slice(0, -CHECKPOINT_KINDS.fullContext.length) + CHECKPOINT_KINDS.audit;
  let audit = null;
  try {
    audit = JSON.parse(readEvidence(path.join(dir, auditName), "audit checkpoint"));
    if (!audit || typeof audit !== "object" || Array.isArray(audit)) throw new Error("Invalid audit checkpoint.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { context, audit };
}

function readEvidence(file, label, encoding = "utf8") {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Refusing to export a non-file or symlinked ${label}.`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`Refusing to export a non-file ${label}.`);
    return fs.readFileSync(fd, encoding);
  } finally { fs.closeSync(fd); }
}

function artifactPayload(projectDir, lane = DEFAULT_LANE) {
  const state = loadState(projectDir, { readOnly: true });
  const evidence = latestFullContext(projectDir, lane);
  const audit = evidence?.audit ?? null;
  const selected = evidence?.context ?? "";
  const sections = readFullContextSections(selected);
  return {
    artifactVersion: ARTIFACT_VERSION,
    kind: "context-bridge-context",
    createdAt: new Date().toISOString(),
    project: { name: path.basename(path.resolve(projectDir)), git: Boolean(gitRoot(projectDir)) },
    lane,
    context: transformFullContext(selected, (text) => redact(text, projectDir)),
    summary: redact(sections?.summary ?? "", projectDir),
    decisions: redact(sections?.decisions ?? "", projectDir),
    next: redact(sections?.next ?? "", projectDir),
    conversation: redact(sections?.conversation ?? "", projectDir),
    audit: audit ? redactValue(audit, projectDir) : null,
    source: { bridgeVersion: PACKAGE_VERSION, stateVersion: state?.version ?? null, nativeSessionsIncluded: false, portableContextOnly: true,
      sectionFormat: sections ? "indexed-v1" : "opaque" },
  };
}

export function exportArtifact(projectDir, outputPath, { lane = DEFAULT_LANE, signKey = null } = {}) {
  if (!outputPath) throw new Error("An output path is required for artifact export.");
  if (signKey !== null && (typeof signKey !== "string" || !signKey)) throw new Error("A non-empty private signing key path is required.");
  const key = signKey ? artifactKey(signKey, true) : null;
  const payload = artifactPayload(projectDir, lane);
  validatePayload(payload);
  const artifact = { ...payload, integrity: { algorithm: "sha256", payload: digest(payload) } };
  if (key) artifact.signature = { algorithm: "Ed25519", keyId: keyId(key),
    value: crypto.sign(null, signingData(payload), key).toString("base64") };
  const destination = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${process.pid}`;
  let fd;
  let owned = false;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    owned = true;
    fs.writeFileSync(fd, JSON.stringify(artifact, null, 2) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, destination);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    if (owned) try { fs.rmSync(temp, { force: true }); } catch {}
  }
  return { path: destination, bytes: fs.statSync(destination).size, hash: artifact.integrity.payload,
    signed: Boolean(key), signer: artifact.signature?.keyId ?? null };
}

export function verifyArtifact(filePath, { verifyKey = null } = {}) {
  return decodeArtifact(artifactBytes(filePath), { verifyKey });
}

export function decodeArtifact(bytes, { verifyKey = null } = {}) {
  if (verifyKey !== null && (typeof verifyKey !== "string" || !verifyKey)) throw new Error("A non-empty trusted public key path is required.");
  const artifact = JSON.parse(bytes.toString("utf8"));
  if (artifact?.artifactVersion !== ARTIFACT_VERSION || artifact.kind !== "context-bridge-context") throw new Error("Unsupported or invalid context artifact.");
  const payload = Object.fromEntries(Object.entries(artifact).filter(([key]) => !["integrity", "signature"].includes(key)));
  if (artifact.integrity?.algorithm !== "sha256" || artifact.integrity.payload !== digest(payload)) throw new Error("Context artifact integrity check failed; refusing to use it.");
  validatePayload(payload);
  if (Object.hasOwn(artifact, "signature") || verifyKey) {
    if (!verifyKey) throw new Error("Signed artifact requires an explicitly trusted public key (--verify-key).");
    const signature = artifact.signature;
    if (!signature || signature.algorithm !== "Ed25519" || typeof signature.value !== "string") {
      throw new Error("A valid Ed25519 signature is required by --verify-key.");
    }
    const bytes = Buffer.from(signature.value, "base64");
    const key = artifactKey(verifyKey, false);
    if (bytes.length !== 64 || bytes.toString("base64") !== signature.value || signature.keyId !== keyId(key) ||
        !crypto.verify(null, signingData(payload), key, bytes)) throw new Error("Artifact signature verification failed.");
  }
  return artifact;
}

function artifactStore(create = false) {
  let dir = storageHome();
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const part of ["artifacts", "sha256"]) {
    dir = path.join(dir, part);
    if (create) {
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe artifact store directory; refusing linked or non-directory storage.");
  }
  return dir;
}

function artifactBytes(fileOrReference) {
  if (typeof fileOrReference !== "string" || !fileOrReference) throw new Error("An artifact file or sha256 reference is required.");
  if (!fileOrReference.startsWith("sha256:")) return readEvidence(fileOrReference, "artifact", null);
  const match = /^sha256:([a-f0-9]{64})$/.exec(fileOrReference);
  if (!match) throw new Error("Invalid artifact content reference.");
  const bytes = readEvidence(path.join(artifactStore(), `${match[1]}.cbctx`), "cached artifact", null);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== match[1]) {
    throw new Error("Cached artifact content does not match its sha256 address.");
  }
  return bytes;
}

/** Validate the same bytes we store; never reopen a mutable source after verification. */
export function cacheArtifact(filePath, { verifyKey = null } = {}) {
  const bytes = artifactBytes(filePath);
  const artifact = decodeArtifact(bytes, { verifyKey });
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const destination = path.join(artifactStore(true), `${hash}.cbctx`);
  let created = true;
  try { writeFileExclusive(destination, bytes); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!readEvidence(destination, "cached artifact", null).equals(bytes)) {
      throw new Error("Existing artifact address contains different bytes; refusing replacement.");
    }
    created = false;
  }
  return { reference: `sha256:${hash}`, path: destination, bytes: bytes.length,
    payloadHash: artifact.integrity.payload, signed: Object.hasOwn(artifact, "signature"), created };
}

function recoverImport(projectDir, lane, identity, journal, disk) {
  if (!fs.existsSync(journal)) return;
  if (!fs.lstatSync(journal).isFile()) throw new Error("Unsafe artifact import journal.");
  const record = JSON.parse(fs.readFileSync(journal, "utf8"));
  if (record.version !== 1 || record.project !== identity || record.lane !== lane ||
      !/^[a-f0-9]{64}$/.test(record.hash) || !/^[a-f0-9]{64}$/.test(record.contentHash) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-claude-to-claude$/.test(record.stem)) {
    throw new Error("Invalid artifact import recovery journal.");
  }
  if (!disk?.lanes?.[lane]) throw new Error("Artifact recovery lane no longer exists; refusing cleanup.");
  if (!disk.lanes[lane].artifactImports?.[record.hash]) {
    const files = [CHECKPOINT_KINDS.fullContext, CHECKPOINT_KINDS.delta].map((suffix) => {
      const rel = checkpointRel(projectDir, lane, record.stem + suffix);
      if (disk.lanes[lane].pendingInjection?.deltaFile === rel || disk.lanes[lane].pendingHandoff?.deltaFile === rel) {
        throw new Error("Artifact recovery file is used by a pending handoff; refusing cleanup.");
      }
      const file = safeCheckpointPath(projectDir, rel);
      if (!file) throw new Error("Unsafe artifact recovery checkpoint path.");
      if (!fs.existsSync(file)) return null;
      if (!fs.lstatSync(file).isFile() || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== record.contentHash) {
        throw new Error("Artifact recovery checkpoint changed; refusing cleanup.");
      }
      return file;
    });
    for (const file of files) if (file) fs.unlinkSync(file);
  }
  fs.unlinkSync(journal);
}

export function importArtifact(filePath, { projectDir = null, apply = false, lane = DEFAULT_LANE, verifyKey = null } = {}) {
  const artifact = verifyArtifact(filePath, { verifyKey });
  if (!apply) return { applied: false, hash: artifact.integrity.payload, artifact };
  if (!projectDir) throw new Error("A project directory is required when applying an artifact.");
  return withProjectRuntimeLock(projectDir, () => applyArtifact(artifact, projectDir, lane));
}

function applyArtifact(artifact, projectDir, lane) {
  ensureState(projectDir);
  const targetIdentity = projectIdentity(projectDir, { create: true });
  const importKey = digest({ artifact: artifact.integrity.payload, project: targetIdentity.id, lane });
  const laneLockKey = digest({ project: targetIdentity.id, lane });
  return withImportLock(laneLockKey, (importDir) => {
    ensureState(projectDir);
    const journal = path.join(importDir, `${laneLockKey}.pending.json`);
    if (fs.existsSync(journal)) withProjectStateReadLock(projectDir, (disk) => recoverImport(projectDir, lane, targetIdentity.id, journal, disk));
    const state = loadState(projectDir);
    if (!state?.lanes?.[lane]) throw new Error(`No lane named '${lane}'; refusing to apply an artifact there.`);
    const record = path.join(importDir, `${importKey}.json`);
    // Read old receipts for compatibility, but commit new receipts in the same
    // state replacement as the seed. A consumer can no longer see one alone.
    if (fs.existsSync(record) || state.lanes[lane].artifactImports?.[artifact.integrity.payload]) {
      return { applied: false, alreadyApplied: true, hash: artifact.integrity.payload };
    }
    if (state.lanes[lane].pendingInjection || state.lanes[lane].pendingHandoff) throw new Error(`Lane '${lane}' already has a pending handoff; refusing to replace it with an imported artifact.`);
    ensureRuntimeStore(projectDir);
    const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-claude-to-claude`;
    let fullRel = null;
    let deltaRel = null;
    let stateChanged = false;
    let alreadyApplied = false;
    try {
      mutateState(projectDir, lane, (disk) => {
        if (disk.lanes[lane].artifactImports?.[artifact.integrity.payload]) {
          alreadyApplied = true;
          return;
        }
        // The earlier snapshot may predate a hook or launcher write. Reserve the
        // lane against its current state before creating any checkpoint files.
        if (disk.pendingInjection || disk.pendingHandoff) throw new Error(`Lane '${lane}' already has a pending handoff; refusing to replace it with an imported artifact.`);
        for (const suffix of [CHECKPOINT_KINDS.fullContext, CHECKPOINT_KINDS.delta]) {
          const candidate = safeCheckpointPath(projectDir, checkpointRel(projectDir, lane, stem + suffix));
          if (!candidate || fs.existsSync(candidate)) throw new Error("Artifact checkpoint path is unsafe or already exists.");
        }
        writeJsonAtomic(journal, { version: 1, project: targetIdentity.id, lane, stem,
          hash: artifact.integrity.payload, contentHash: crypto.createHash("sha256").update(artifact.context).digest("hex") });
        fullRel = writeCheckpoint(projectDir, lane, `${stem}${CHECKPOINT_KINDS.fullContext}`, artifact.context);
        deltaRel = writeCheckpoint(projectDir, lane, `${stem}${CHECKPOINT_KINDS.delta}`, artifact.context);
        disk.pendingInjection = { seed: true, agent: null, via: null, id: null, deltaFile: deltaRel, createdAt: new Date().toISOString(), artifactHash: artifact.integrity.payload };
        disk.lanes[lane].artifactImports ??= {};
        disk.lanes[lane].artifactImports[artifact.integrity.payload] = {
          fullRel, deltaRel, importedAt: disk.pendingInjection.createdAt,
        };
        stateChanged = true;
      });
      if (alreadyApplied) return { applied: false, alreadyApplied: true, hash: artifact.integrity.payload };
      if (!stateChanged) throw new Error(`Lane '${lane}' was removed before the artifact could be applied.`);
      // A failed journal cleanup does not roll back a committed seed. Recovery
      // sees the atomic receipt and only removes this bookkeeping file.
      try { fs.unlinkSync(journal); } catch {}
      return { applied: true, hash: artifact.integrity.payload, fullRel, deltaRel };
    } catch (err) {
      // Publication can succeed before its caller receives an error. Re-read
      // the atomic receipt under the state lock; never undo a visible commit.
      // The same recovery routine also validates hashes before deleting any
      // uncommitted evidence and retains the journal when cleanup is uncertain.
      try {
        withProjectStateReadLock(projectDir, (disk) =>
          recoverImport(projectDir, lane, targetIdentity.id, journal, disk));
      } catch {
        err.message += " Artifact cleanup could not be verified; remaining evidence was retained.";
      }
      throw err;
    }
  });
}
