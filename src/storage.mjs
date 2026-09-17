// Machine-local bridge storage and project identity.
// Runtime state must not live in the user's working tree. Git metadata is only
// optional diagnostic evidence; the registry and filesystem identity own lookup.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeJsonAtomic, processAlive as processIsAlive } from "./util.mjs";
import { CHECKPOINT_KINDS, CONSUMED_SUFFIX } from "./checkpoint-kinds.mjs";
import { withKernelLockSync } from "./locking.mjs";

export const PROJECT_ID_KEY = "context-bridge.project-id";
const REGISTRY_VERSION = 1;
const PROJECT_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function configuredHome() {
  if (process.env.CONTEXT_BRIDGE_HOME) return path.resolve(process.env.CONTEXT_BRIDGE_HOME);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "context-bridge");
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "context-bridge");
}

export function storageHome() {
  return configuredHome();
}

function git(projectDir, args) {
  try {
    return execFileSync("git", ["-C", projectDir, ...args], {
      encoding: "utf8",
      // Optional local metadata must not hold identity resolution indefinitely.
      timeout: 2000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function gitRoot(projectDir) {
  const root = git(projectDir, ["rev-parse", "--show-toplevel"]);
  return root ? path.resolve(root) : null;
}

export function gitProjectId(projectDir) {
  return git(projectDir, ["config", "--local", "--get", PROJECT_ID_KEY]) || null;
}

export function gitMetadata(projectDir) {
  return { branch: git(projectDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    sha: git(projectDir, ["rev-parse", "--verify", "HEAD"]) };
}

export function pathLocator(projectDir) {
  const canonical = fs.realpathSync.native(path.resolve(projectDir));
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function fileIdentity(projectDir) {
  try {
    const stat = fs.statSync(projectDir);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function registryPath() {
  return path.join(storageHome(), "projects.json");
}

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), "utf8"));
    if (parsed?.version !== REGISTRY_VERSION || !parsed.projects || typeof parsed.projects !== "object" ||
        Array.isArray(parsed.projects) || Object.entries(parsed.projects).some(([id, record]) =>
          !PROJECT_UUID.test(id) || !record || record.id !== id ||
          typeof record.path !== "string" || !path.isAbsolute(record.path))) {
      throw new Error(`Global bridge registry is invalid: ${registryPath()}. Refusing to select a new project identity.`);
    }
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return { version: REGISTRY_VERSION, projects: {} };
    if (err.message?.startsWith("Global bridge registry is invalid:")) throw err;
    throw new Error(`Global bridge registry could not be read: ${registryPath()}. Refusing to select a new project identity.`);
  }
}

function writeRegistry(registry) {
  fs.mkdirSync(storageHome(), { recursive: true });
  writeJsonAtomic(registryPath(), registry);
}

function registryLockPath() {
  return `${registryPath()}.lock`;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {}
  }
}

function createStampedLock(lock) {
  const fd = fs.openSync(lock, "wx");
  let closed = false;
  try {
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    closed = true;
  } catch (error) {
    // Exclusive creation already acquired ownership, even if stamping failed.
    if (!closed) { try { fs.closeSync(fd); } catch {} }
    try { fs.rmSync(lock, { force: true }); } catch {}
    throw error;
  }
}

function withRegistryLock(fn) {
  return withKernelLockSync(path.join(storageHome(), "locks", "registry.guard"), () => withRegistryPidLock(fn));
}

function withRegistryPidLock(fn) {
  fs.mkdirSync(storageHome(), { recursive: true });
  const lock = registryLockPath();
  let held = false;
  for (;;) {
    try {
      createStampedLock(lock);
      held = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let owner = null;
      try { owner = Number(fs.readFileSync(lock, "utf8").trim()); } catch {}
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
      // A just-created lock can be observed before its PID is stamped. Never
      // remove that uncertain lock immediately; only an old lock is eligible for
      // recovery when its owner is absent or provably dead.
      if (age > 15000 && !processIsAlive(owner)) {
        try { fs.rmSync(lock, { force: true }); } catch {}
        continue;
      }
      const until = Date.now() + 25;
      while (Date.now() < until) {}
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try { fs.rmSync(lock, { force: true }); } catch {}
    }
  }
}

/** Serialize one project's legacy migration, including the final source move. */
function withMigrationLock(projectId, fn) {
  return withKernelLockSync(path.join(storageHome(), "locks", `${projectId}.migration.guard`), () => withMigrationPidLock(projectId, fn));
}

function withMigrationPidLock(projectId, fn) {
  const dir = path.join(storageHome(), "migrations");
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `${projectId}.lock`);
  let held = false;
  for (;;) {
    try {
      createStampedLock(lock);
      held = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let owner = null;
      try { owner = Number(fs.readFileSync(lock, "utf8").trim()); } catch {}
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
      if (age > 15000 && !processIsAlive(owner)) {
        try { fs.rmSync(lock, { force: true }); } catch {}
        continue;
      }
      sleepSync(25);
    }
  }
  try { return fn(); } finally {
    if (held) {
      try { fs.rmSync(lock, { force: true }); } catch {}
    }
  }
}

function newProjectId() {
  return crypto.randomUUID();
}

/**
 * Resolve a project without making Git a prerequisite. The registry is the
 * authority for runtime identity. A directory's device/inode pair detects a
 * same-filesystem move; the path is retained as a human-facing locator. Git's
 * local config is an optional diagnostic annotation when a user or another tool has
 * already placed an id there, never a required bootstrap step.
 */
export function projectIdentity(projectDir, { create = false } = {}) {
  const absolute = path.resolve(projectDir);
  const canonical = fs.realpathSync.native(absolute);
  const root = gitRoot(projectDir);
  const localId = root && gitProjectId(root);
  const identity = fileIdentity(canonical);
  const resolve = (registry) => {
    const records = Object.values(registry.projects);
    // Never match by Git metadata or path alone. A copied `.git/config` can carry
    // the same optional marker to a different clone, and a recreated directory can
    // reuse a path after its old native sessions are gone. Filesystem identity is
    // the only automatic same-machine move signal; cross-device moves require an
    // explicit adoption operation.
    const known =
      records.find((record) => identity && record.fileIdentity === identity) ||
      records.find((record) => !record.fileIdentity && record.path === canonical);
    if (known) {
      if (known.path !== canonical || (localId && known.gitId !== localId)) {
        known.path = canonical;
        if (localId) known.gitId = localId;
        if (create) writeRegistry(registry);
      }
      return { kind: known.gitId ? "git-clone" : "local", id: known.id, root: canonical, portable: false, fileIdentity: identity };
    }
    if (!create) return { kind: "path-locator", id: pathLocator(canonical), root: canonical, portable: false, fileIdentity: identity };
    const id = newProjectId();
    registry.projects[id] = { id, path: canonical, fileIdentity: identity, gitId: localId || null, createdAt: new Date().toISOString() };
    writeRegistry(registry);
    return { kind: localId ? "git-clone" : "local", id, root: canonical, portable: false, fileIdentity: identity };
  };
  return create ? withRegistryLock(() => resolve(readRegistry())) : resolve(readRegistry());
}

export function projectStoreDir(projectDir, { createIdentity = false } = {}) {
  const root = path.join(storageHome(), "projects");
  const store = path.join(root, projectIdentity(projectDir, { create: createIdentity }).id);
  // Being inside storageHome is not enough: a link can alias another project's
  // valid store. Refuse links at both directory levels before any caller reads,
  // creates or prunes files through them.
  for (const entry of [root, store]) {
    let stat;
    try { stat = fs.lstatSync(entry); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe bridge project storage directory: ${entry}`);
  }
  return store;
}

export function registeredProjects() {
  return Object.values(readRegistry().projects).map(({ id, path: root, createdAt }) => ({ id, root, createdAt }));
}

// A vendor may retain its old cwd after explicit project adoption. This only
// authorizes checking an already-linked session, never discovering other ones.
export function wasAdoptedProjectRoot(projectDir, previousRoot) {
  if (typeof previousRoot !== "string" || !path.isAbsolute(previousRoot)) return false;
  const current = projectIdentity(projectDir);
  const record = readRegistry().projects[current.id];
  if (!record || record.path !== current.root || !Array.isArray(record.previousPaths) ||
      !record.previousPaths.includes(path.resolve(previousRoot))) return false;
  try { fs.lstatSync(previousRoot); return false; }
  catch (error) { return error.code === "ENOENT"; }
}

/** Explicitly associate a moved directory with its existing machine-local store. */
export function adoptProject(projectDir, id) {
  if (typeof id !== "string" || !PROJECT_UUID.test(id)) {
    throw new Error("Project adoption requires a project UUID from 'bridge project list'.");
  }
  const canonical = fs.realpathSync.native(path.resolve(projectDir));
  if (!fs.statSync(canonical).isDirectory()) throw new Error("Project adoption requires a directory.");
  if (hasLegacyRuntime(legacyBridgeDir(canonical))) {
    throw new Error("This directory contains legacy bridge state; refusing to merge it with another project.");
  }
  return withRegistryLock(() => {
    const registry = readRegistry();
    const record = registry.projects[id];
    if (!record || record.id !== id) throw new Error(`Unknown bridge project '${id}'.`);
    const identity = fileIdentity(canonical);
    const other = Object.values(registry.projects).find((entry) => entry.id !== id &&
      (entry.path === canonical || (identity && entry.fileIdentity === identity)));
    if (other) throw new Error("This directory is already registered to another bridge project; refusing to merge their sessions.");
    if (record.path !== canonical) {
      try {
        fs.lstatSync(record.path);
        throw new Error("The previous project directory still exists; refusing to link a copy to its sessions.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const previousRoot = record.path;
    if (record.path !== canonical || record.fileIdentity !== identity) {
      record.previousPaths = [...new Set([...(record.previousPaths ?? []), record.path])];
      record.path = canonical;
      record.fileIdentity = identity;
      record.adoptedAt = new Date().toISOString();
      writeRegistry(registry);
    }
    return { id, root: canonical, previousRoot, store: path.join(storageHome(), "projects", id) };
  });
}

/** The runtime directory. Tests may opt into the legacy layout to isolate old fixtures. */
export function runtimeStoreDir(projectDir, { createIdentity = false } = {}) {
  if (process.env.CONTEXT_BRIDGE_STORAGE === "project") return legacyBridgeDir(projectDir);
  // A legacy project remains readable until ensureState performs the explicit
  // migration. This keeps status/doctor useful before the first mutating command.
  const legacy = legacyBridgeDir(projectDir);
  if (fs.existsSync(path.join(legacy, "state.json"))) return legacy;
  return projectStoreDir(projectDir, { createIdentity });
}

/** Create the global registry entry explicitly, at the first mutating boundary. */
export function ensureProjectStore(projectDir) {
  const dir = projectStoreDir(projectDir, { createIdentity: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Prepare a mutating runtime boundary, including one-time legacy migration. */
export function ensureRuntimeStore(projectDir) {
  if (process.env.CONTEXT_BRIDGE_STORAGE === "project") {
    const dir = legacyBridgeDir(projectDir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  migrateLegacyStorage(projectDir);
  return ensureProjectStore(projectDir);
}

export function runtimeStorageBase(projectDir) {
  const legacy = legacyBridgeDir(projectDir);
  return process.env.CONTEXT_BRIDGE_STORAGE === "project" || fs.existsSync(path.join(legacy, "state.json"))
    ? path.resolve(projectDir) : storageHome();
}

function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to migrate a symlinked bridge path: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name));
    return;
  }
  if (!stat.isFile()) throw new Error(`Refusing to migrate an unsupported bridge entry: ${source}`);
  fs.copyFileSync(source, destination);
}

function treeEntries(root, prefix = "") {
  const result = [];
  for (const name of fs.readdirSync(root)) {
    const rel = path.join(prefix, name);
    const full = path.join(root, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to inspect a symlinked bridge path: ${full}`);
    if (stat.isDirectory()) result.push(...treeEntries(full, rel));
    else if (stat.isFile()) {
      const digest = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      result.push([rel, stat.size, digest]);
    }
    else throw new Error(`Refusing to inspect an unsupported bridge entry: ${full}`);
  }
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

function ownedLegacyFile(name) {
  if (["state.json", "state.json.lock", "config.json"].includes(name) || /^state\.json\.v\d+\.backup$/.test(name)) return true;
  const parts = name.split(path.sep);
  const checkpoint = parts.length === 2 && parts[0] === "checkpoints" ||
    parts.length === 4 && parts[0] === "lanes" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[1]) && parts[2] === "checkpoints";
  if (!checkpoint) return false;
  let filename = parts.at(-1);
  if (filename.endsWith(CONSUMED_SUFFIX)) filename = filename.slice(0, -CONSUMED_SUFFIX.length);
  return Object.values(CHECKPOINT_KINDS).some((suffix) => filename.endsWith(suffix) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z]+-to-[a-z]+$/.test(filename.slice(0, -suffix.length)));
}

function removeEmptyLegacyDirs(root, relative = "") {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory() && /^(?:checkpoints|logs|lanes|lanes\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/checkpoints)?)$/.test(child)) {
      removeEmptyLegacyDirs(path.join(root, entry.name), child);
    }
  }
  if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
}

function hasLegacyRuntime(legacy) {
  let stat;
  try { stat = fs.lstatSync(legacy); } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to migrate a non-directory or symlinked bridge path: ${legacy}`);
  }
  return treeEntries(legacy).some(([name]) => ownedLegacyFile(name));
}

function assertLegacyInactive(legacy) {
  const lock = path.join(legacy, "state.json.lock");
  let lockStat;
  try { lockStat = fs.lstatSync(lock); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (lockStat) {
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) throw new Error("Unsafe legacy state lock; refusing migration.");
    const pid = Number(fs.readFileSync(lock, "utf8").trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0 || processIsAlive(pid)) {
      throw new Error("Legacy bridge state is locked by a live or unknown writer. Stop the writer before migrating storage.");
    }
  }
  const stateFile = path.join(legacy, "state.json");
  if (!fs.existsSync(stateFile)) return;
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (error) {
    throw new Error(`Cannot verify legacy launcher state; repair ${stateFile} before migration: ${error.message}`);
  }
  const pids = [...Object.keys(state?.launchers ?? {}).map(Number), Number(state?.launcher?.pid)];
  if (pids.some(processIsAlive)) {
    throw new Error("Legacy bridge has a running launcher. Stop it before migrating storage, then restart it with the updated bridge.");
  }
}

function inspectMigrationStaging(id, target, entries) {
  const result = { removable: [], retained: [] };
  const expected = new Map(entries.map(([name, size, hash]) => [name, `${size}:${hash}`]));
  const locations = [
    [path.dirname(target), new RegExp(`^${id}\\.migrating-(\\d+)-\\d+$`)],
    [path.join(storageHome(), "migrations"), new RegExp(`^${id}-\\d+\\.migrating-(\\d+)$`)],
  ];
  for (const [directory, pattern] of locations) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const match = name.match(pattern);
      if (!match) continue;
      const candidate = path.join(directory, name);
      try {
        if (processIsAlive(Number(match[1]))) throw new Error("owner process is still alive");
        const stat = fs.lstatSync(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a regular staging directory");
        const staged = treeEntries(candidate);
        if (staged.some(([file, size, hash]) => expected.get(file) !== `${size}:${hash}`)) {
          throw new Error("contents are not verified duplicates");
        }
        result.removable.push(candidate);
      } catch (error) {
        result.retained.push({ path: candidate, reason: error.message });
      }
    }
  }
  return result;
}

function cleanupMigrationStaging(id, target, backup) {
  const result = inspectMigrationStaging(id, target, treeEntries(backup));
  const removed = [];
  for (const candidate of result.removable) {
    try {
      fs.rmSync(candidate, { recursive: true });
      removed.push(candidate);
    } catch (error) { result.retained.push({ path: candidate, reason: error.message }); }
  }
  return { removed, retained: result.retained };
}

/** Inspect migration inputs without registering a project or writing any files. */
export function planLegacyMigration(projectDir) {
  const source = legacyBridgeDir(projectDir);
  const plan = {
    needed: false, source, target: null, createsIdentity: false, recovery: null,
    backupRoot: path.join(storageHome(), "migrations"),
    staging: { removable: [], retained: [] },
    files: [], bytes: 0, removedEntries: [], retainedEntries: [], blockers: [],
  };
  try {
    plan.needed = hasLegacyRuntime(source);
    if (plan.needed) assertLegacyInactive(source);
    const identity = projectIdentity(projectDir);
    const journal = path.join(storageHome(), "migrations", `${identity.id}.json`);
    const recovering = identity.kind !== "path-locator" && fs.existsSync(journal);
    if (!plan.needed && !recovering) {
      if (identity.kind !== "path-locator") {
        plan.target = projectStoreDir(projectDir);
        if (fs.existsSync(plan.target)) plan.staging = inspectMigrationStaging(identity.id, plan.target, treeEntries(plan.target));
      }
      return plan;
    }
    plan.needed = true;
    plan.createsIdentity = identity.kind === "path-locator";
    // A provisional path hash is not the future UUID. Do not advertise a path
    // that the actual migration will never use.
    plan.target = plan.createsIdentity ? null : projectStoreDir(projectDir);
    let entries;
    if (recovering) {
      const record = readMigrationJournal(journal, identity.id, source, plan.target);
      plan.recovery = { backup: record.backup, action: "finish-source-cleanup" };
      entries = inspectLegacyCleanup(source, plan.target, record.backup);
    } else entries = treeEntries(source);
    plan.files = entries.map(([name, bytes, sha256]) => ({ name, bytes, sha256 }));
    plan.bytes = entries.reduce((total, [, bytes]) => total + bytes, 0);
    plan.removedEntries = entries.map(([name]) => name).filter(ownedLegacyFile);
    plan.retainedEntries = entries.map(([name]) => name).filter((name) => !ownedLegacyFile(name));
    if (plan.target) plan.staging = inspectMigrationStaging(identity.id, plan.target,
      recovering ? treeEntries(plan.recovery.backup) : entries);
    if (!recovering && plan.target && fs.existsSync(plan.target) && JSON.stringify(entries) !== JSON.stringify(treeEntries(plan.target))) {
      plan.blockers.push("Global storage has different contents; migration will refuse to merge it.");
    }
  } catch (error) {
    plan.blockers.push(error.message);
  }
  return plan;
}

/** Stage and verify both destination and backup before journaled source cleanup. */
export function migrateLegacyStorage(projectDir) {
  if (process.env.CONTEXT_BRIDGE_STORAGE === "project") return false;
  const legacy = legacyBridgeDir(projectDir);
  const hasLegacy = hasLegacyRuntime(legacy);
  if (hasLegacy) assertLegacyInactive(legacy);
  const identity = projectIdentity(projectDir, { create: hasLegacy });
  if (identity.kind === "path-locator") return false;
  const journal = path.join(storageHome(), "migrations", `${identity.id}.json`);
  if (!hasLegacy && !fs.existsSync(journal)) return false;
  const target = projectStoreDir(projectDir);
  return withMigrationLock(identity.id, () => {
    if (hasLegacyRuntime(legacy)) assertLegacyInactive(legacy);
    if (fs.existsSync(journal)) {
      const record = readMigrationJournal(journal, identity.id, legacy, target);
      finishLegacyCleanup(legacy, target, record.backup);
      const stagingCleanup = cleanupMigrationStaging(identity.id, target, record.backup);
      fs.unlinkSync(journal);
      return { identity, target, backup: record.backup, recovered: true, stagingCleanup };
    }
    // Re-read after acquiring the lock. Another process may have completed the
    // migration while this process was waiting.
    if (!hasLegacyRuntime(legacy)) return false;
    const targetExists = fs.existsSync(target);
    const targetEntries = targetExists ? treeEntries(target) : [];
    const staging = `${target}.migrating-${process.pid}-${Date.now()}`;
    let backupStaging = null;
    try {
    const sourceEntries = treeEntries(legacy);
    if (targetExists) {
      if (JSON.stringify(sourceEntries) !== JSON.stringify(targetEntries)) {
        throw new Error(`Global bridge storage already exists for this project with different contents; refusing to merge legacy ${legacy}.`);
      }
    } else {
      copyTree(legacy, staging);
      const copiedEntries = treeEntries(staging);
      if (JSON.stringify(sourceEntries) !== JSON.stringify(copiedEntries)) {
        throw new Error("Legacy bridge storage changed or could not be verified during migration.");
      }
      fs.renameSync(staging, target);
    }
    // Copying to a staging directory makes the final backup safe across filesystems;
    // renameSync alone would fail with EXDEV and leave the migration half-complete.
    const backup = path.join(storageHome(), "migrations", `${identity.id}-${Date.now()}`);
    backupStaging = `${backup}.migrating-${process.pid}`;
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    copyTree(legacy, backupStaging);
    const finalSourceEntries = treeEntries(legacy);
    if (JSON.stringify(sourceEntries) !== JSON.stringify(finalSourceEntries) ||
        JSON.stringify(finalSourceEntries) !== JSON.stringify(treeEntries(backupStaging))) {
      throw new Error("Legacy bridge storage changed or could not be verified before backup.");
    }
    fs.renameSync(backupStaging, backup);
    writeJsonAtomic(journal, { version: 1, source: legacy, target, backup });
    finishLegacyCleanup(legacy, target, backup);
    const stagingCleanup = cleanupMigrationStaging(identity.id, target, backup);
    fs.unlinkSync(journal);
    return { identity, target, backup, stagingCleanup };
    } catch (err) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      try { if (backupStaging) fs.rmSync(backupStaging, { recursive: true, force: true }); } catch {}
      // A failed backup copy must not leave a misleading partial backup around.
      // The original legacy tree and any verified global target remain intact.
      throw err;
    }
  });
}

// The verified backup is the recovery inventory. A restart may see a subset of
// the original source, but never accept changed or newly added source files.
function readMigrationJournal(journal, id, source, target) {
  const stat = fs.lstatSync(journal);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe legacy migration recovery journal.");
  const record = JSON.parse(fs.readFileSync(journal, "utf8"));
  const sameSource = typeof record?.source === "string" && path.basename(record.source) === ".bridge" &&
    fs.realpathSync(path.dirname(record.source)) === fs.realpathSync(path.dirname(source));
  if (!record || record.version !== 1 || !sameSource || record.target !== target ||
      typeof record.backup !== "string" || path.dirname(record.backup) !== path.dirname(journal) ||
      !path.basename(record.backup).startsWith(`${id}-`) ||
      !/^\d+$/.test(path.basename(record.backup).slice(id.length + 1))) {
    throw new Error("Invalid legacy migration recovery journal; refusing cleanup.");
  }
  return record;
}

function inspectLegacyCleanup(legacy, target, backup) {
  for (const root of [backup, target]) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe migration recovery directory: ${root}`);
  }
  const entries = treeEntries(backup);
  if (JSON.stringify(entries) !== JSON.stringify(treeEntries(target))) {
    throw new Error("Migration recovery target differs from its verified backup; refusing cleanup.");
  }
  if (!fs.existsSync(legacy)) return [];
  const stat = fs.lstatSync(legacy);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe legacy migration recovery source.");
  const remaining = treeEntries(legacy);
  const expected = new Map(entries.map(([name, size, hash]) => [name, `${size}:${hash}`]));
  for (const [name, size, hash] of remaining) {
    if (expected.get(name) !== `${size}:${hash}`) throw new Error(`Legacy bridge file changed before removal: ${name}`);
  }
  return remaining;
}

function finishLegacyCleanup(legacy, target, backup) {
  const remaining = inspectLegacyCleanup(legacy, target, backup);
  for (const [name, , hash] of remaining) {
    if (!ownedLegacyFile(name)) continue;
    const file = path.join(legacy, name);
    if (!fs.lstatSync(file).isFile() || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== hash) {
      throw new Error(`Legacy bridge file changed before removal: ${name}`);
    }
    fs.unlinkSync(file);
  }
  if (fs.existsSync(legacy)) removeEmptyLegacyDirs(legacy);
}

export function runtimePath(projectDir, name, options = {}) {
  return path.join(projectStoreDir(projectDir, options), name);
}

export function legacyBridgeDir(projectDir) {
  return path.join(path.resolve(projectDir), ".bridge");
}

/** Remove only exact legacy bridge ignore rules, and only on explicit request. */
export function cleanupLegacyIgnore(projectDir, { apply = false } = {}) {
  const file = path.join(path.resolve(projectDir), ".gitignore");
  const result = { file, matches: [], applied: false, blocked: null };
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Refusing to edit a non-file or symlinked .gitignore.");
  const original = fs.readFileSync(file);
  const text = original.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(original)) throw new Error("Refusing to rewrite a non-UTF-8 .gitignore.");
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const kept = lines.filter((line, index) => {
    const rule = line.replace(/\r?\n$/, "");
    if (![".bridge", ".bridge/", "/.bridge", "/.bridge/"].includes(rule)) return true;
    result.matches.push({ line: index + 1, rule });
    return false;
  });
  if (!result.matches.length) return result;
  try {
    fs.lstatSync(legacyBridgeDir(projectDir));
    result.blocked = "Project-local .bridge still exists; migrate or inspect its retained files before removing ignore rules.";
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!apply || result.blocked) return result;
  const temporary = `${file}.bridge-${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", stat.mode & 0o777);
    fs.fchmodSync(fd, stat.mode & 0o777);
    fs.writeFileSync(fd, kept.join(""));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || current.ino !== stat.ino ||
        current.dev !== stat.dev || !fs.readFileSync(file).equals(original)) {
      throw new Error(".gitignore changed during cleanup; refusing to overwrite it.");
    }
    fs.renameSync(temporary, file);
    result.applied = true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
  return result;
}
