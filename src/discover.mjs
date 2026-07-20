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

/**
 * Every rollout for this project whose session_meta timestamp is at or after
 * `sinceIso`. Used to identify the session a launcher just started: unlike
 * `latestRolloutForProject` this never picks a winner, because "newest" is a
 * guess and the caller refuses to adopt when more than one candidate exists.
 */
export function rolloutsForProjectSince(projectDir, sinceIso, { maxFiles = 300 } = {}) {
  const root = path.join(CODEX_HOME, "sessions");
  if (!fileExists(root)) return [];
  const want = path.resolve(projectDir);
  const out = [];
  let examined = 0;
  for (const y of safeList(root).sort().reverse()) {
    for (const m of safeList(path.join(root, y)).sort().reverse()) {
      for (const d of safeList(path.join(root, y, m)).sort().reverse()) {
        const dir = path.join(root, y, m, d);
        for (const f of safeList(dir)) {
          if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
          if (++examined > maxFiles) return out;
          const p = path.join(dir, f);
          const meta = rolloutMeta(p);
          if (!meta?.cwd || path.resolve(meta.cwd) !== want) continue;
          if (sinceIso && (!meta.timestamp || meta.timestamp < sinceIso)) continue;
          const threadId = meta.id || threadIdFromFilename(f);
          if (threadId) out.push({ threadId, rolloutPath: p, startedAt: meta.timestamp });
        }
      }
    }
  }
  return out;
}

/**
 * Can the head-record parser still read rollouts at all?
 *
 * This asks a different question from every other check: not "is this project
 * linked" but "does our reader still understand the format on disk". It exists
 * because that reader died silently once already — a 16KB buffer against a 22KB
 * record — and the symptom of this class of bug is not an error, it is an empty
 * result, which looks exactly like having nothing to find.
 *
 * Deliberately ignores which project a rollout belongs to: a project with no
 * Codex session would otherwise look broken. Examines only the newest few.
 */
export function rolloutHeadHealth({ sample = 5 } = {}) {
  const root = path.join(CODEX_HOME, "sessions");
  if (!fileExists(root)) return { examined: 0, recognised: 0 };
  const found = [];
  for (const y of safeList(root).sort().reverse()) {
    for (const m of safeList(path.join(root, y)).sort().reverse()) {
      for (const d of safeList(path.join(root, y, m)).sort().reverse()) {
        for (const f of safeList(path.join(root, y, m, d))) {
          if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
          found.push(path.join(root, y, m, d, f));
          if (found.length >= sample) return score(found);
        }
      }
    }
  }
  return score(found);
}

function score(paths) {
  let recognised = 0;
  for (const p of paths) {
    const meta = rolloutMeta(p);
    if (meta?.cwd) recognised++;
  }
  return { examined: paths.length, recognised };
}

/** Claude transcripts for a project last written at or after `sinceMs`. */
export function claudeTranscriptsSince(projectDir, sinceMs) {
  const dir = claudeProjectDir(projectDir);
  if (!fileExists(dir)) return [];
  return safeList(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = path.join(dir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(p).mtimeMs;
      } catch {}
      return { p, mtime, sessionId: f.replace(/\.jsonl$/, "") };
    })
    .filter((c) => c.mtime >= sinceMs);
}

/**
 * Parse the session_meta head record of a rollout without reading the whole file.
 *
 * The head record is not small: codex-cli embeds the full base instructions in it,
 * which on 0.144.6 makes that single line 22KB. A fixed 16KB buffer therefore cut
 * every record in half, JSON.parse failed silently, and no rollout ever matched a
 * project — Codex discovery and adoption were dead on this machine and said
 * nothing, because a failed parse is indistinguishable from "not this project".
 * So read forward until the first record actually ends, with a ceiling.
 */
function rolloutMeta(p) {
  const CHUNK = 64 * 1024;
  const CEILING = 4 * 1024 * 1024; // a head record larger than this is not one
  let fd;
  try {
    fd = fs.openSync(p, "r");
    let text = "";
    const buf = Buffer.alloc(CHUNK);
    for (let offset = 0; offset < CEILING; offset += CHUNK) {
      const n = fs.readSync(fd, buf, 0, CHUNK, offset);
      if (n <= 0) break;
      text += buf.toString("utf8", 0, n);
      const lines = text.split("\n");
      // Only complete lines can be parsed; the last fragment waits for more.
      for (const line of lines.slice(0, -1)) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r.type === "session_meta") {
            const pl = r.payload || {};
            return { id: pl.id || null, cwd: pl.cwd || null, timestamp: r.timestamp || null };
          }
        } catch {}
      }
      // The head record is the first line; if we have it and it was not
      // session_meta, nothing later in the file will be either.
      if (lines.length > 5) break;
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
