// Checkpoint retention. Checkpoints are a safety net, not a growing archive.
// Unit of retention is the handoff GROUP (delta + full + consumed variants that
// share one timestamp-direction stem), never raw files.
// Default rule is conservative: delete a group only when it is BOTH older than
// `days` AND outside the newest `keep` groups. Files referenced by live state
// (a pending injection's delta) are never deleted, under any flag.
import fs from "node:fs";
import path from "node:path";
import { loadState, checkpointsDir } from "./state.mjs";

export const DEFAULT_KEEP_GROUPS = 20;
export const DEFAULT_MAX_AGE_DAYS = 7;

const GROUP_RE = /^(.+?-(?:claude-to-codex|codex-to-claude))(?:-full)?\.md(?:\.consumed)?$/;

/**
 * Prune old checkpoint groups.
 * opts: {keep, days, all, dryRun}
 * Returns {groups, deletedGroups, deletedFiles, protectedGroups}.
 */
export function pruneCheckpoints(projectDir, opts = {}) {
  const keep = opts.keep ?? DEFAULT_KEEP_GROUPS;
  const days = opts.days ?? DEFAULT_MAX_AGE_DAYS;
  const all = opts.all ?? false;
  const dryRun = opts.dryRun ?? false;

  const dir = checkpointsDir(projectDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { groups: 0, deletedGroups: 0, deletedFiles: 0, protectedGroups: 0 };
  }

  // Group files by their handoff stem.
  const groups = new Map();
  for (const f of entries) {
    const m = f.match(GROUP_RE);
    if (!m) continue; // never touch files the bridge did not name
    const p = path.join(dir, f);
    let mtime;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    const g = groups.get(m[1]) ?? { stem: m[1], files: [], mtime: 0 };
    g.files.push(p);
    g.mtime = Math.max(g.mtime, mtime);
    groups.set(m[1], g);
  }

  // A pending injection's delta must survive every prune, including --all.
  const protectedStems = new Set();
  let s = null;
  try {
    s = loadState(projectDir);
  } catch {}
  const pendingFile = s?.pendingInjection?.deltaFile ? path.basename(s.pendingInjection.deltaFile) : null;
  if (pendingFile) {
    const m = pendingFile.match(GROUP_RE);
    if (m) protectedStems.add(m[1]);
  }

  const sorted = [...groups.values()].sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  let deletedGroups = 0;
  let deletedFiles = 0;
  sorted.forEach((g, index) => {
    if (protectedStems.has(g.stem)) return;
    const expired = g.mtime < cutoff && index >= keep; // AND rule, deliberately
    if (!(all || expired)) return;
    deletedGroups++;
    for (const p of g.files) {
      if (!dryRun) {
        try {
          fs.rmSync(p);
        } catch {
          continue;
        }
      }
      deletedFiles++;
    }
  });

  return {
    groups: sorted.length,
    deletedGroups,
    deletedFiles,
    protectedGroups: protectedStems.size,
  };
}
