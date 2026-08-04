// Checkpoint retention. Checkpoints are a safety net, not a growing archive.
// Unit of retention is the handoff GROUP (delta + full + consumed variants that
// share one timestamp-direction stem), never raw files.
// Default rule is conservative: delete a group only when it is BOTH older than
// `days` AND outside the newest `keep` groups. Files referenced by live state
// (a pending injection's delta) are never deleted, under any flag.
import fs from "node:fs";
import path from "node:path";
import { loadState, checkpointsDir, laneDirsOnDisk, isValidLaneName, isInsideDir, bridgeDir, safeCheckpointPath, CHECKPOINT_KINDS, CONSUMED_SUFFIX, DEFAULT_LANE } from "./state.mjs";
import { AGENT_IDS } from "./agents/index.mjs";

export const DEFAULT_KEEP_GROUPS = 20;
export const DEFAULT_MAX_AGE_DAYS = 7;

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
 * Prune old checkpoint groups across every lane.
 * opts: {keep, days, all, dryRun}
 * Returns {groups, deletedGroups, deletedFiles, protectedGroups}.
 *
 * Retention runs per lane, because each lane owns its own directory now: a busy
 * lane's churn must not push a quiet lane's newest groups out of the `keep`
 * window, and each lane's pending delta is protected against its own directory.
 * The rule that walks state or checkpoints has to walk lanes too, or a lane's
 * files go uncollected the way Grok's and the audit manifests once did.
 */
// Every refusal returns the same zeroed shape with one reason flag set. Deletion
// is all-or-nothing across the project: if any lane, any pending marker, or the
// tree itself fails a check, NOTHING is deleted. This is the whole point of the
// two-phase split below — an earlier review found the old code deleting one lane
// before discovering a later lane's pending marker was malformed.
const refuse = (reason) => ({ groups: 0, deletedGroups: 0, deletedFiles: 0, protectedGroups: 0, [reason]: true });

export function pruneCheckpoints(projectDir, opts = {}) {
  // ── Phase 1: validate everything, delete nothing ──────────────────────────
  let s = null;
  try {
    s = loadState(projectDir);
  } catch {
    // Fail closed. A corrupt state file is different from a missing one: missing
    // means a fresh project with nothing to protect, but corrupt means we cannot
    // read which checkpoint a pending handoff still needs, and `--all` would then
    // take the very file a switch is waiting on. A review reproduced exactly that.
    // So refuse to delete anything and let the user repair state (`bridge doctor`)
    // first, rather than guess in the one direction that loses a handoff.
    return refuse("skippedCorruptState");
  }
  // `.bridge` itself must resolve inside the project, not outside via symlink.
  // If `.bridge` is a symlink pointing at `/evil/dir`, every lane under it
  // resolves there too, and the containment check below passes — we would then
  // delete files the project does not own. Refuse entirely.
  const bridge = bridgeDir(projectDir);
  if (!isInsideDir(bridge, projectDir)) {
    return refuse("skippedEscapingBridge");
  }
  // `.bridge/lanes` itself must not be a symlink. `laneDirsOnDisk` returns [] for
  // a symlinked lanes root, which would silently hide every real lane — and with
  // a lane hidden, the pending marker it carries goes unread and the delta that
  // marker protects can be pruned from another lane. A tampered tree is refused,
  // not quietly half-cleaned.
  try {
    if (fs.lstatSync(path.join(bridge, "lanes")).isSymbolicLink()) {
      return refuse("skippedEscapingBridge");
    }
  } catch {
    // no lanes dir at all is normal
  }

  // A lane name becomes a directory, so a name from state that could not have
  // been created by the lane commands is untrustworthy metadata. Silently
  // dropping it (as the first version did) also drops any pending marker it
  // carries, and a flat-main delta that marker protects would then be pruned
  // unprotected. Refuse and let the user repair state.
  const stateLanes = s?.lanes ? Object.keys(s.lanes) : [];
  if (stateLanes.some((lane) => !isValidLaneName(lane))) {
    return refuse("skippedInvalidLane");
  }

  // Lanes from state AND from disk, unioned. Reading state alone would leave every
  // non-main lane's directory growing forever, and a lane directory with no state
  // entry (an orphan left by a deleted lane) would never be collected at all.
  // Physical project root — a symlinked project root is fine, but symlinks inside
  // .bridge/lanes are not. Building expected paths from the physical root means a
  // project opened through an alias still prunes, while a lane directory or
  // checkpoints directory that is a symlink resolves elsewhere and is refused.
  let physicalRoot;
  try {
    physicalRoot = fs.realpathSync(projectDir);
  } catch {
    physicalRoot = path.resolve(projectDir);
  }
  const expectedDir = (lane) =>
    lane === DEFAULT_LANE
      ? path.join(physicalRoot, ".bridge", "checkpoints")
      : path.join(physicalRoot, ".bridge", "lanes", lane, "checkpoints");

  const candidates = [...new Set([DEFAULT_LANE, ...stateLanes, ...laneDirsOnDisk(projectDir)])].filter(isValidLaneName);
  const laneNames = [];
  for (const lane of candidates) {
    const cpDir = checkpointsDir(projectDir, lane);
    let resolved;
    try {
      resolved = fs.realpathSync(cpDir);
    } catch {
      laneNames.push(lane); // does not exist: nothing to delete, nothing to escape
      continue;
    }
    // If the checkpoints dir's realpath doesn't match its expected physical
    // location, a component inside .bridge is symlinked (cross-lane alias attack).
    // Refuse the WHOLE prune, not just this lane: skipping it would leave the delta
    // this lane's pending marker protects exposed to deletion from another lane.
    if (resolved !== expectedDir(lane)) {
      return refuse("skippedEscapingBridge");
    }
    laneNames.push(lane);
  }

  // Without state there is no pending delta to protect, so we cannot tell which
  // checkpoint group is a live handoff waiting to be consumed. Age-based retention
  // could then delete a handoff whose state was simply lost — the same danger
  // `--all` has. Refuse all deletion when state is missing and checkpoints exist,
  // rather than assume a just-lost handoff cannot be old.
  if (!s) {
    const anyFiles = laneNames.some((lane) => dirHasCheckpointGroup(checkpointsDir(projectDir, lane)));
    if (anyFiles) return refuse("skippedNoState");
    return { groups: 0, deletedGroups: 0, deletedFiles: 0, protectedGroups: 0 };
  }

  // Collect every lane's pending delta and validate it BEFORE any deletion.
  // Protection is keyed to the file's actual checkpoints directory and stem, not
  // to which lane's state names it: a marker in lane A that points at a group in
  // lane B (or in flat main) protects that group wherever it physically lives.
  // Matching basename alone let lane B — which had no marker of its own — prune
  // the very delta lane A was waiting on. A marker that is malformed or points
  // outside every known lane's checkpoint directory means we cannot say which
  // group is live, so the whole prune is refused.
  const dirOf = new Map(); // lane -> absolute checkpoints dir (lexical, off projectDir)
  for (const lane of laneNames) dirOf.set(lane, path.resolve(checkpointsDir(projectDir, lane)));
  const knownDirs = new Set(dirOf.values());
  const protectedByDir = new Map(); // absolute dir -> Set<stem>
  for (const lane of stateLanes) {
    const deltaFile = s?.lanes?.[lane]?.pendingInjection?.deltaFile;
    if (deltaFile == null) continue; // no injection, nothing to protect
    if (typeof deltaFile !== "string" || deltaFile === "") {
      return refuse("skippedMalformedPending");
    }
    const abs = path.resolve(projectDir, deltaFile);
    const dir = path.dirname(abs);
    const m = path.basename(abs).match(GROUP_RE);
    // The marker must name a real file inside a known lane's checkpoint directory.
    // A valid-looking path into a lane whose directory does not exist (a stale or
    // wrong lane) would otherwise validate against a phantom location and protect
    // nothing, while the real live delta — sitting in a different, existing dir —
    // is left unprotected and pruned. If we cannot see the file the marker names,
    // we cannot tell which group is the live handoff, so the whole prune is refused.
    if (!m || !knownDirs.has(dir) || !fs.existsSync(abs)) {
      return refuse("skippedMalformedPending");
    }
    if (!protectedByDir.has(dir)) protectedByDir.set(dir, new Set());
    protectedByDir.get(dir).add(m[1]);
  }

  // ── Phase 2: everything validated, delete ─────────────────────────────────
  const total = { groups: 0, deletedGroups: 0, deletedFiles: 0, protectedGroups: 0 };
  for (const lane of laneNames) {
    const protectedStems = protectedByDir.get(dirOf.get(lane)) ?? new Set();
    const r = pruneLaneCheckpoints(checkpointsDir(projectDir, lane), protectedStems, opts);
    total.groups += r.groups;
    total.deletedGroups += r.deletedGroups;
    total.deletedFiles += r.deletedFiles;
    total.protectedGroups += r.protectedGroups;
  }
  return total;
}

/** True when a directory holds at least one file the bridge would group as a checkpoint. */
function dirHasCheckpointGroup(dir) {
  try {
    return fs.readdirSync(dir).some((f) => GROUP_RE.test(f));
  } catch {
    return false;
  }
}

// Prune one lane's directory. `protectedStems` is the set of handoff stems that
// must survive every prune (including --all) because a pending injection somewhere
// points at a group in this directory. Validation of those markers happens in the
// caller, before any deletion, so this function never has to refuse: by the time
// it runs, the decision to delete is already safe.
function pruneLaneCheckpoints(dir, protectedStems, opts = {}) {
  const keep = opts.keep ?? DEFAULT_KEEP_GROUPS;
  const days = opts.days ?? DEFAULT_MAX_AGE_DAYS;
  const all = opts.all ?? false;
  const dryRun = opts.dryRun ?? false;

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

  // There is no second schedule here any more. The full context file used to be
  // deleted the moment its reader handed off, with a backstop keeping the newest
  // few for targets that never did. Both existed because the file was thought to
  // be a transient duplicate and 92% of the bytes. Neither is true after whole
  // messages: it is the same size as the delta it sits beside, and it is what
  // the delivery layer points at when it has to trim, which can happen after the
  // handoff is over. One rule, the group rule, for every kind.

  return {
    groups: sorted.length,
    deletedGroups,
    deletedFiles,
    protectedGroups: protectedStems.size,
  };
}

/**
 * Drop a pending delta that is being replaced by a newer one for the same target.
 * Re-issuing a handoff used to leave the old pair on disk forever: five orphans
 * here, whose full context files alone came to 973KB.
 *
 * Healthy state only points pendingInjection at an unconsumed `.md` (consume
 * clears pending and renames). We still try `.consumed` and every kind's suffix
 * so a half-updated disk cannot leave an orphan behind.
 */
export function supersedePending(projectDir, injection) {
  if (!injection?.deltaFile) return { files: 0, bytes: 0 };
  // One gate for every deletion of a state-derived path (see `safeCheckpointPath`):
  // it refuses `..` traversal, a non-`checkpoints` parent, and symlinked root or
  // directory components. GROUP_RE stays on top of it here because delete is
  // stricter than read — supersede must only ever remove files the bridge named,
  // not any file that happens to sit in a checkpoints directory. The derived
  // variants below share the delta's directory, so this one check covers them all.
  const delta = safeCheckpointPath(projectDir, injection.deltaFile);
  if (!delta || !GROUP_RE.test(path.basename(delta))) {
    return { files: 0, bytes: 0 };
  }
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

// Deleting the full context file the moment its reader handed off used to live
// here, on the argument that the agent had proved it was done reading. That
// argument only held while the file was a duplicate written for one session.
// The delivery layer names it when it trims, and the launcher can push a delta
// past its road budget by appending closing words after the handoff has ended,
// so the file is still the answer to a question asked later. It is pruned with
// its group now, like the audit manifest beside it and for the same reason.

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
