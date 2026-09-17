import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureProjectStore, projectStoreDir, projectIdentity } from "../storage.mjs";
import { writeFileExclusive } from "../util.mjs";
import { resolveAiderRuntime, AIDER_SDK_VERSION } from "./aider-runtime.mjs";
import { readAiderHistory, readAiderEvidence } from "./aider-records.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalid = () => new Error("Aider session identity or storage is invalid; refusing to link it.");

function directory(file, create = false) {
  if (create) fs.mkdirSync(file, { mode: 0o700 });
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
}

export function aiderSessionsDirectory(projectDir, { create = false } = {}) {
  const store = create ? ensureProjectStore(projectDir) : projectStoreDir(projectDir);
  let dir = store;
  for (const name of ["agents", "aider"]) {
    dir = path.join(dir, name);
    try { directory(dir); }
    catch (error) {
      if (error.code !== "ENOENT" || !create) throw error;
      try { directory(dir, true); }
      catch (race) { if (race.code !== "EEXIST") throw race; directory(dir); }
    }
  }
  return dir;
}

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw invalid();
  return stat;
}

export function aiderSessionRef(projectDir, id) {
  if (typeof id !== "string" || !uuid.test(id)) throw invalid();
  const dir = path.join(aiderSessionsDirectory(projectDir), id);
  directory(dir);
  const file = path.join(dir, "session.json");
  const before = regular(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let meta;
  try {
    const opened = fs.fstatSync(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw invalid();
    meta = JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
  const projectId = projectIdentity(projectDir).id;
  if (meta?.version !== 1 || meta.id !== id || meta.projectId !== projectId ||
      typeof meta.createdAt !== "string" || !Number.isFinite(Date.parse(meta.createdAt)) || meta.sdkVersion !== AIDER_SDK_VERSION ||
      typeof meta.python !== "string" || !path.isAbsolute(meta.python) || meta.python.includes("\0")) throw invalid();
  const transcriptPath = path.join(dir, "chat.md"), eventsPath = path.join(dir, "events.jsonl");
  regular(path.join(dir, "input.txt"));
  try { regular(path.join(dir, "session.lock")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const historyStat = regular(transcriptPath);
  // A freshly prepared session has no native startup header until Aider runs.
  const history = historyStat.size === 0 ? { text: "", bytes: Buffer.alloc(0) } : readAiderHistory(transcriptPath);
  readAiderEvidence(eventsPath, history, { sessionId: id, projectId });
  return { id, projectId, transcriptPath, eventsPath, python: meta.python,
    inputHistoryPath: path.join(dir, "input.txt"), lockPath: path.join(dir, "session.lock"),
    startedAt: meta.createdAt, updatedAt: historyStat.mtime.toISOString(), deterministic: true };
}

export function createAiderSession(projectDir, { env = process.env } = {}) {
  // Refuse an incompatible interpreter before touching project storage.
  const runtime = resolveAiderRuntime({ env, cwd: projectDir });
  const parent = aiderSessionsDirectory(projectDir, { create: true });
  const id = randomUUID(), projectId = projectIdentity(projectDir).id;
  const stage = path.join(parent, `.creating-${id}`), destination = path.join(parent, id);
  directory(stage, true);
  try {
    const meta = { version: 1, id, projectId, createdAt: new Date().toISOString(),
      python: runtime.cmd, sdkVersion: runtime.sdkVersion };
    writeFileExclusive(path.join(stage, "session.json"), JSON.stringify(meta) + "\n");
    writeFileExclusive(path.join(stage, "chat.md"), "");
    writeFileExclusive(path.join(stage, "input.txt"), "");
    writeFileExclusive(path.join(stage, "events.jsonl"), JSON.stringify({ type: "session", version: 1, sessionId: id, projectId }) + "\n");
    fs.renameSync(stage, destination);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return aiderSessionRef(projectDir, id);
}

export function aiderSessionsForProject(projectDir) {
  let parent;
  try { parent = aiderSessionsDirectory(projectDir); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return fs.readdirSync(parent).filter((name) => uuid.test(name))
    .map((id) => aiderSessionRef(projectDir, id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function aiderStartedSessions(projectDir, { startedAt, childPid } = {}) {
  if (!Number.isSafeInteger(childPid) || childPid <= 0 || !Number.isFinite(Date.parse(startedAt))) return [];
  return aiderSessionsForProject(projectDir).filter((ref) => {
    const file = path.join(path.dirname(ref.eventsPath), "launch.json");
    let launch;
    try { regular(file); launch = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    return launch?.version === 1 && launch.sessionId === ref.id && launch.projectId === ref.projectId &&
      launch.pid === childPid && typeof launch.at === "string" && Date.parse(launch.at) >= Date.parse(startedAt);
  });
}
