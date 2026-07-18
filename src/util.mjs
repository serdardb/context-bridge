import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export const HOME = os.homedir();
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
export const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");

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

/** Run a command, capture stdout; returns null on any failure. */
export function tryExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: opts.timeout ?? 15000, ...opts }).trim();
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

/** Truncate a string in the middle, preserving head and tail. */
export function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const half = Math.floor((max - 20) / 2);
  return `${s.slice(0, half)}\n[… truncated …]\n${s.slice(-half)}`;
}

export function oneLine(s, max = 200) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
