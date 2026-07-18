// Project-local bridge state: .bridge/state.json
// Stores only native session/thread REFERENCES, timestamps, checkpoints and
// pending markers — never transcripts.
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readJson, nowIso, fileExists } from "./util.mjs";

export const STATE_VERSION = 1;

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

export function defaultState(projectDir) {
  return {
    version: STATE_VERSION,
    project: projectDir,
    activeAgent: null,
    agents: {
      claude: {
        // native refs only
        sessionId: null,
        transcriptPath: null,
        // timestamp up to which CLAUDE has received Codex context
        lastSyncAt: null,
        idle: false,
      },
      codex: {
        threadId: null,
        rolloutPath: null,
        // timestamp up to which CODEX has received Claude context
        lastSyncAt: null,
        idle: false,
      },
    },
    // {"target":"codex"|"claude","ready":true,"requestedAt":iso}
    pendingHandoff: null,
    // {"agent":"claude"|"codex","sessionId":..,"deltaFile":relpath,"createdAt":iso}
    pendingInjection: null,
    // git checkpoint recorded at each handoff, used for "commits since"
    git: { sha: null, recordedAt: null },
    updatedAt: null,
  };
}

/** Load state; returns null when no .bridge/state.json exists. */
export function loadState(projectDir) {
  const s = readJson(statePath(projectDir));
  if (!s) return null;
  if (s.version !== STATE_VERSION) {
    throw new Error(
      `.bridge/state.json version ${s.version} is not supported by this bridge (expected ${STATE_VERSION}).`
    );
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
