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
