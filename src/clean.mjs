// Checkpoint retention. Checkpoints are a safety net, not a growing archive.
// Unit of retention is the handoff GROUP (delta + full + consumed variants that
// share one timestamp-direction stem), never raw files.
// Default rule is conservative: delete a group only when it is BOTH older than
// `days` AND outside the newest `keep` groups. Files referenced by live state
// (a pending injection's delta) are never deleted, under any flag.
import fs from "node:fs";
import path from "node:path";
import { loadState, checkpointsDir, CHECKPOINT_KINDS, CONSUMED_SUFFIX } from "./state.mjs";
import { AGENT_IDS } from "./agents/index.mjs";

export const DEFAULT_KEEP_GROUPS = 20;
export const DEFAULT_MAX_AGE_DAYS = 7;
// Companions are the bulk of the bytes (92% of this project's checkpoints) and
// are read at most once, during the session that received them. Their lifetime
// is an event, not a clock, so this is only a backstop for a target that never
// hands off again.
export const DEFAULT_KEEP_COMPANIONS = 5;

// Built from two registries, and it took two separate bugs to get here. Hard
// coding the agent pair made Grok's checkpoints invisible to pruning, so they
// accumulated untouched. Generalising over agents but hard-coding the file kinds
// then did the same to the audit manifests: 24 files, 472KB, and a prune with
// every limit at zero deleted 161 groups and not one of them.
//
// Neither was prevented by the comment left behind after the first one. So the
// kinds come from `CHECKPOINT_KINDS` and the agents from `AGENT_IDS`, and a test
// walks what a real handoff writes and fails on any file this cannot group.
// Longest suffix first, so `-full.md` is never matched as a bare `.md` with the
// rest swallowed into the stem.
const KIND_ALTERNATIVES = Object.values(CHECKPOINT_KINDS)
  .sort((a, b) => b.length - a.length)
  .map((suffix) => suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const GROUP_RE = new RegExp(
  `^(.+?-(?:${AGENT_IDS.join("|")})-to-(?:${AGENT_IDS.join("|")}))(?:${KIND_ALTERNATIVES})` +
    `(?:${CONSUMED_SUFFIX.replace(".", "\\.")})?$`
);

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
  const removedStems = new Set();
  sorted.forEach((g, index) => {
    if (protectedStems.has(g.stem)) return;
    const expired = g.mtime < cutoff && index >= keep; // AND rule, deliberately
    if (!(all || expired)) return;
    deletedGroups++;
    removedStems.add(g.stem);
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

  // Backstop for companions whose target never hands off again: keep only the
  // newest few, whatever their age. Groups already removed above are out of
  // scope, so nothing is counted twice.
  const companions = sorted
    .filter((g) => !removedStems.has(g.stem) && !protectedStems.has(g.stem))
    .flatMap((g) => g.files.filter((p) => p.endsWith(CHECKPOINT_KINDS.companion)).map((p) => ({ p, mtime: g.mtime })))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(all ? 0 : (opts.keepCompanions ?? DEFAULT_KEEP_COMPANIONS));
  if (!dryRun) removeFiles(companions.map((c) => c.p));
  const deletedCompanions = companions.length;
  deletedFiles += deletedCompanions;

  return {
    groups: sorted.length,
    deletedGroups,
    deletedFiles,
    deletedCompanions,
    protectedGroups: protectedStems.size,
  };
}

/**
 * Drop a pending delta that is being replaced by a newer one for the same target.
 * Re-issuing a handoff used to leave the old pair on disk forever: five orphans
 * here, whose companions alone came to 973KB.
 *
 * Healthy state only points pendingInjection at an unconsumed `.md` (consume
 * clears pending and renames). We still try `.consumed` and full variants so a
 * half-updated disk cannot leave an orphan companion behind.
 */
export function supersedePending(projectDir, injection) {
  if (!injection?.deltaFile) return { files: 0, bytes: 0 };
  const delta = path.join(projectDir, injection.deltaFile);
  const base = delta.replace(
    new RegExp(`${CHECKPOINT_KINDS.delta.replace(".", "\\.")}(${CONSUMED_SUFFIX.replace(".", "\\.")})?$`),
    ""
  );
  // Derived, not listed. The hand-written version of this list is exactly how a
  // file kind goes uncollected: it was written when there were two kinds, a
  // third arrived, and nobody thought to come back here. Found in review, after
  // the same patch had already centralised the producers and the retention
  // pattern and left this one path still counting on its own.
  const variants = [delta];
  for (const suffix of Object.values(CHECKPOINT_KINDS)) {
    variants.push(`${base}${suffix}`, `${base}${suffix}${CONSUMED_SUFFIX}`);
  }
  return removeFiles(variants);
}

/**
 * Delete the un-truncated companions that were delivered TO this agent. It is
 * handing off right now, which proves it had a live session after those arrived
 * and is done reading them; from here the native transcripts and knownBy are the
 * canonical record. The filename already says who each one was for, so this
 * needs no bookkeeping of its own.
 *
 * Companions only, and audit manifests deliberately not. They look alike on disk
 * and are opposites in kind: a companion is a transient duplicate of a delta,
 * read at most once by the agent it was written for, so the moment that agent
 * moves on it is dead weight. A manifest is the only record of what was actually
 * run, it is what `bridge inspect` exists to read, and it stays useful long after
 * the session that produced it. It is small, so it earns its keep, and it is
 * bounded by the ordinary group retention rather than dropped on delivery.
 */
export function dropDeliveredCompanions(projectDir, agentId) {
  const dir = checkpointsDir(projectDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { files: 0, bytes: 0 };
  }
  const suffix = `-to-${agentId}${CHECKPOINT_KINDS.companion}`;
  const targets = entries.filter((f) => f.endsWith(suffix)).map((f) => path.join(dir, f));
  return removeFiles(targets);
}

function removeFiles(paths) {
  let files = 0;
  let bytes = 0;
  for (const p of paths) {
    try {
      bytes += fs.statSync(p).size;
      fs.rmSync(p);
      files++;
    } catch {}
  }
  return { files, bytes };
}
