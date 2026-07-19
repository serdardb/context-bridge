// Native session/thread discovery. Users never see any of these IDs.
import fs from "node:fs";
import path from "node:path";
import { CODEX_HOME, claudeProjectDir, fileExists } from "./util.mjs";

/** Find the rollout jsonl for a Codex thread id by scanning ~/.codex/sessions. */
export function findRolloutPath(threadId) {
  const root = path.join(CODEX_HOME, "sessions");
  if (!fileExists(root)) return null;
  // sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl — walk newest-first
  const years = safeList(root).sort().reverse();
  for (const y of years) {
    const months = safeList(path.join(root, y)).sort().reverse();
    for (const m of months) {
      const days = safeList(path.join(root, y, m)).sort().reverse();
      for (const d of days) {
        const dir = path.join(root, y, m, d);
        for (const f of safeList(dir)) {
          if (f.includes(threadId) && f.endsWith(".jsonl")) return path.join(dir, f);
        }
      }
    }
  }
  return null;
}

/**
 * Newest Codex rollout whose recorded cwd matches the project — the adopt
 * candidate when a session was started outside the bridge and CODEX_THREAD_ID
 * is not available. Heuristic (cwd + recency), so callers must require user
 * confirmation before linking it.
 */
export function latestRolloutForProject(projectDir, { maxFiles = 300 } = {}) {
  const root = path.join(CODEX_HOME, "sessions");
  if (!fileExists(root)) return null;
  const want = path.resolve(projectDir);
  let examined = 0;
  const years = safeList(root).sort().reverse();
  for (const y of years) {
    const months = safeList(path.join(root, y)).sort().reverse();
    for (const m of months) {
      const days = safeList(path.join(root, y, m)).sort().reverse();
      for (const d of days) {
        const dir = path.join(root, y, m, d);
        const files = safeList(dir)
          .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
          .map((f) => {
            const p = path.join(dir, f);
            let mtime = 0;
            try {
              mtime = fs.statSync(p).mtimeMs;
            } catch {}
            return { p, f, mtime };
          })
          .sort((a, b) => b.mtime - a.mtime);
        for (const { p, f, mtime } of files) {
          if (++examined > maxFiles) return null;
          const meta = rolloutMeta(p);
          if (!meta?.cwd || path.resolve(meta.cwd) !== want) continue;
          const threadId = meta.id || threadIdFromFilename(f);
          if (!threadId) continue;
          return { threadId, rolloutPath: p, mtime, startedAt: meta.timestamp };
        }
      }
    }
  }
  return null;
}

/** Parse the session_meta head record of a rollout without reading the whole file. */
function rolloutMeta(p) {
  let fd;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString("utf8", 0, n).split("\n").slice(0, 5)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.type === "session_meta") {
          const pl = r.payload || {};
          return { id: pl.id || null, cwd: pl.cwd || null, timestamp: r.timestamp || null };
        }
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return null;
}

function threadIdFromFilename(f) {
  const m = f.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/);
  return m ? m[1] : null;
}

/** Newest Claude session transcript for a project cwd (fallback discovery only). */
export function latestClaudeTranscript(projectDir) {
  const dir = claudeProjectDir(projectDir);
  if (!fileExists(dir)) return null;
  const files = safeList(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = path.join(dir, f);
      return { p, mtime: fs.statSync(p).mtimeMs, sessionId: f.replace(/\.jsonl$/, "") };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] ?? null;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
