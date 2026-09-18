import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publication } from "./publication.mjs";

export const HOME = os.homedir();
export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SHARED_SKILL_PATH = path.join(HOME, ".agents", "skills", "bridge", "SKILL.md");
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
export const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
export const GROK_HOME = process.env.GROK_HOME || path.join(HOME, ".grok");
export const OPENCODE_HOME = process.env.OPENCODE_HOME || path.join(HOME, ".local", "share", "opencode");

// Resolved per call, so tests (and a changed env) are honoured without a reload.
// The module-level constants above are kept for callers that read them once at
// startup; anything that can be re-pointed mid-process should use these.
export function grokHome() {
  return process.env.GROK_HOME || path.join(HOME, ".grok");
}

export function codexHome() {
  return process.env.CODEX_HOME || path.join(process.env.HOME || HOME, ".codex");
}

export function opencodeHome() {
  return process.env.OPENCODE_HOME || path.join(process.env.HOME || HOME, ".local", "share", "opencode");
}

export function sharedSkillPath() {
  return path.join(process.env.HOME || HOME, ".agents", "skills", "bridge", "SKILL.md");
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = c("32");
export const red = c("31");
export const yellow = c("33");
export const dim = c("2");
export const bold = c("1");

export const OK = green("✓");
export const BAD = red("✗");
export const WARN = yellow("⚠");
export const NONE = dim("○");

export function log(msg = "") {
  console.log(msg);
}

/** Opt-in diagnostics; sensitive fields are redacted before reaching stderr. */
export function debugRecord(event, fields = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/prompt|token|secret|password|content|message|transcript/i.test(key)) {
      safe[key] = "[redacted]";
      continue;
    }
    safe[key] = safeDebugValue(value);
  }
  return { event: String(event), ...safe };
}

export function debugLog(event, fields = {}) {
  if (process.env.BRIDGE_DEBUG !== "1") return;
  process.stderr.write(`[context-bridge] ${JSON.stringify(debugRecord(event, fields))}\n`);
}

function safeDebugValue(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(new RegExp(`${escapeRegExp(os.homedir())}(?=/|$)`, "g"), "~")
    .replace(new RegExp(`${escapeRegExp(process.cwd())}(?=/|$)`, "g"), ".")
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/\b(?:sk|ghp|xox[baprs])-[-_A-Za-z0-9]+\b/g, "[redacted]");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Expected, user-facing CLI failure: printed without a stack trace.
 * exitCode 2 = a confirmation is needed (e.g. heuristic adopt), not a hard error.
 */
export class BridgeError extends Error {
  constructor(message, { exitCode = 1, code = null, operation = null, path = null, nextCommand = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BridgeError";
    this.expected = true;
    this.exitCode = exitCode;
    this.code = code;
    this.operation = operation;
    this.path = path;
    this.nextCommand = nextCommand;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

/** Claude Code encodes a project cwd as a directory slug: non-alphanumerics -> '-' */
export function claudeProjectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeProjectDir(cwd) {
  return path.join(CLAUDE_DIR, "projects", claudeProjectSlug(cwd));
}

/** Run a command, capture stdout; returns null on any failure. Child stderr is
 * suppressed — a probe that is ALLOWED to fail must not leak "fatal: …" noise
 * into the user's terminal. */
export function tryExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: opts.timeout ?? 15000,
      stdio: ["ignore", "pipe", "ignore"],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

export function fileExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/** Change detector for declared native source files, not an atomic snapshot. */
export function transcriptStamp(ref) {
  const files = [...new Set([ref.transcriptPath, ref.eventsPath].filter(Boolean))];
  if (!files.length) return null;
  return files.map((file) => {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error("Source transcript is not a regular file");
    return [file, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
  });
}

/** Read a bridge-owned regular leaf; only initial absence may return null. */
export function readOwnedFile(file, { encoding = null, missing = false, maxBytes = null } = {}) {
  if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) throw new Error("Invalid file read limit.");
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (missing && error.code === "ENOENT") return null; throw error; }
  const unsafe = () => Object.assign(new Error("Stored file is unsafe or changed during reading."), { code: "BRIDGE_UNSAFE_FILE" });
  if (!before.isFile() || before.nlink !== 1n) throw unsafe();
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino) throw unsafe();
    let content;
    if (maxBytes === null) content = fs.readFileSync(fd, encoding);
    else {
      if (opened.size > BigInt(maxBytes)) throw Object.assign(new Error("Stored file exceeds the byte limit."), { code: "BRIDGE_FILE_TOO_LARGE" });
      // One extra byte detects growth without an unbounded read allocation.
      const bytes = Buffer.alloc(Number(opened.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!read) break;
        length += read;
      }
      if (BigInt(length) !== opened.size) throw unsafe();
      content = encoding ? bytes.subarray(0, length).toString(encoding) : bytes.subarray(0, length);
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.isFile() && after.nlink === 0n) {
      const error = unsafe();
      error.replaced = true;
      throw error;
    }
    if (!after.isFile() || after.nlink !== 1n || after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw unsafe();
    return content;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function syncPublishedDirectory(file) {
  // Node cannot portably open Windows directories for FlushFileBuffers. Do not
  // advertise POSIX directory durability on that platform.
  if (process.platform === "win32") return;
  let fd;
  try {
    fd = fs.openSync(path.dirname(file), "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (cause) {
    const error = new Error("File was published, but its directory could not be synced. Publication was not rolled back; inspect the current state before retrying.", { cause });
    error.code = "BRIDGE_PUBLICATION_UNCERTAIN";
    error.published = true;
    throw error;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** Publish complete evidence without replacing an existing destination. */
export function writeFileExclusive(file, content) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  let fd;
  let owned = false;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    owned = true;
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // One no-replace move, with no two-link crash window before cleanup.
    publication.renameExclusive(tmp, file);
    syncPublishedDirectory(file);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    if (owned) try { fs.unlinkSync(tmp); } catch {}
  }
}

/** Flush content, replace atomically, then sync its parent on POSIX.
 * Newly created ancestors and multi-file ordering require a separate protocol.
 */
export function writeJsonAtomic(p, obj) {
  return writeFileAtomic(p, JSON.stringify(obj, null, 2) + "\n");
}

export function writeFileAtomic(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  let owned = false;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    owned = true;
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, p);
    syncPublishedDirectory(p);
  } finally {
    // Remove only this invocation's temporary file. After a successful rename,
    // later sync errors must leave the already-published destination untouched.
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    if (owned) try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

/** Truncate a UTF-8 string in the middle, preserving head and tail. */
export function truncateMiddle(s, maxBytes) {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const marker = "\n[… truncated …]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  const headBudget = Math.floor(budget / 2);
  const tailBudget = budget - headBudget;
  return `${sliceUtf8Start(s, headBudget)}${marker}${sliceUtf8End(s, tailBudget)}`;
}

function sliceUtf8Start(s, maxBytes) {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

function sliceUtf8End(s, maxBytes) {
  const chars = Array.from(s);
  let out = "";
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > maxBytes) break;
    out = ch + out;
    used += n;
  }
  return out;
}

export function oneLine(s, max = 200) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Status of a file installed from a repo original: missing, stale or current.
 * Existence alone is not health — an installed copy that has drifted behind the
 * repo silently teaches the agent the wrong instructions, which is how a stale
 * Codex-only skill survived the move to multiple agents.
 */
export function installedCopyStatus(installedPath, sourcePath) {
  let installed;
  try {
    installed = fs.readFileSync(installedPath, "utf8");
  } catch {
    return "missing";
  }
  try {
    return installed === fs.readFileSync(sourcePath, "utf8") ? "current" : "stale";
  } catch {
    return "current"; // no source to compare against: not the user's problem
  }
}

/** Conservative ownership check: only ESRCH proves a valid pid is gone. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH"; // permissions or unknown OS failures cannot justify stealing a lock
  }
}
