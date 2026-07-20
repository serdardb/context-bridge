// Project-local bridge state: .bridge/state.json
// Stores only native session/thread REFERENCES, timestamps, checkpoints and
// pending markers — never transcripts.
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readJson, nowIso, fileExists } from "./util.mjs";
import { AGENT_IDS } from "./agents/index.mjs";

export const STATE_VERSION = 4;

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

export function defaultState(projectDir) {
  return {
    version: STATE_VERSION,
    project: projectDir,
    activeAgent: null,
    agents: Object.fromEntries(AGENT_IDS.map((agentId) => [agentId, emptyAgent()])),
    // {"target":<agent>,"ready":true,"requestedAt":iso}
    pendingHandoff: null,
    // {"agent":<agent>,"id":<session id|null>,"deltaFile":relpath,"createdAt":iso,
    //  "sources":{<source>:<mark>}}  — what went into the delta, committed to
    //  knownBy once that delta is finalised.
    pendingInjection: null,
    // Last launcher process that opened an agent for this project. This is not
    // required to resume state; it only lets handoff warn when an old launcher is
    // still running after a bridge upgrade.
    launcher: null,
    // knownBy[target][source] = how far into SOURCE's own stream the bridge has
    // packed material for TARGET. This is what makes a chain work: a handoff to
    // an agent carries everything it has not seen, from every agent, not just
    // from whoever is handing off.
    knownBy: {},
    // git checkpoint recorded at each handoff, used for "commits since"
    git: { sha: null, recordedAt: null },
    updatedAt: null,
  };
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

const MIGRATIONS = { 1: migrateV1ToV2, 2: migrateV2ToV3, 3: migrateV3ToV4 };

/**
 * Load state; returns null when no .bridge/state.json exists.
 * Older files are migrated in place, keeping a one-time backup of the original.
 * A file from a NEWER bridge is refused rather than guessed at.
 */
export function loadState(projectDir) {
  const p = statePath(projectDir);
  let s = readJson(p);
  if (!s) return null;
  if (s.version === STATE_VERSION) return s;
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
  return s;
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
