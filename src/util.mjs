import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export const HOME = os.homedir();
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
export const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
export const GROK_HOME = process.env.GROK_HOME || path.join(HOME, ".grok");

/** Resolved per call, so tests (and a changed env) are honoured without a reload. */
export function grokHome() {
  return process.env.GROK_HOME || path.join(HOME, ".grok");
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

/**
 * Expected, user-facing CLI failure: printed without a stack trace.
 * exitCode 2 = a confirmation is needed (e.g. heuristic adopt), not a hard error.
 */
export class BridgeError extends Error {
  constructor(message, { exitCode = 1, code = null } = {}) {
    super(message);
    this.name = "BridgeError";
    this.expected = true;
    this.exitCode = exitCode;
    this.code = code;
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

/** Atomic JSON write: tmp file + rename. */
export function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, p);
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
