import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { storageHome } from "./storage.mjs";
import { BridgeError, writeJsonAtomic } from "./util.mjs";

// A local acceptance receipt, not a signature or a substitute for human review.
export const RELEASE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const RELEASE_GATES = [
  ["tests", ["npm", "test"]],
  ["syntax", ["npm", "run", "check"]],
  ["context", ["npm", "run", "eval"]],
  ["installed-package", ["npm", "run", "test:package"]],
  ["dependencies", ["npm", "audit"]],
  ["release-ci", ["node", "bin/bridge.mjs", "release-check", "--ci", "--json"]],
  ["agents", ["node", "bin/bridge.mjs", "verify", "--all", "--json"]],
  ["live-context", ["node", "bin/bridge.mjs", "eval", "--live", "codex", "--json"]],
];

const digest = (value) => createHash("sha256").update(value).digest("hex");
function refusal(message) {
  return new BridgeError(message, { code: "BRIDGE_RELEASE_EVIDENCE", operation: "verify release acceptance",
    nextCommand: "bridge release-prepare" });
}

function command(root, executable, args) {
  return execFileSync(executable, args, { cwd: root, encoding: "utf8", timeout: 120000,
    maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function releaseEvidencePath(root) {
  return path.join(storageHome(), "release-evidence", `${digest(fs.realpathSync(root))}.json`);
}

function fingerprint(root) {
  const git = (...args) => command(root, "git", args);
  const commit = git("rev-parse", "HEAD");
  if (git("status", "--porcelain", "--untracked-files=all")) throw refusal("Release acceptance requires a clean working tree.");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  // npm publish runs these after prepublishOnly; unseen rewrites would invalidate
  // the package hash verified here. Require an explicit reviewed build beforehand.
  for (const hook of ["prepack", "prepare", "postpack"]) {
    if (pkg.scripts?.[hook]) throw refusal(`Release evidence does not permit a ${hook} lifecycle script; build before preparing acceptance.`);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-release-pack-"));
  try {
    const [pack] = JSON.parse(command(root, "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary]));
    if (!pack?.filename || path.basename(pack.filename) !== pack.filename) throw refusal("npm returned an invalid package filename.");
    const packageSha256 = digest(fs.readFileSync(path.join(temporary, pack.filename)));
    if (git("rev-parse", "HEAD") !== commit || git("status", "--porcelain", "--untracked-files=all")) {
      throw refusal("The release tree changed while its package was being measured.");
    }
    return { commit, packageSha256, name: pkg.name, version: pkg.version,
      node: process.version, npm: command(root, "npm", ["--version"]), platform: process.platform, arch: process.arch };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function runGate(root, [, [executable, ...args]]) {
  execFileSync(executable === "node" ? process.execPath : executable, args, {
    cwd: root, stdio: "inherit", timeout: 20 * 60 * 1000,
    env: { ...process.env, CONTEXT_BRIDGE_ADAPTERS: "" },
  });
}

export function prepareReleaseEvidence(root, { execute = runGate } = {}) {
  root = fs.realpathSync(root);
  const file = releaseEvidencePath(root);
  // A failed recheck must not leave a previous success available for publishing.
  fs.rmSync(file, { force: true });
  const startedAt = new Date().toISOString();
  const binding = fingerprint(root);
  const gates = [];
  for (const gate of RELEASE_GATES) {
    try { execute(root, gate); }
    catch { throw refusal(`Release preparation failed at ${gate[0]}; no acceptance receipt was written.`); }
    gates.push({ name: gate[0], command: gate[1], completedAt: new Date().toISOString() });
  }
  if (JSON.stringify(fingerprint(root)) !== JSON.stringify(binding)) {
    throw refusal("Commit, package or toolchain changed during release preparation; rerun on the final candidate.");
  }
  const completedAt = new Date().toISOString();
  if (Date.parse(completedAt) - Date.parse(startedAt) > RELEASE_EVIDENCE_MAX_AGE_MS) {
    throw refusal("Release preparation exceeded the acceptance window; no receipt was written.");
  }
  const receipt = { schema: 1, root, startedAt, completedAt, binding, gates };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, receipt);
  return { passed: true, file, binding, completedAt };
}

export function verifyReleaseEvidence(root) {
  root = fs.realpathSync(root);
  const file = releaseEvidencePath(root);
  let receipt;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular receipt");
    receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { throw refusal("No readable release acceptance receipt. Run bridge release-prepare on the final committed candidate."); }
  const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.completedAt), now = Date.now();
  if (receipt.schema !== 1 || receipt.root !== root || !Number.isFinite(start) || !Number.isFinite(end) ||
      start > end || end > now || now - start > RELEASE_EVIDENCE_MAX_AGE_MS) {
    throw refusal("Release acceptance is invalid or older than 24 hours; rerun release-prepare.");
  }
  if (!Array.isArray(receipt.gates) || receipt.gates.length !== RELEASE_GATES.length ||
      RELEASE_GATES.some(([name, cmd], i) => {
        const gate = receipt.gates[i], at = Date.parse(gate?.completedAt);
        return gate?.name !== name || JSON.stringify(gate.command) !== JSON.stringify(cmd) ||
          !Number.isFinite(at) || at < start || at > end;
      })) throw refusal("Release acceptance is missing required gates or uses an older gate policy.");
  if (JSON.stringify(receipt.binding) !== JSON.stringify(fingerprint(root))) {
    throw refusal("Release acceptance belongs to a different commit, package or toolchain.");
  }
  return { passed: true, file, binding: receipt.binding, completedAt: receipt.completedAt };
}
