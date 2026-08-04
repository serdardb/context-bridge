// Project-local bridge state: .bridge/state.json
// Stores only native session/thread REFERENCES, timestamps, checkpoints and
// pending markers — never transcripts.
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readJson, nowIso, fileExists, log, dim, OK, processAlive } from "./util.mjs";
import { AGENT_IDS } from "./agents/index.mjs";

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
export function laneDirsOnDisk(projectDir) {
  const lanesRoot = path.join(bridgeDir(projectDir), "lanes");
  try {
    if (fs.lstatSync(lanesRoot).isSymbolicLink()) return [];
    return fs
      .readdirSync(lanesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidLaneName(d.name))
      .map((d) => d.name);
  } catch {
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
  return path.join(projectDir, ".bridge");
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
 *     unlink and rename act on the link, not its target, and a read is contained.)
 */
export function safeCheckpointPath(projectDir, rel) {
  if (typeof rel !== "string" || rel === "") return null;
  const bridge = bridgeDir(projectDir);
  const abs = path.resolve(projectDir, rel);
  if (
    !isLexicallyInside(abs, bridge) ||
    path.basename(path.dirname(abs)) !== "checkpoints" ||
    !isInsideDir(bridge, projectDir) ||
    !isInsideDir(path.dirname(abs), bridge)
  ) {
    return null;
  }
  return abs;
}

export function statePath(projectDir) {
  return path.join(bridgeDir(projectDir), "state.json");
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
  return path.relative(projectDir, path.join(checkpointsDir(projectDir, lane), name));
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
 * Load state; returns null when no .bridge/state.json exists.
 * Older files are migrated in place, keeping a one-time backup of the original.
 * A file from a NEWER bridge is refused rather than guessed at.
 */
/**
 * Read and parse `state.json`: null when it does not exist, throw when it exists
 * but will not parse.
 *
 * Missing and malformed both read back as null from `readJson`, but they must not
 * be treated alike. A missing file is a fresh project to create; a present-but
 * unparseable one is state that recreating would erase. Writes are atomic (temp +
 * rename), so a reader never catches a half-written file, which means an
 * unparseable one is real corruption. Both the load path and every lane-scoped
 * write go through here, so a bad byte is refused rather than quietly taking every
 * lane with it — the read that returned it, and the splice that would overwrite it.
 */
function readStateFile(projectDir) {
  const p = statePath(projectDir);
  const s = readJson(p);
  if (s) {
    // Parseable is not the same as valid. `{}` is legal JSON with no version, and
    // treating it as state would skip migration (undefined < 5 is false) and write
    // an empty object back, taking every lane with it. A file present but without a
    // numeric version is refused for the same reason a corrupt one is.
    if (typeof s.version !== "number") {
      throw new Error(
        ".bridge/state.json is present but has no version and is not valid bridge state. Refusing to overwrite it so no lane is lost; fix or remove the file."
      );
    }
    return s;
  }
  if (fileExists(p)) {
    throw new Error(
      ".bridge/state.json exists but could not be parsed. Refusing to overwrite it so no lane is lost; fix or remove the file."
    );
  }
  return null;
}

export function loadState(projectDir) {
  const p = statePath(projectDir);
  let s = readStateFile(projectDir);
  if (!s) return null;
  if (s.version === STATE_VERSION) return withActiveLaneView(s);
  if (s.version > STATE_VERSION) {
    throw new Error(
      `.bridge/state.json is version ${s.version}, newer than this bridge understands (${STATE_VERSION}). Update context-bridge.`
    );
  }

  const from = s.version;
  while (s.version < STATE_VERSION) {
    const migrate = MIGRATIONS[s.version];
    if (!migrate) {
      throw new Error(`.bridge/state.json version ${s.version} cannot be upgraded by this bridge.`);
    }
    s = migrate(s);
  }
  let backup = null;
  try {
    try {
      // COPYFILE_EXCL: the first backup is the real original, so never overwrite
      // it — a later restore-and-remigrate must not clobber the good copy.
      fs.copyFileSync(p, `${p}.v${from}.backup`, fs.constants.COPYFILE_EXCL);
      backup = `${p}.v${from}.backup`;
    } catch {
      // Backup already exists: keep it.
    }
    writeJsonAtomic(p, s);
    // Said once, here, because this is the only moment it is true and the only
    // moment the user can act on it. A migration is one-way: an older bridge
    // refuses a newer file outright rather than guessing at it, so somebody who
    // downgrades after this needs to know the original is still on disk. The
    // backup has always been written and nothing has ever mentioned it, which
    // made rolling back look impossible when it is a copy away.
    if (backup) {
      log(
        `${OK} Upgraded .bridge/state.json from v${from} to v${STATE_VERSION}. ` +
          `The original is kept at ${path.basename(backup)}.`
      );
      log(dim("  Older versions of context-bridge cannot read the new file; restore that copy to go back."));
    }
  } catch {
    // Read-only project or a race: the migrated state is still correct in memory.
  }
  return withActiveLaneView(s);
}

/** Load or create state (creates .bridge/ layout on first use). */
export function ensureState(projectDir) {
  let s = loadState(projectDir);
  if (!s) {
    // Refuse to initialise a project through a symlinked `.bridge`. Everything
    // below (the state file, the checkpoints and logs directories) is created
    // under `.bridge`, so if the root is a symlink pointing away, the very first
    // `bridge` run would write this project's state and checkpoints outside it.
    // lstat, not exists, so a symlink to a not-yet-existing target is caught too.
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
    ensureGitignore(projectDir);
  }
  return s;
}

export function saveState(projectDir, s) {
  s.updatedAt = nowIso();
  writeJsonAtomic(statePath(projectDir), s);
  return s;
}

/** A synchronous pause with no busy spin, so lock retries do not peg a core. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable: fall back to a short spin.
    const until = Date.now() + ms;
    while (Date.now() < until) {}
  }
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
 * waited on rather than raced. Stealing renames the lock to a private name first,
 * so the delete only ever removes a file this process exclusively holds; two
 * stealers racing the same lock cannot both delete it, one wins the rename and the
 * other retries the acquire.
 */
function withStateLock(projectDir, fn, { staleMs = 15000 } = {}) {
  const lock = statePath(projectDir) + ".lock";
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let held = false;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, "wx"); // creating it exclusively IS the acquire
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (stealableLock(lock, staleMs)) stealLock(lock);
      sleepSync(25);
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

/** Take a stealable lock by renaming it away first, so the delete is race-safe. */
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
    let disk = readStateFile(projectDir) ?? {
      version: STATE_VERSION,
      project: projectDir,
      activeLane: laneName ?? DEFAULT_LANE,
      lanes: {},
      launcher: null,
      updatedAt: null,
    };
    while (disk.version < STATE_VERSION) {
      const migrate = MIGRATIONS[disk.version];
      if (!migrate) throw new Error(`.bridge/state.json version ${disk.version} cannot be upgraded by this bridge.`);
      disk = migrate(disk);
    }
    if (!disk.lanes) disk.lanes = {};
    const key = laneName ?? disk.activeLane ?? DEFAULT_LANE;
    if (!disk.lanes[key]) disk.lanes[key] = emptyLane();
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

/** Read-modify-write the active lane, under the lock. A thin alias for
 * `mutateState` on the active lane, kept for callers that read as "update". */
export function updateState(projectDir, fn) {
  ensureState(projectDir); // create the .bridge/ layout on first use
  return mutateState(projectDir, null, fn);
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
export const CHECKPOINT_KINDS = {
  /** The bounded delta the next agent actually reads. */
  delta: ".md",
  /**
   * The same handoff with no budget over it.
   *
   * It was called the companion while it was a delivery aid: written for the
   * receiving session, read at most once, deleted the moment that agent handed
   * off. It is not that any more. Once the delta carries whole messages the two
   * are nearly the same size, and this is the file the delivery layer points at
   * when it has to trim, which can happen after the handoff has already ended.
   * So it outlives its reader and is pruned with its own group like everything
   * else here. The suffix does not change: renaming it on disk would drop every
   * file already written out of the pattern that collects it, which is the bug
   * this registry exists to prevent.
   */
  fullContext: "-full.md",
  /** What the departing agents actually ran; what `bridge inspect` renders. */
  audit: "-audit.json",
};

/** A delivered delta is renamed rather than deleted, so the rename is the record. */
export const CONSUMED_SUFFIX = ".consumed";

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
  if (!isInsideDir(bridge, projectDir)) {
    throw new Error(".bridge does not resolve inside the project; refusing to write checkpoints.");
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
 * project — null otherwise. The read counterpart to `safeCheckpointsDir` (which is
 * for writes and throws): `status` and `inspect` list this directory, and a
 * symlinked lane checkpoints dir would let them enumerate or read files outside the
 * project and present them as this project's own. Returns null rather than throwing,
 * because a read for display must degrade quietly, not crash.
 */
export function readableCheckpointsDir(projectDir, lane) {
  const bridge = bridgeDir(projectDir);
  const dir = checkpointsDir(projectDir, lane);
  if (!isInsideDir(bridge, projectDir) || !isInsideDir(dir, bridge)) return null;
  return dir;
}

/** Write a delta checkpoint file; returns path relative to project. */
export function writeCheckpoint(projectDir, lane, name, content) {
  const dir = safeCheckpointsDir(projectDir, lane);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return path.relative(projectDir, file);
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
