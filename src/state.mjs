// Machine-local bridge state. The public logical namespace remains .bridge/...,
// but production storage is resolved by storage.mjs outside the project tree.
// Stores only native session/thread REFERENCES, timestamps, checkpoints and
// pending markers — never transcripts.
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic, writeFileExclusive, readOwnedFile, nowIso, fileExists, log, dim, OK, processAlive, BridgeError } from "./util.mjs";
import { withKernelLockSync, waitForLock } from "./locking.mjs";
import { AGENT_IDS } from "./agents/index.mjs";
import { CHECKPOINT_KINDS, CONSUMED_SUFFIX, assertCheckpointName } from "./checkpoint-kinds.mjs";
export { CHECKPOINT_KINDS, CONSUMED_SUFFIX } from "./checkpoint-kinds.mjs";
import { ensureProjectStore, ensureRuntimeStore, migrateLegacyStorage, runtimeStorageBase, runtimeStoreDir } from "./storage.mjs";

export const STATE_VERSION = 5;

/**
 * The lane a project has before anyone has thought about lanes.
 *
 * Every project starts with one line of work and most will never have a second,
 * so this one is created without being asked for and, while it is the only one,
 * never mentioned. Migration folds an existing project into it.
 */
export const DEFAULT_LANE = "main";

/** The fields that belong to a line of work rather than to the project. */
const LANE_FIELDS = ["activeAgent", "agents", "pendingHandoff", "pendingInjection", "knownBy", "git"];

/**
 * A lane name becomes a directory name (`.bridge/lanes/<name>/…`), so it has to be
 * one path segment and nothing that climbs out of it. Anything with a slash, a
 * backslash, or a leading dot is refused — `..` and `.` and `../secrets` all fail
 * because the first character must be a letter or digit. This is enforced wherever
 * a name reaches the filesystem, and the lane commands validate on creation, so a
 * hand-set or migrated name can never traverse the tree.
 */
const LANE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidLaneName(name) {
  return typeof name === "string" && name.length <= 64 && LANE_NAME_RE.test(name);
}

function assertLaneName(name) {
  if (!isValidLaneName(name)) {
    throw new Error(`Invalid lane name ${JSON.stringify(name)}: use letters, digits, dot, dash or underscore, starting with a letter or digit.`);
  }
  return name;
}

/** Lane directories present on disk under `.bridge/lanes/`, whatever state says.
 *
 * Symlinks are not followed. A `lanes` root that is itself a symlink is refused
 * outright, and each entry is taken only when it is a real directory (`isDirectory`
 * on a `Dirent` is false for a symlink, so a lane entry pointing elsewhere is
 * skipped). Retention deletes what this returns, so a symlink here would let a
 * `clean --all` reach outside the project — a review reached exactly that.
 */
export function laneDirsOnDisk(projectDir, { onUnavailable = () => {} } = {}) {
  const lanesRoot = path.join(bridgeDir(projectDir), "lanes");
  try {
    if (fs.lstatSync(lanesRoot).isSymbolicLink()) { onUnavailable("unsafe-lanes-root"); return []; }
    return fs
      .readdirSync(lanesRoot, { withFileTypes: true })
      .filter((d) => {
        if (d.isSymbolicLink() && isValidLaneName(d.name)) onUnavailable("unsafe-lane", d.name);
        return d.isDirectory() && isValidLaneName(d.name);
      })
      .map((d) => d.name);
  } catch (error) {
    if (error.code !== "ENOENT") onUnavailable("unreadable-lanes-root");
    return [];
  }
}

/**
 * Is `child` really inside `parent`, following every symlink first? Retention uses
 * it to refuse to delete through a checkpoints directory that resolves outside the
 * project's own `.bridge`, whatever the path looks like before resolution.
 */
export function isInsideDir(child, parent) {
  let c, p;
  try {
    c = fs.realpathSync(child);
  } catch {
    return true; // does not exist: nothing to delete, nothing to escape
  }
  try {
    p = fs.realpathSync(parent);
  } catch {
    return false;
  }
  return c === p || c.startsWith(p + path.sep);
}

export function bridgeDir(projectDir) {
  return runtimeStoreDir(projectDir);
}

/**
 * Is `child` inside `parent` by path arithmetic alone, ignoring symlinks and
 * whether either exists? Used on read/rename/delete boundaries, where a `..` that
 * escapes must be refused even when its target is not present — realpath resolves a
 * missing path to nothing and would wave it through.
 */
export function isLexicallyInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve a state-derived checkpoint path (a `pendingInjection.deltaFile`, or a
 * full-context path derived from one) to an absolute path, or null if it does not
 * safely belong to this project's own checkpoint storage.
 *
 * State can be corrupt or hostile, and its `deltaFile` is joined onto the project
 * and then read, renamed to `.consumed`, appended to, or deleted. Every one of
 * those is a trust boundary, and they were each guarding it differently (or not at
 * all): a `..` or a symlinked directory component could read or mutate a file
 * outside `.bridge`. This is the one gate they all pass through now, so the answer
 * to "can a bad deltaFile escape" is "does the caller use this", asked once.
 *
 * Four checks, because each catches what the others miss:
 *   - lexical containment refuses a `..` that climbs out, target present or not;
 *   - the parent directory must be a `checkpoints/` directory, so a contained but
 *     wrong path (`.bridge/state.json`) cannot be read or renamed;
 *   - realpath containment of `.bridge` itself refuses a symlinked root;
 *   - realpath containment of the file's directory refuses a symlinked directory
 *     component that points outside. (A symlinked leaf file is left to the caller:
 *     unlink and rename act on the link, not its target; readers must separately
 *     reject linked leaf files before reading.)
 */
export function safeCheckpointPath(projectDir, rel) {
  if (typeof rel !== "string" || rel === "") return null;
  const bridge = bridgeDir(projectDir);
  const virtualRoot = path.resolve(projectDir, ".bridge");
  const supplied = path.resolve(projectDir, rel);
  if (!isLexicallyInside(supplied, virtualRoot)) return null;
  const abs = path.resolve(bridge, path.relative(virtualRoot, supplied));
  if (
    path.basename(path.dirname(abs)) !== "checkpoints" ||
    !isInsideDir(bridge, runtimeStorageBase(projectDir)) ||
    !isInsideDir(path.dirname(abs), bridge)
  ) {
    return null;
  }
  return abs;
}

export function statePath(projectDir) {
  return path.join(bridgeDir(projectDir), "state.json");
}

/** A directly readable reference for text delivered to agents or people. */
export function checkpointReference(projectDir, rel) {
  const absolute = safeCheckpointPath(projectDir, rel);
  if (!absolute) throw new Error("Cannot reference a checkpoint outside this project's storage.");
  return absolute === path.resolve(projectDir, rel) ? rel : absolute;
}

/**
 * A lane's checkpoints live under it, so deleting a lane removes a directory and
 * `clean`, `inspect` and `status` look in the one lane they are about.
 *
 * `main` is the exception, on purpose. Its checkpoints stay in the flat
 * `.bridge/checkpoints/` they have always used, and are never moved. A checkpoint
 * path is not only stored in state, it is written into the delta's own text and
 * the audit manifest ("Full context checkpoint: .bridge/checkpoints/…"), and a
 * human and `bridge inspect` both read those; moving the files would leave every
 * one of those references pointing at nothing. Not moving them keeps them true. A
 * three-agent review agreed this asymmetry is the safe choice over a migration
 * that would have to rewrite embedded paths transactionally. New lanes have no
 * such history, so they start clean under `.bridge/lanes/<lane>/checkpoints/`.
 */
export function checkpointsDir(projectDir, lane = DEFAULT_LANE) {
  if (lane === DEFAULT_LANE) return path.join(bridgeDir(projectDir), "checkpoints");
  assertLaneName(lane); // a name reaching the filesystem must not climb out of it
  return path.join(bridgeDir(projectDir), "lanes", lane, "checkpoints");
}

/** A checkpoint's path relative to the project, for storing in state and text. */
export function checkpointRel(projectDir, lane, name) {
  return path.join(".bridge", path.relative(bridgeDir(projectDir), path.join(checkpointsDir(projectDir, lane), name)));
}

export function logsDir(projectDir) {
  return path.join(bridgeDir(projectDir), "logs");
}

/** One agent slot. Same shape for every agent, whatever the vendor calls things. */
export function emptyAgent() {
  return {
    // native reference only: session id or thread id, whatever resumes it
    id: null,
    transcriptPath: null,
    // opaque sync watermark, defined by that agent's adapter — never compared
    // across agents, never interpreted here (ISO instant for Claude and Codex,
    // a compound {rows, ts} for Grok)
    mark: null,
    idle: false,
  };
}

/**
 * A lane owns everything that describes work in progress. What stays at project
 * level is what is true whichever line you are working on: the saved launch
 * flags, the launcher process record, and which lane is active.
 *
 * `title` is a user override and nothing else. When it is null the label is read
 * from the agents' own session titles, because every agent already names its
 * sessions and does it better than a scheme invented here would.
 */
export function emptyLane() {
  return {
    title: null,
    activeAgent: null,
    agents: Object.fromEntries(AGENT_IDS.map((agentId) => [agentId, emptyAgent()])),
    pendingHandoff: null,
    pendingInjection: null,
    knownBy: {},
    git: { sha: null, recordedAt: null },
  };
}

export function defaultState(projectDir) {
  return withActiveLaneView({
    version: STATE_VERSION,
    project: projectDir,
    // Which line of work is active. Everything a line owns lives under it.
    activeLane: DEFAULT_LANE,
    lanes: { [DEFAULT_LANE]: emptyLane() },
    // Last launcher process that opened an agent for this project. This is not
    // required to resume state; it only lets handoff warn when an old launcher is
    // still running after a bridge upgrade. It is project-level because there is
    // one launcher per terminal, not one per lane.
    //
    // It does NOT yet record which lane it opened. With one lane there is nothing
    // to confuse, but once lanes can be switched a launcher holding a different
    // one will look stale when it is merely elsewhere, so that field belongs with
    // the lane commands rather than here. Said plainly because a comment
    // describing behaviour the code does not have is how a reader is misled.
    launcher: null,
    updatedAt: null,
  });
}

/** The agent's slot, created on first use so a new agent needs no migration. */
export function agentSlot(s, agentId) {
  if (!s.agents[agentId]) s.agents[agentId] = emptyAgent();
  const slot = s.agents[agentId];
  return {
    get id() {
      return slot.id ?? null;
    },
    get transcriptPath() {
      return slot.transcriptPath ?? null;
    },
    get mark() {
      return slot.mark ?? null;
    },
    get idle() {
      return slot.idle === true;
    },
    get hookSeen() {
      return slot.hookSeen ?? null;
    },
    set(values) {
      Object.assign(slot, values);
      // A deliberate link (launcher, handoff, adopt, import all set an id through
      // here) retires that ONE session's tombstone: the user chose to link this id,
      // so even re-adopting the exact id that was unlinked must work and its hooks
      // must stop being treated as stale. Other rejected ids stay rejected.
      if (values.id) {
        if (Array.isArray(slot.rejectedSessions)) {
          slot.rejectedSessions = slot.rejectedSessions.filter((sid) => sid !== values.id);
          if (!slot.rejectedSessions.length) delete slot.rejectedSessions;
        }
        // A slot written by the briefly-shipped scalar version carries a legacy
        // `unlinked` tombstone the gate still honours. Re-adopting that exact id
        // must clear it too, or the gate would keep rejecting the session the user
        // just chose to link. A DIFFERENT id leaves the scalar intact so its own
        // tombstone stands until the next unlink migrates it into the set.
        if (slot.unlinked === values.id) delete slot.unlinked;
      }
      return slot;
    },
  };
}

/**
 * v1 stored each agent under vendor-specific names and gave the delta watermark
 * a time-flavoured name, which stopped being true once Grok arrived: its chat
 * rows carry no timestamps, so its watermark is a row count. v2 is uniform and
 * the watermark is opaque.
 */
function migrateV1ToV2(s) {
  const next = {
    ...s,
    version: 2,
    agents: Object.fromEntries(AGENT_IDS.map((agentId) => [agentId, emptyAgent()])),
  };
  const legacy = { claude: ["sessionId", "transcriptPath"], codex: ["threadId", "rolloutPath"] };
  for (const [agentId, [idKey, pathKey]] of Object.entries(legacy)) {
    const old = s.agents?.[agentId];
    if (!old) continue;
    next.agents[agentId] = {
      id: old[idKey] ?? null,
      transcriptPath: old[pathKey] ?? null,
      mark: old.lastSyncAt ?? null,
      idle: old.idle === true,
    };
  }
  if (s.pendingInjection) {
    const { sessionId, threadId, ...rest } = s.pendingInjection;
    // sessionId was allowed to be null on purpose (seed the next new session),
    // so keep null distinct from absent.
    next.pendingInjection = { ...rest, id: sessionId !== undefined ? sessionId : (threadId ?? null) };
  }
  return next;
}

/**
 * v2 stored each agent's mark as a position in the OTHER agent's stream, which
 * only works for exactly two agents. v3 stores it as a position in the agent's
 * OWN stream, so any number of agents can hand off in any direction. For the old
 * pair that is precisely a swap.
 */
function migrateV2ToV3(s) {
  const next = { ...s, version: 3, agents: { ...s.agents } };
  const claude = s.agents?.claude;
  const codex = s.agents?.codex;
  if (claude && codex) {
    next.agents.claude = { ...claude, mark: codex.mark ?? null };
    next.agents.codex = { ...codex, mark: claude.mark ?? null };
  }
  return next;
}

/**
 * v3 knew how far each agent's own stream had been shared, but not with whom,
 * which is exactly what a third agent needs. v4 adds the matrix, and starts it
 * EMPTY on purpose: seeding it from the v3 marks would claim agents had seen
 * material that was never sent to them, freezing the transitive loss in place.
 * The cost is one full resync on the next handoff, paid once.
 */
function migrateV3ToV4(s) {
  return { ...s, version: 4, knownBy: {} };
}

/**
 * Fold a single-line project into its first lane.
 *
 * Everything that described work in progress moves down one level and nothing is
 * dropped: the same objects are carried across by reference, so a project that
 * has been running for weeks keeps every link, watermark and pending marker
 * exactly as it was. What stays at the root is what was never about one line of
 * work — the launcher record and the project path.
 *
 * This is one-way. A project migrated here cannot be read by an older bridge,
 * which is what the version bump exists to announce: a launcher still running
 * from before the upgrade says it must be restarted rather than quietly reading
 * fields that have moved.
 */
function migrateV4ToV5(s) {
  const lane = emptyLane();
  for (const field of LANE_FIELDS) {
    if (s[field] !== undefined) lane[field] = s[field];
  }
  const next = {
    version: 5,
    project: s.project,
    activeLane: DEFAULT_LANE,
    lanes: { [DEFAULT_LANE]: lane },
    launcher: s.launcher ?? null,
    updatedAt: s.updatedAt ?? null,
  };
  return next;
}

const MIGRATIONS = { 1: migrateV1ToV2, 2: migrateV2ToV3, 3: migrateV3ToV4, 4: migrateV4ToV5 };

/**
 * The active lane's fields, presented where they have always been.
 *
 * Callers ask for `s.agents` or `s.pendingInjection` in sixty-odd places, and
 * every one of them means "for the work I am doing now". Rewriting them all in
 * the same change that moves the data is how a migration goes wrong: the shape
 * shifts, one reader is missed, and it silently reads a field that no longer
 * holds anything.
 *
 * So the fields stay exactly where callers expect and point at the active lane.
 * They are live: assigning `s.pendingHandoff = null` clears it in the lane, and
 * mutating `s.agents` mutates the lane's own object, because it IS the lane's
 * own object. Code that needs a lane it is not standing in asks for one by name
 * instead, which is the only case that has to be written deliberately.
 */
function withActiveLaneView(s) {
  if (!s || !s.lanes) return s;
  if (!s.lanes[s.activeLane]) s.lanes[s.activeLane ?? DEFAULT_LANE] = emptyLane();
  const lane = () => s.lanes[s.activeLane];
  for (const field of LANE_FIELDS) {
    Object.defineProperty(s, field, {
      configurable: true,
      enumerable: false, // it is the lane's, and must not be written back at the root
      get: () => lane()[field],
      set: (value) => {
        lane()[field] = value;
      },
    });
  }
  return s;
}

/** The lane a caller is standing in, or another one by name. */
export function laneOf(s, name = null) {
  const key = name ?? s?.activeLane ?? DEFAULT_LANE;
  return s?.lanes?.[key] ?? null;
}

/** Every lane in the project, as [name, lane] pairs. */
export function lanes(s) {
  return Object.entries(s?.lanes ?? {});
}

/**
 * A lane's last activity: the mtime of its newest checkpoint, or 0 if it has none.
 * `bridge lane` orders by this, because recency is what "which was I last in"
 * actually asks — a lane made yesterday but worked in an hour ago belongs above one
 * made this morning and abandoned. Read through the containment gate so a symlinked
 * lane directory cannot report an outside file's time as this project's.
 */
export function laneLastActive(projectDir, lane) {
  const dir = readableCheckpointsDir(projectDir, lane);
  if (!dir) return 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let newest = 0;
  for (const name of names) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
    } catch {
      // a file that vanished between readdir and stat is simply not the newest
    }
  }
  return newest;
}

/**
 * Every lane summarised for `bridge lane`: which agents are linked, which is the
 * active one, and when it was last touched. Newest activity first, ties broken by
 * name so the order is stable between reads.
 */
export function laneSummaries(projectDir, s) {
  return Object.keys(s?.lanes ?? {})
    .map((name) => {
      const lane = s.lanes[name];
      return {
        name,
        title: lane.title ?? null,
        active: name === s.activeLane,
        activeAgent: lane.activeAgent ?? null,
        agents: AGENT_IDS.filter((id) => lane.agents?.[id]?.id),
        lastActive: laneLastActive(projectDir, name),
      };
    })
    .sort((a, b) => b.lastActive - a.lastActive || a.name.localeCompare(b.name));
}

/**
 * Record this launcher process against the lane it is driving, and forget any
 * launcher whose process is gone. State tracks launchers per pid rather than one
 * project-wide, so `lane rm` and `unlink` can tell whether a live session is on the
 * lane they touch instead of refusing whenever any launcher at all is up. Dead pids
 * are pruned here, on every launch, so the map cannot grow without bound.
 */
export function recordLauncher(disk, pid, lane) {
  const launchers = {};
  for (const [key, rec] of Object.entries(disk.launchers ?? {})) {
    const other = Number(key);
    if (other !== pid && processAlive(other)) launchers[key] = rec; // keep other live launchers
  }
  // A pre-per-lane project carries a single legacy `launcher`. If its process is
  // still alive and is not this one, migrate it into the map as an unknown-lane
  // entry so it keeps guarding every lane, and ONLY THEN drop the legacy field.
  // Deleting it unconditionally (as the first version did) made a still-live old
  // launcher vanish the moment the first new launcher started, wrongly opening the
  // guards on its lane. A dead legacy record is simply forgotten.
  const legacy = disk.launcher;
  if (legacy?.pid && legacy.pid !== pid && processAlive(legacy.pid) && !launchers[String(legacy.pid)]) {
    launchers[String(legacy.pid)] = {
      pid: legacy.pid,
      lane: null,
      recordedAt: legacy.recordedAt ?? null,
      stateVersion: legacy.stateVersion ?? null,
    };
  }
  launchers[String(pid)] = { pid, lane, recordedAt: nowIso(), stateVersion: STATE_VERSION };
  disk.launchers = launchers;
  delete disk.launcher; // migrated above if it was live, forgotten if it was dead
  return disk.launchers;
}

/**
 * Every launcher whose process is still alive, as `{pid, lane}`. Reads the per-lane
 * map and folds in the legacy single `launcher` record (lane unknown) so an upgrade
 * in flight is not misread as "no launcher running".
 */
export function liveLaunchers(s) {
  const out = [];
  for (const [key, rec] of Object.entries(s?.launchers ?? {})) {
    const pid = Number(key);
    if (Number.isFinite(pid) && processAlive(pid)) out.push({ pid, lane: rec?.lane ?? null });
  }
  const legacy = s?.launcher?.pid;
  if (legacy && processAlive(legacy) && !out.some((l) => l.pid === legacy)) {
    out.push({ pid: legacy, lane: null }); // pre-per-lane record: its lane is not known
  }
  return out;
}

/**
 * Is a live launcher driving `lane` (other than `excludePid`)? A launcher whose
 * lane is unknown — a legacy record mid-upgrade — counts for every lane, because it
 * cannot be proven to be elsewhere. `lane rm` and `unlink` use this to refuse only
 * when a live session is actually on the lane they touch, and to allow the operation
 * on a lane no launcher holds.
 */
export function laneHasLiveLauncher(s, lane, excludePid = null) {
  return liveLaunchers(s).some((l) => l.pid !== excludePid && (l.lane === lane || l.lane === null));
}

/**
 * Add a new, empty lane to `disk` and return it. Throws on a bad or already-taken
 * name. A new lane starts empty on purpose: a different line of work inherits
 * nothing, which is the whole reason lanes exist (seeding, later, is the one
 * deliberate exception). Call inside `mutateProject` so it is written under the lock.
 */
export function createLane(disk, name) {
  assertLaneName(name);
  if (disk.lanes[name]) throw new Error(`Lane ${JSON.stringify(name)} already exists.`);
  disk.lanes[name] = emptyLane();
  return disk.lanes[name];
}

/**
 * Point `activeLane` at an existing lane. Throws if it does not exist. `activeLane`
 * is only "which lane a bare `bridge` resumes when no launcher is running"; a
 * running launcher stays pinned to the lane it opened, so this never moves a lane
 * under a live terminal.
 */
export function switchActiveLane(disk, name) {
  if (!disk.lanes[name]) throw new Error(`No lane named ${JSON.stringify(name)}.`);
  disk.activeLane = name;
  return name;
}

/**
 * Remove a lane from `disk` and return it. Refuses the default lane and the active
 * lane (switch away first), so a project always has a lane and the pointer never
 * dangles. The lane's checkpoint files are deleted by the caller, which owns the
 * filesystem containment checks.
 */
export function removeLaneFromState(disk, name) {
  if (name === DEFAULT_LANE) throw new Error(`The ${DEFAULT_LANE} lane cannot be removed.`);
  if (!disk.lanes[name]) throw new Error(`No lane named ${JSON.stringify(name)}.`);
  if (name === disk.activeLane) {
    throw new Error(`Lane ${JSON.stringify(name)} is active; switch to another lane before removing it.`);
  }
  const removed = disk.lanes[name];
  delete disk.lanes[name];
  return removed;
}

/**
 * Load state; returns null when no bridge state exists.
 * Older files are migrated in place, keeping a one-time backup of the original.
 * A file from a NEWER bridge is refused rather than guessed at.
 */
/**
 * Read and parse `state.json`: null when it does not exist, throw when it exists
 * but will not parse.
 *
 * Only ENOENT means a fresh project. Read failures and malformed content must
 * not be treated alike with absence. A missing file is safe to create; a present-but
 * unparseable one is state that recreating would erase. Writes are atomic (temp +
 * rename), so a reader never catches a half-written file, which means an
 * unparseable one is real corruption. Both the load path and every lane-scoped
 * write go through here, so a bad byte is refused rather than quietly taking every
 * lane with it — the read that returned it, and the splice that would overwrite it.
 */
function readStateFile(projectDir) {
  const p = statePath(projectDir);
  let text;
  try { text = readOwnedFile(p, { encoding: "utf8", missing: true }); } catch (error) {
    throw new BridgeError("Bridge state could not be read. Refusing to overwrite existing state.", {
      cause: error, code: "BRIDGE_STATE_UNREADABLE", operation: "read state",
    });
  }
  if (text === null) return null;
  let s;
  try { s = JSON.parse(text); } catch {
    throw new Error("Bridge state exists but could not be parsed. Refusing to overwrite it so no lane is lost; repair or remove it.");
  }
  if (s) {
    // Parseable is not the same as valid. `{}` is legal JSON with no version, and
    // treating it as state would skip migration (undefined < 5 is false) and write
    // an empty object back, taking every lane with it. A file present but without a
    // numeric version is refused for the same reason a corrupt one is.
    if (typeof s.version !== "number") {
      throw new Error(
        "Bridge state is present but has no version and is not valid bridge state. Refusing to overwrite it so no lane is lost; repair or remove it."
      );
    }
    return s;
  }
  throw new Error(
    "Bridge state exists but could not be parsed. Refusing to overwrite it so no lane is lost; repair or remove it."
  );
}

function preserveSchemaBackup(projectDir, version) {
  if (version > STATE_VERSION) throw new Error(`Bridge state is version ${version}, newer than this bridge understands (${STATE_VERSION}). Update context-bridge.`);
  if (version === STATE_VERSION) return null;
  const file = statePath(projectDir);
  const backup = `${file}.v${version}.backup`;
  const original = readOwnedFile(file);
  if (JSON.parse(original).version !== version) {
    throw new Error("Bridge state changed before schema backup; retry the operation.");
  }
  try {
    writeFileExclusive(backup, original);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let existing;
    try { existing = readOwnedFile(backup); }
    catch (cause) {
      throw new BridgeError("Existing schema backup does not match a safe source copy. Refusing to overwrite either file.", { cause });
    }
    if (!existing.equals(original)) throw new Error("Existing schema backup does not match the source state. Refusing to overwrite either file.");
  }
  return backup;
}

export function loadState(projectDir, options = {}) {
  if (options.readOnly) return readAndUpgradeState(projectDir, options);
  const current = readStateFile(projectDir);
  if (!current) return null;
  if (current.version === STATE_VERSION) return withActiveLaneView(current);
  if (current.version > STATE_VERSION) return readAndUpgradeState(projectDir, options);
  // Migration is a write: re-read under the same lock as lane/project writers.
  return withStateLock(projectDir, () => readAndUpgradeState(projectDir, options));
}

function readAndUpgradeState(projectDir, { write = writeJsonAtomic, readOnly = false } = {}) {
  const p = statePath(projectDir);
  let s = readStateFile(projectDir);
  if (!s) return null;
  if (s.version === STATE_VERSION) return withActiveLaneView(s);
  if (s.version > STATE_VERSION) {
    throw new Error(
      `Bridge state is version ${s.version}, newer than this bridge understands (${STATE_VERSION}). Update context-bridge.`
    );
  }

  const from = s.version;
  while (s.version < STATE_VERSION) {
    const migrate = MIGRATIONS[s.version];
    if (!migrate) {
      throw new Error(`Bridge state version ${s.version} cannot be upgraded by this bridge.`);
    }
    s = migrate(s);
  }
  if (readOnly) return withActiveLaneView(s);
  const backup = preserveSchemaBackup(projectDir, from);
  write(p, s);
  if (backup) {
    log(
      `${OK} Upgraded ${p} from v${from} to v${STATE_VERSION}. ` +
        `The original is kept at ${backup}.`
    );
    log(dim("  Older versions of context-bridge cannot read the new file; restore that copy to go back."));
  }
  return withActiveLaneView(s);
}

/** Load or create state (creates the machine-local runtime layout on first use). */
export function ensureState(projectDir) {
  if (process.env.CONTEXT_BRIDGE_STORAGE !== "project") migrateLegacyStorage(projectDir);
  let s = loadState(projectDir);
  if (!s) {
    // Refuse to initialise a project through a symlinked `.bridge`. Everything
    // below (the state file, the checkpoints and logs directories) is created
    // under `.bridge`, so if the root is a symlink pointing away, the very first
    // `bridge` run would write this project's state and checkpoints outside it.
    // lstat, not exists, so a symlink to a not-yet-existing target is caught too.
    if (process.env.CONTEXT_BRIDGE_STORAGE !== "project") ensureProjectStore(projectDir);
    const bridge = bridgeDir(projectDir);
    let linkStat = null;
    try {
      linkStat = fs.lstatSync(bridge);
    } catch {
      // no .bridge yet: a normal fresh project
    }
    if (linkStat?.isSymbolicLink()) {
      throw new Error(`.bridge is a symlink; refusing to initialise a project through it: ${bridge}`);
    }
    s = defaultState(projectDir);
    saveState(projectDir, s);
    fs.mkdirSync(safeCheckpointsDir(projectDir, DEFAULT_LANE), { recursive: true });
    fs.mkdirSync(logsDir(projectDir), { recursive: true });
    // Global runtime storage has no project-tree footprint, so it must not
    // modify the user's Git configuration as a side effect of first use.
    if (process.env.CONTEXT_BRIDGE_STORAGE === "project") ensureGitignore(projectDir);
  }
  return s;
}

export function saveState(projectDir, s) {
  return withStateLock(projectDir, () => {
    const existing = readStateFile(projectDir);
    if (existing) preserveSchemaBackup(projectDir, existing.version);
    s.updatedAt = nowIso();
    writeJsonAtomic(statePath(projectDir), s);
    return s;
  });
}

/**
 * Serialise the read-modify-write of `state.json` across processes.
 *
 * Two launchers in two terminals, each driving a different lane, both rewrite the
 * whole file; without this the second write is computed from a copy taken before
 * the first and silently drops the first lane's change. An exclusive lock file
 * (`O_EXCL`, so creating it is the acquire) turns the read-modify-write into a
 * critical section.
 *
 * The wait never gives up and writes unsynchronised, because that is the exact
 * race the lock exists to prevent. It only proceeds by acquiring, which means a
 * lock has to be steal-safe from a crashed holder: the writer records its pid, and
 * a lock is stolen ONLY when its owner is provably gone — a dead pid, or a file
 * with no readable pid that is older than `staleMs`. A living owner is never
 * stolen, at any age: a review found that stealing a slow-but-live holder let its
 * own `finally` delete the new owner's fresh lock, so a stuck live process is
 * waited on until the retry budget expires rather than raced. The stable kernel guard serializes the entire
 * PID-lock acquire/recovery/callback/release sequence among updated writers.
 * Old binaries do not take that guard: stop them before upgrading. The PID
 * marker remains for compatibility, not as a standalone race-safe protocol.
 */
function withStateLock(projectDir, fn, { staleMs = 15000 } = {}) {
  // Resolve/migrate before choosing the lock path. Otherwise a direct hook or
  // project mutation can lock the legacy store and then write a different one.
  ensureRuntimeStore(projectDir);
  const lock = statePath(projectDir) + ".lock";
  return withKernelLockSync(lock + ".guard", () => withStatePidLock(lock, fn, staleMs));
}

function withStatePidLock(lock, fn, staleMs) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let held = false;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, "wx"); // creating it exclusively IS the acquire
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (stealableLock(lock, staleMs)) stealLock(lock);
      waitForLock(lock);
      continue;
    }
    // We own the lock the instant the create succeeds. Set `held` before writing
    // the pid, so a failure stamping metadata cannot leave the file orphaned: the
    // finally still removes it, and until then others fall back to mtime staleness.
    held = true;
    try {
      fs.writeSync(fd, `${process.pid} ${nowIso()}`);
    } catch {
      // couldn't stamp the pid; we still hold the lock
    } finally {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    break;
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(lock, { force: true });
      } catch {}
    }
  }
}

/** Does the lock's owner look gone: a dead pid, or a file too old or unreadable to trust? */
function stealableLock(lock, staleMs) {
  let raw, mtimeMs;
  try {
    raw = fs.readFileSync(lock, "utf8");
    mtimeMs = fs.statSync(lock).mtimeMs;
  } catch {
    return false; // vanished under us: the acquire retry will just take it
  }
  const pid = Number(String(raw).trim().split(/\s+/)[0]);
  if (pid) return !processAlive(pid); // a living owner is never stolen; a dead one always is
  return Date.now() - mtimeMs > staleMs; // no readable pid: fall back to age
}

/** Rename the observed stale path; this does not protect against replacement races. */
function stealLock(lock) {
  const mine = `${lock}.steal.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(lock, mine);
  } catch {
    return; // another stealer moved it first; the acquire retry will sort it out
  }
  fs.rmSync(mine, { force: true });
}

/**
 * Read-modify-write one lane under the lock. The write primitive everything goes
 * through.
 *
 * The earlier "load a copy, mutate it, write it back" lost updates whenever two
 * writers touched the same lane, which is the common case, not a corner: a
 * launcher and its agent's hooks both write the active lane, and the second
 * wholesale write erased the first. Here the read AND the mutation both happen
 * inside the lock, against the file as it is at that instant, so nothing computed
 * from a stale snapshot can overwrite a neighbour's field. The mutator is handed
 * the state through the usual active-lane view (`s.agents`, `s.pendingInjection`,
 * `agentSlot(s, …)`) pinned to `laneName`, so call sites keep the shape they had.
 *
 * `activeLane` on disk is restored after the mutation: which lane is the project
 * default is `lane switch`'s decision, never a side effect of one writer saving.
 * A file that is present but corrupt or versionless aborts the write (readStateFile
 * throws) rather than being flattened to a skeleton that drops every lane.
 */
export function mutateState(projectDir, laneName, fn) {
  return withStateLock(projectDir, () => {
    const existing = readStateFile(projectDir);
    if (existing) preserveSchemaBackup(projectDir, existing.version);
    let disk = existing ?? {
      version: STATE_VERSION,
      project: projectDir,
      activeLane: laneName ?? DEFAULT_LANE,
      lanes: {},
      launcher: null,
      updatedAt: null,
    };
    while (disk.version < STATE_VERSION) {
      const migrate = MIGRATIONS[disk.version];
      if (!migrate) throw new Error(`Bridge state version ${disk.version} cannot be upgraded by this bridge.`);
      disk = migrate(disk);
    }
    if (!disk.lanes) disk.lanes = {};
    const key = laneName ?? disk.activeLane ?? DEFAULT_LANE;
    if (!disk.lanes[key]) {
      // A lane absent from an EXISTING project was removed by `lane rm`. Do not
      // recreate it. A launcher still pinned to it, or a hook that fires after the
      // removal, would otherwise write the deleted lane back empty on its next
      // mutate and silently undo the removal — the resurrection a review found. The
      // write is dropped, because its lane is gone and there is nowhere it belongs.
      // Auto-create is only for the one legitimate case: bootstrapping the very
      // first lane of a brand-new project, which has no state file at all yet.
      if (existing) return disk;
      disk.lanes[key] = emptyLane();
    }
    const originalActive = disk.activeLane ?? key;
    disk.activeLane = key; // point the view at the lane being mutated
    withActiveLaneView(disk);
    fn(disk);
    disk.activeLane = originalActive; // a mutate never moves the project default
    disk.updatedAt = nowIso();
    writeJsonAtomic(statePath(projectDir), disk);
    return disk;
  });
}

/** Inspect current state under the writer lock without replacing it. */
export function withProjectStateReadLock(projectDir, fn) {
  return withStateLock(projectDir, () => fn(readStateFile(projectDir)));
}

/** Read-modify-write the active lane, under the lock. A thin alias for
 * `mutateState` on the active lane, kept for callers that read as "update". */
export function updateState(projectDir, fn) {
  ensureState(projectDir); // create the .bridge/ layout on first use
  return mutateState(projectDir, null, fn);
}

/**
 * Read-modify-write the WHOLE state under the lock, for project-level changes that
 * are not scoped to one lane: creating, switching or removing a lane. Unlike
 * `mutateState` it neither pins a lane view nor restores `activeLane` afterwards,
 * because moving the active lane IS the point here, and it never auto-creates the
 * lane it is handed. The same exclusive lock makes it safe against a launcher's
 * concurrent per-lane writes.
 */
export function mutateProject(projectDir, fn) {
  return withStateLock(projectDir, () => mutateProjectLocked(projectDir, fn));
}

function mutateProjectLocked(projectDir, fn) {
  let disk = readStateFile(projectDir);
  if (!disk) throw new Error("No bridge state in this project yet. Run 'bridge' first.");
  preserveSchemaBackup(projectDir, disk.version);
  while (disk.version < STATE_VERSION) {
    const migrate = MIGRATIONS[disk.version];
    if (!migrate) throw new Error(`Bridge state version ${disk.version} cannot be upgraded by this bridge.`);
    disk = migrate(disk);
  }
  if (!disk.lanes) disk.lanes = {};
  fn(disk);
  disk.updatedAt = nowIso();
  writeJsonAtomic(statePath(projectDir), disk);
  return disk;
}

/** Keep lane recreation excluded until the removed lane's files are gone. */
export function removeLane(projectDir, name) {
  assertLaneName(name);
  return withStateLock(projectDir, () => {
    mutateProjectLocked(projectDir, (disk) => {
      if (laneHasLiveLauncher(disk, name)) throw new Error(`A bridge launcher is running on lane '${name}'.`);
      removeLaneFromState(disk, name);
    });
    const root = bridgeDir(projectDir);
    const dir = path.join(root, "lanes", name);
    if (!isInsideDir(dir, root)) return { filesRemoved: false, reason: "unsafe lane directory" };
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return { filesRemoved: true };
    } catch (error) {
      return { filesRemoved: false, reason: error.code ?? "directory removal failed" };
    }
  });
}

/** Make sure .bridge/ is git-ignored; append if repo exists and entry missing. */
export function ensureGitignore(projectDir) {
  if (!fileExists(path.join(projectDir, ".git"))) return { action: "no-git" };
  const gi = path.join(projectDir, ".gitignore");
  let content = "";
  try {
    content = fs.readFileSync(gi, "utf8");
  } catch {}
  const lines = content.split("\n").map((l) => l.trim());
  if (lines.includes(".bridge/") || lines.includes(".bridge")) return { action: "already" };
  const next = content.length && !content.endsWith("\n") ? content + "\n.bridge/\n" : content + ".bridge/\n";
  fs.writeFileSync(gi, next);
  return { action: "added" };
}

/**
 * Every kind of file a handoff writes into `.bridge/checkpoints/`, in one place.
 *
 * They all share a stem — `<when>-<source>-to-<target>` — and retention deletes
 * that whole group as a unit. The list lives here, beside the writer, because
 * this project has twice shipped a file kind that nothing ever collected: first
 * Grok's checkpoints, invisible because the pattern hard-coded one agent pair,
 * and then the audit manifests, invisible because the pattern was generalised
 * over agents but still hard-coded the kinds. Both times a comment asked the
 * next person to remember. Both times they did not.
 *
 * So producers name a kind from here rather than writing a suffix by hand, and
 * retention builds its matcher from the same object. A test walks the files a
 * real handoff produces and fails when one of them is a kind retention does not
 * know, which is the only version of this rule that has ever held.
 */
/*
 * The registry lives in checkpoint-kinds.mjs so migration can use the same
 * suffixes without importing state. Full context is retained with its handoff
 * group; consumed deltas retain their contents under the consumed suffix.
 */

/**
 * Assert a lane's checkpoints directory can be written to without escaping the
 * project, and return its absolute path. `safeCheckpointPath` is the read/rename/
 * delete gate for an existing delta; this is its symmetric twin for CREATING
 * checkpoint files. A symlinked lane directory (or a symlinked `.bridge`) would
 * otherwise let writeCheckpoint / writeManifest create files outside the project —
 * reproduced in review with a `lanes/<lane>/checkpoints` symlink. Every existing
 * path component from `.bridge` down must be a real directory; a missing one is
 * fine, since mkdir creates it as a real directory inside `.bridge`.
 */
export function safeCheckpointsDir(projectDir, lane) {
  const bridge = bridgeDir(projectDir);
  if (!isInsideDir(bridge, runtimeStorageBase(projectDir))) {
    throw new Error("bridge storage does not resolve inside its runtime root; refusing to write checkpoints.");
  }
  const dir = checkpointsDir(projectDir, lane); // also validates the lane name
  let cur = bridge;
  for (const seg of path.relative(bridge, dir).split(path.sep)) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      break; // this component and everything below is absent; mkdir makes real dirs
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write through a symlinked path component: ${path.relative(projectDir, cur)}`);
    }
  }
  return dir;
}

/**
 * A lane's checkpoints directory, but only if it can be READ without escaping the
 * runtime storage root — null otherwise. The read counterpart to
 * `safeCheckpointsDir` (which is for writes and throws): `status` and `inspect` list
 * this directory, and a symlinked lane checkpoints dir would let them enumerate or
 * read files outside this project's own store. Returns null rather than throwing,
 * because a read for display must degrade quietly, not crash.
 */
export function readableCheckpointsDir(projectDir, lane) {
  const bridge = bridgeDir(projectDir);
  const dir = checkpointsDir(projectDir, lane);
  if (!isInsideDir(bridge, runtimeStorageBase(projectDir)) || !isInsideDir(dir, bridge)) return null;
  return dir;
}

/** Missing history is normal; unsafe or unreadable history is not empty. */
export function latestCheckpoint(projectDir, lane = DEFAULT_LANE, kind = "fullContext") {
  const suffix = CHECKPOINT_KINDS[kind];
  if (!suffix) throw new Error("Unknown checkpoint kind.");
  const fail = (cause) => new BridgeError("The latest checkpoint could not be read safely. Check stored evidence before retrying; no older checkpoint was substituted.", {
    code: "BRIDGE_CHECKPOINT_UNREADABLE", operation: "read latest checkpoint",
    cause,
  });
  const dir = readableCheckpointsDir(projectDir, lane);
  if (!dir) throw fail();
  let names;
  try { names = fs.readdirSync(dir).filter(name => name.endsWith(suffix)).sort(); }
  catch (error) { if (error.code === "ENOENT") return null; throw fail(error); }
  if (!names.length) return null;
  const name = names.at(-1);
  const rel = checkpointRel(projectDir, lane, name);
  const file = safeCheckpointPath(projectDir, rel);
  if (!file) throw fail();
  try {
    const text = readOwnedFile(file, { encoding: "utf8" });
    return { rel, text };
  } catch (error) {
    if (error.code === "BRIDGE_CHECKPOINT_UNREADABLE") throw error;
    throw fail(error);
  }
}

/** Create a checkpoint without replacing evidence; returns its logical path. */
export function writeCheckpoint(projectDir, lane, name, content) {
  assertCheckpointName(name);
  if (process.env.CONTEXT_BRIDGE_STORAGE !== "project") ensureRuntimeStore(projectDir);
  const dir = safeCheckpointsDir(projectDir, lane);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileExclusive(file, content);
  return checkpointRel(projectDir, lane, name);
}

/** How far SOURCE's stream has been packed for TARGET, or null if never. */
export function knownMark(s, target, source) {
  return s.knownBy?.[target]?.[source] ?? null;
}

/**
 * Commit what a finalised delta contained into the matrix. Called wherever a
 * delta becomes final — after closing words are appended, or when it is
 * consumed — and idempotent, so calling it twice is harmless.
 */
export function commitKnown(s, injection) {
  if (!injection?.agent || !injection.sources) return false;
  if (!s.knownBy) s.knownBy = {};
  const target = (s.knownBy[injection.agent] ??= {});
  let changed = false;
  for (const [source, mark] of Object.entries(injection.sources)) {
    if (JSON.stringify(target[source]) === JSON.stringify(mark)) continue;
    target[source] = mark;
    changed = true;
  }
  return changed;
}

/**
 * Unlink one agent from the active lane: forget its session and every watermark
 * that mentions it, in BOTH directions. Clearing the slot alone would leave marks
 * pointing at a session that no longer exists, and the next handoff could then read
 * "nothing new since that mark" and send nothing at all — the silent context loss
 * this project keeps designing out. So the knownBy matrix is cleared for the agent
 * both as a target (how far others were packed for it) and as a source (how far it
 * was packed for others), and any pending marker or active pointer that names it is
 * dropped so nothing dangles. `s` is the active-lane view. Returns true if anything
 * changed, false if the agent was not linked here.
 */
export function unlinkAgent(s, agentId) {
  let changed = false;
  const slot = s.agents?.[agentId];
  // Reset on ANY agent-owned metadata, not just id/transcriptPath/mark. A slot also
  // carries fields the adapters stamp lazily and independently of a session link:
  // Codex writes `hookSeen` the moment its hook fires, Claude leaves `pendingId`/
  // `pendingPath` mid-link, and `idle` flips on a stall. A slot holding only one of
  // those still keeps the agent hook-eligible or stale, so unlink must forget it
  // too, and count it as a change. Replacing the whole object with a fresh
  // `emptyAgent()` also drops those extra keys, which a field-by-field clear would
  // leave behind. `rejectedSessions` is the exception: it is the TOMBSTONE SET this
  // unlink leaves, not linked content, so it does not count as something to forget
  // and a re-unlink of an already-forgotten agent stays a no-op.
  const priorId = slot?.id ?? null;
  const priorRejected = Array.isArray(slot?.rejectedSessions) ? [...slot.rejectedSessions] : [];
  // Migrate the older single scalar `unlinked` (shipped briefly, unpublished) into
  // the set so an existing tombstone is not silently dropped on the first re-unlink.
  if (typeof slot?.unlinked === "string" && !priorRejected.includes(slot.unlinked)) priorRejected.push(slot.unlinked);
  const hasLinkContent =
    slot &&
    Object.entries(slot).some(
      ([k, v]) => k !== "rejectedSessions" && k !== "unlinked" && v !== null && v !== false && v !== undefined
    );
  if (hasLinkContent) {
    s.agents[agentId] = emptyAgent();
    // Tombstone the session id just forgotten, ACCUMULATING onto every earlier one, so
    // a stale hook from a directly-run agent cannot re-link ANY session that was
    // unlinked. A single scalar remembered only the last: unlink A, link B, unlink B,
    // and A's tombstone was overwritten so A's delayed hook could relink. A set keeps
    // them all. A deliberate re-link of a specific id retires just that one; the
    // launcher-alive guard covers bridge-managed sessions, and this covers the rest.
    const rejected = new Set(priorRejected);
    if (priorId) rejected.add(priorId);
    if (rejected.size) s.agents[agentId].rejectedSessions = [...rejected];
    changed = true;
  }
  if (s.knownBy) {
    if (s.knownBy[agentId]) {
      delete s.knownBy[agentId]; // the agent as a target
      changed = true;
    }
    for (const target of Object.keys(s.knownBy)) {
      if (s.knownBy[target] && agentId in s.knownBy[target]) {
        delete s.knownBy[target][agentId]; // the agent as a source
        changed = true;
      }
    }
  }
  if (s.pendingInjection?.agent === agentId) {
    s.pendingInjection = null;
    changed = true;
  }
  if (s.pendingHandoff?.target === agentId) {
    s.pendingHandoff = null;
    changed = true;
  }
  if (s.activeAgent === agentId) {
    s.activeAgent = null;
    changed = true;
  }
  return changed;
}
