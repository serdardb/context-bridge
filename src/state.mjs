// Project-local bridge state: .bridge/state.json
// Stores only native session/thread REFERENCES, timestamps, checkpoints and
// pending markers — never transcripts.
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readJson, nowIso, fileExists } from "./util.mjs";
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

export function bridgeDir(projectDir) {
  return path.join(projectDir, ".bridge");
}

export function statePath(projectDir) {
  return path.join(bridgeDir(projectDir), "state.json");
}

export function checkpointsDir(projectDir) {
  return path.join(bridgeDir(projectDir), "checkpoints");
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
export function loadState(projectDir) {
  const p = statePath(projectDir);
  let s = readJson(p);
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
  try {
    try {
      // COPYFILE_EXCL: the first backup is the real original, so never overwrite
      // it — a later restore-and-remigrate must not clobber the good copy.
      fs.copyFileSync(p, `${p}.v${from}.backup`, fs.constants.COPYFILE_EXCL);
    } catch {
      // Backup already exists: keep it.
    }
    writeJsonAtomic(p, s);
  } catch {
    // Read-only project or a race: the migrated state is still correct in memory.
  }
  return withActiveLaneView(s);
}

/** Load or create state (creates .bridge/ layout on first use). */
export function ensureState(projectDir) {
  let s = loadState(projectDir);
  if (!s) {
    s = defaultState(projectDir);
    saveState(projectDir, s);
    fs.mkdirSync(checkpointsDir(projectDir), { recursive: true });
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

/** Read-modify-write helper. */
export function updateState(projectDir, fn) {
  const s = ensureState(projectDir);
  fn(s);
  return saveState(projectDir, s);
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

/** Write a delta checkpoint file; returns path relative to project. */
export function writeCheckpoint(projectDir, name, content) {
  const dir = checkpointsDir(projectDir);
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
