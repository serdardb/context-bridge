// Machine-local bridge storage and project identity.
// Runtime state must not live in the user's working tree. Git metadata is only
// optional diagnostic evidence; the registry and filesystem identity own lookup.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeJsonAtomic, writeFileExclusive, readOwnedFile, processAlive as processIsAlive, BridgeError } from "./util.mjs";
import { CHECKPOINT_KINDS, CONSUMED_SUFFIX } from "./checkpoint-kinds.mjs";
import { withKernelLockSync, waitForLock } from "./locking.mjs";

export const PROJECT_ID_KEY = "context-bridge.project-id";
const REGISTRY_VERSION = 1;
const PROJECT_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const runtimeOwners = new Set();

function configuredHome() {
  if (process.env.CONTEXT_BRIDGE_HOME) return path.resolve(process.env.CONTEXT_BRIDGE_HOME);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "context-bridge");
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "context-bridge");
}

export function storageHome() {
  return configuredHome();
}

/** Own synchronous runtime work on a guard outside the movable project store. */
export function withProjectRuntimeLock(projectDir, fn) {
  if (process.env.CONTEXT_BRIDGE_STORAGE === "project") return fn();
  const scope = JSON.stringify([storageHome(), fs.realpathSync.native(path.resolve(projectDir))]);
  // State callbacks write checkpoints and resolve storage again. Only this
  // project scope is reentrant; the lower-level kernel locks stay nonreentrant.
  if (runtimeOwners.has(scope)) return fn();
  const identity = projectIdentity(projectDir, { create: true });
  const guard = path.join(storageHome(), "locks", `${identity.id}.runtime.guard`);
  return withKernelLockSync(guard, () => {
    if (projectIdentity(projectDir).id !== identity.id) {
      throw new BridgeError("Project identity changed while waiting for runtime ownership. Retry after inspecting the project registry.", {
        code: "BRIDGE_PROJECT_IDENTITY_CHANGED", nextCommand: "bridge project list --json",
      });
    }
    runtimeOwners.add(scope);
    try { return fn(); }
    finally { runtimeOwners.delete(scope); }
  });
}

/** Presence blocks identity changes, including uncertain/abandoned records. */
export function projectOperations(id) {
  if (!PROJECT_UUID.test(id)) throw new BridgeError("Invalid project UUID.");
  const base = path.join(storageHome(), "operations"), dir = path.join(base, id);
  for (const candidate of [base, dir]) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BridgeError("Unsafe project operation directory; identity changes refused.");
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  return fs.readdirSync(dir).sort();
}

/** Reserve a synchronous long operation without monopolizing state access. */
export function withProjectOperation(projectDir, operation, fn) {
  if (process.env.CONTEXT_BRIDGE_STORAGE === "project") return fn();
  const owned = withProjectRuntimeLock(projectDir, () => {
    const { id } = projectIdentity(projectDir);
    projectOperations(id); // validate existing parents before creating anything
    const dir = path.join(storageHome(), "operations", id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${crypto.randomUUID()}.json`);
    writeFileExclusive(file, JSON.stringify({ version: 1, project: id, operation, pid: process.pid, startedAt: new Date().toISOString() }));
    return { id, file };
  });
  let failure;
  try { return fn(); }
  catch (error) { failure = error; throw error; }
  finally {
    try {
      withKernelLockSync(path.join(storageHome(), "locks", `${owned.id}.runtime.guard`), () => fs.unlinkSync(owned.file));
    } catch (cause) {
      if (failure) failure.message += " Operation reservation remains; inspect the project before retrying.";
      else throw new BridgeError("Operation completed, but its reservation could not be cleared. Inspect the project before repeating the operation.", {
        code: "BRIDGE_OPERATION_CLEANUP_FAILED", cause, nextCommand: `bridge project inspect ${owned.id} --json`,
      });
    }
  }
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
    const raw = readOwnedFile(registryPath(), { encoding: "utf8", missing: true });
    if (raw === null) return { version: REGISTRY_VERSION, projects: {} };
    const parsed = JSON.parse(raw);
    if (parsed?.version !== REGISTRY_VERSION || !parsed.projects || typeof parsed.projects !== "object" ||
        Array.isArray(parsed.projects) || Object.entries(parsed.projects).some(([id, record]) =>
          !PROJECT_UUID.test(id) || !record || record.id !== id ||
          typeof record.path !== "string" || !path.isAbsolute(record.path))) {
      throw new BridgeError("Global bridge registry is invalid. Refusing to select a new project identity.", { code: "BRIDGE_REGISTRY_INVALID" });
    }
    return parsed;
  } catch (err) {
    if (err.code === "BRIDGE_REGISTRY_INVALID") throw err;
    throw new BridgeError("Global bridge registry could not be read. Refusing to select a new project identity.", {
      code: "BRIDGE_REGISTRY_UNREADABLE", cause: err, operation: "read project registry",
    });
  }
}

function writeRegistry(registry) {
  fs.mkdirSync(storageHome(), { recursive: true });
  writeJsonAtomic(registryPath(), registry);
}

function registryLockPath() {
  return `${registryPath()}.lock`;
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
      }
      waitForLock(lock);
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
      }
      waitForLock(lock);
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
  return Object.values(readRegistry().projects).map(({ id, path: root, createdAt, fileIdentity: recorded }) => {
    let availability;
    let errorCode = null;
    try {
      const stat = fs.lstatSync(root);
      if (stat.isSymbolicLink()) availability = "redirected";
      else if (!stat.isDirectory()) availability = "not-directory";
      else if (recorded && recorded !== `${stat.dev}:${stat.ino}`) availability = "replaced";
      else availability = "present";
    } catch (error) {
      availability = error.code === "ENOENT" || error.code === "ENOTDIR" ? "missing" : "unreadable";
      errorCode = error.code ?? "UNKNOWN";
    }
    // A missing path may be a move or an offline volume, never deletion consent.
    return { id, root, createdAt, availability, errorCode };
  });
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
  const destinationIdentity = fileIdentity(canonical);
  if (hasLegacyRuntime(legacyBridgeDir(canonical))) {
    throw new Error("This directory contains legacy bridge state; refusing to merge it with another project.");
  }
  if (!readRegistry().projects[id]) throw new Error(`Unknown bridge project '${id}'.`);
  // Adoption names the existing UUID, not the new directory's provisional id.
  // Never hold registry ownership while waiting for the runtime owner.
  return withKernelLockSync(path.join(storageHome(), "locks", `${id}.runtime.guard`), () => withRegistryLock(() => {
    const registry = readRegistry();
    const record = registry.projects[id];
    if (!record || record.id !== id) throw new Error(`Unknown bridge project '${id}'.`);
    if (projectOperations(id).length) throw new BridgeError("Project has an unfinished operation; adoption refused. Inspect its operation records before retrying.", {
      code: "BRIDGE_PROJECT_BUSY", nextCommand: `bridge project inspect ${id} --json`,
    });
    const identity = fileIdentity(canonical);
    if (!identity || identity !== destinationIdentity || fs.realpathSync.native(canonical) !== canonical ||
        hasLegacyRuntime(legacyBridgeDir(canonical))) {
      throw new BridgeError("Adoption destination changed while waiting for ownership; refusing to reconnect sessions. Inspect the destination and retry.", {
        code: "BRIDGE_ADOPTION_CHANGED",
      });
    }
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
  }));
}

/** The runtime directory. Tests may opt into the legacy layout to isolate old fixtures. */
export function runtimeStoreDir(projectDir, { createIdentity = false } = {}) {
  if (process.env.CONTEXT_BRIDGE_STORAGE === "project") return legacyBridgeDir(projectDir);
  // A legacy project remains readable until ensureState performs the explicit
  // migration. This keeps status/doctor useful before the first mutating command.
  const legacy = legacyBridgeDir(projectDir);
  const global = projectStoreDir(projectDir);
  if (fs.existsSync(path.join(global, "state.json"))) {
    if (hasLegacyRuntime(legacy)) {
      throw new BridgeError("Both legacy and global runtime data exist. Refusing to choose one or merge them silently. Stop old bridge processes and inspect the migration before continuing.", { code: "BRIDGE_STORAGE_DIVERGED", nextCommand: "bridge storage plan" });
    }
    return global;
  }
  if (fs.existsSync(path.join(legacy, "state.json"))) return legacy;
  return projectStoreDir(projectDir, { createIdentity });
}

/** Create the global registry entry explicitly, at the first mutating boundary. */
export function ensureProjectStore(projectDir) {
  return withProjectRuntimeLock(projectDir, () => {
    const dir = projectStoreDir(projectDir, { createIdentity: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
}

/** Prepare a mutating runtime boundary, including one-time legacy migration. */
export function ensureRuntimeStore(projectDir) {
  if (process.env.CONTEXT_BRIDGE_STORAGE === "project") {
    const dir = legacyBridgeDir(projectDir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  return withProjectRuntimeLock(projectDir, () => {
    migrateLegacyStorage(projectDir);
    return ensureProjectStore(projectDir);
  });
}

export function runtimeStorageBase(projectDir) {
  return runtimeStoreDir(projectDir) === legacyBridgeDir(projectDir) ? path.resolve(projectDir) : storageHome();
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

function syncMigrationPath(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new BridgeError("Unsafe migration evidence during durability check.", { nextCommand: "bridge storage plan" });
  }
  // Node cannot portably flush Windows directories; do not claim that guarantee.
  if (stat.isDirectory() && process.platform === "win32") return;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    fs.fsyncSync(fd);
  } catch (cause) {
    const error = new BridgeError("Migration evidence could not be flushed to storage. Copies and any retired originals are preserved; inspect the migration before retrying.", {
      code: "BRIDGE_MIGRATION_SYNC_FAILED", operation: "flush migration evidence", nextCommand: "bridge storage plan",
    });
    error.cause = cause;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function syncMigrationTree(root) {
  if (fs.lstatSync(root).isDirectory()) {
    for (const entry of fs.readdirSync(root)) syncMigrationTree(path.join(root, entry));
  }
  syncMigrationPath(root);
}

function syncMigrationAncestors(directory) {
  // Include newly created parents, not only the directory containing the file.
  for (let dir = fs.realpathSync(directory);; dir = path.dirname(dir)) {
    syncMigrationPath(dir);
    if (dir === path.dirname(dir)) break;
  }
}

function syncMigrationCopies(target, backup) {
  syncMigrationTree(target);
  syncMigrationTree(backup);
  syncMigrationAncestors(path.dirname(target));
  syncMigrationAncestors(path.dirname(backup));
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
    staging: { removable: [], retained: [] }, completed: [],
    files: [], bytes: 0, removedEntries: [], retainedEntries: [], blockers: [],
  };
  try {
    plan.completed = inspectMigrationReceipts(projectDir);
    for (const receipt of plan.completed) if (receipt.error) plan.blockers.push(receipt.error);
    plan.needed = hasLegacyRuntime(source);
    if (plan.needed) assertLegacyInactive(source);
    const identity = projectIdentity(projectDir);
    const journal = path.join(storageHome(), "migrations", `${identity.id}.json`);
    const recoveryRecord = identity.kind === "path-locator" ? null
      : readMigrationJournal(journal, identity.id, source, projectStoreDir(projectDir));
    const recovering = recoveryRecord !== null;
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
      const record = recoveryRecord;
      plan.recovery = { backup: record.backup, retired: record.retired, action: "finish-source-cleanup" };
      entries = inspectLegacyCleanup(source, plan.target, record.backup, record.retired);
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
export function migrateLegacyStorage(projectDir, { retirementDir = null } = {}) {
  if (process.env.CONTEXT_BRIDGE_STORAGE === "project") return false;
  const legacy = legacyBridgeDir(projectDir);
  const retirementRoot = retirementDir === null ? null : validateRetirementRoot(retirementDir, legacy);
  const hasLegacy = hasLegacyRuntime(legacy);
  if (hasLegacy) assertLegacyInactive(legacy);
  const identity = projectIdentity(projectDir, { create: hasLegacy });
  if (identity.kind === "path-locator") return false;
  const journal = path.join(storageHome(), "migrations", `${identity.id}.json`);
  const target = projectStoreDir(projectDir);
  if (!hasLegacy && readMigrationJournal(journal, identity.id, legacy, target) === null) return false;
  return withProjectRuntimeLock(projectDir, () => withMigrationLock(identity.id, () => {
    if (hasLegacyRuntime(legacy)) assertLegacyInactive(legacy);
    const record = readMigrationJournal(journal, identity.id, legacy, target);
    if (record !== null) {
      if (retirementRoot !== null) {
        const selected = path.join(retirementRoot, path.basename(record.backup));
        if (selected !== record.retired) {
          if (fs.existsSync(record.retired) && treeEntries(record.retired).length) {
            throw new BridgeError("Source retirement has already started at the recorded location; refusing to change its recovery path.", { nextCommand: "bridge storage plan" });
          }
          inspectLegacyCleanup(legacy, target, record.backup, record.retired);
          record.retired = selected;
          writeJsonAtomic(journal, record);
        }
      }
      syncMigrationCopies(target, record.backup);
      syncMigrationPath(journal);
      syncMigrationAncestors(path.dirname(journal));
      finishLegacyCleanup(legacy, target, record.backup, record.retired);
      const stagingCleanup = cleanupMigrationStaging(identity.id, target, record.backup);
      writeMigrationReceipt(identity.id, record.backup, record.retired);
      syncMigrationAncestors(path.join(storageHome(), "migration-receipts"));
      fs.unlinkSync(journal);
      syncMigrationPath(path.dirname(journal));
      return { identity, target, backup: record.backup, retired: record.retired, recovered: true, stagingCleanup };
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
    syncMigrationCopies(target, backup);
    const retired = retirementRoot === null ? retiredMigrationDir(backup) : path.join(retirementRoot, path.basename(backup));
    writeJsonAtomic(journal, { version: 1, source: legacy, target, backup, retired });
    syncMigrationAncestors(path.dirname(journal));
    finishLegacyCleanup(legacy, target, backup, retired);
    const stagingCleanup = cleanupMigrationStaging(identity.id, target, backup);
    writeMigrationReceipt(identity.id, backup, retired);
    syncMigrationAncestors(path.join(storageHome(), "migration-receipts"));
    fs.unlinkSync(journal);
    syncMigrationPath(path.dirname(journal));
    return { identity, target, backup, retired, stagingCleanup };
    } catch (err) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
      try { if (backupStaging) fs.rmSync(backupStaging, { recursive: true, force: true }); } catch {}
      // A failed backup copy must not leave a misleading partial backup around.
      // The original legacy tree and any verified global target remain intact.
      throw err;
    }
  }));
}

// The verified backup is the recovery inventory. A restart may see a subset of
// the original source, but never accept changed or newly added source files.
function readMigrationJournal(journal, id, source, target) {
  let raw;
  try { raw = readOwnedFile(journal, { encoding: "utf8", missing: true }); }
  catch (cause) {
    throw new BridgeError("Migration recovery journal could not be read safely; recovery refused.", {
      code: "BRIDGE_MIGRATION_JOURNAL_UNREADABLE", cause, nextCommand: "bridge storage plan",
    });
  }
  if (raw === null) return null;
  const record = JSON.parse(raw);
  const sameSource = typeof record?.source === "string" && path.basename(record.source) === ".bridge" &&
    fs.realpathSync(path.dirname(record.source)) === fs.realpathSync(path.dirname(source));
  if (!record || record.version !== 1 || !sameSource || record.target !== target ||
      typeof record.backup !== "string" || path.dirname(record.backup) !== path.dirname(journal) ||
      !path.basename(record.backup).startsWith(`${id}-`) ||
      !/^\d+$/.test(path.basename(record.backup).slice(id.length + 1))) {
    throw new Error("Invalid legacy migration recovery journal; refusing cleanup.");
  }
  if (record.retired === undefined) record.retired = retiredMigrationDir(record.backup);
  if (record.retired !== retiredMigrationDir(record.backup)) {
    if (typeof record.retired !== "string" || !path.isAbsolute(record.retired) ||
        path.basename(record.retired) !== path.basename(record.backup) ||
        path.join(validateRetirementRoot(path.dirname(record.retired), source), path.basename(record.backup)) !== record.retired) {
      throw new Error("Invalid migration retirement location; refusing cleanup.");
    }
  }
  return record;
}

function inspectLegacyCleanup(legacy, target, backup, retired = retiredMigrationDir(backup)) {
  for (const root of [backup, target]) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe migration recovery directory: ${root}`);
  }
  const entries = treeEntries(backup);
  if (JSON.stringify(entries) !== JSON.stringify(treeEntries(target))) {
    throw new Error("Migration recovery target differs from its verified backup; refusing cleanup.");
  }
  if (fs.existsSync(retired)) {
    if (!fs.lstatSync(retired).isDirectory() || fs.lstatSync(retired).isSymbolicLink()) {
      throw new Error(`Unsafe migration retirement directory: ${retired}`);
    }
    const expected = new Map(entries.map(([name, size, hash]) => [name, `${size}:${hash}`]));
    for (const [name, size, hash] of treeEntries(retired)) {
      if (expected.get(name) !== `${size}:${hash}`) {
        throw new BridgeError(`A legacy writer changed retired evidence. Stop old bridge processes and recover the newer data from ${retired}; automatic migration is refused.`, { code: "BRIDGE_MIGRATION_CHANGED", nextCommand: "bridge storage plan" });
      }
    }
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

function retiredMigrationDir(backup) {
  return path.join(storageHome(), "retired-migrations", path.basename(backup));
}

function writeMigrationReceipt(projectId, backup, retired) {
  const root = path.join(storageHome(), "migration-receipts");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Unsafe migration receipt directory.");
  writeJsonAtomic(path.join(root, `${path.basename(backup)}.json`), {
    version: 1, projectId, backup, retired, completedAt: new Date().toISOString(),
    files: treeEntries(backup).filter(([name]) => ownedLegacyFile(name)),
  });
}

/** Compare preserved source originals, not the actively changing global state. */
export function inspectMigrationReceipts(projectDir) {
  const identity = projectIdentity(projectDir);
  if (identity.kind === "path-locator") return [];
  const root = path.join(storageHome(), "migration-receipts");
  let stat;
  try { stat = fs.lstatSync(root); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe migration receipt directory.");
  return fs.readdirSync(root).filter((name) => name.startsWith(`${identity.id}-`) && /^\d+\.json$/.test(name.slice(identity.id.length + 1))).sort().map((name) => {
    const file = path.join(root, name);
    const result = { receipt: file, backup: null, retired: null, completedAt: null, changes: [], error: null };
    try {
      const record = JSON.parse(readOwnedFile(file, { encoding: "utf8" }));
      const basename = name.slice(0, -5);
      if (record.version !== 1 || record.projectId !== identity.id ||
          record.backup !== path.join(storageHome(), "migrations", basename) ||
          typeof record.retired !== "string" || !path.isAbsolute(record.retired) || path.basename(record.retired) !== basename ||
          !Number.isFinite(Date.parse(record.completedAt)) || !Array.isArray(record.files) ||
          record.files.some((entry) => !Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== "string" ||
            !ownedLegacyFile(entry[0]) || !Number.isSafeInteger(entry[1]) || entry[1] < 0 || !/^[a-f0-9]{64}$/.test(entry[2])) ||
          new Set(record.files.map(([entry]) => entry)).size !== record.files.length) throw new Error("Invalid migration receipt.");
      Object.assign(result, { backup: record.backup, retired: record.retired, completedAt: record.completedAt });
      const retiredStat = fs.lstatSync(record.retired);
      if (!retiredStat.isDirectory() || retiredStat.isSymbolicLink()) throw new Error("Retired originals are unavailable or unsafe.");
      const expected = new Map(record.files.map(([entry, size, hash]) => [entry, `${size}:${hash}`]));
      const actual = new Map(treeEntries(record.retired).map(([entry, size, hash]) => [entry, `${size}:${hash}`]));
      for (const [entry, value] of expected) {
        if (actual.get(entry) !== value) result.changes.push({ file: entry, reason: actual.has(entry) ? "changed" : "missing" });
      }
      for (const entry of actual.keys()) if (!expected.has(entry)) result.changes.push({ file: entry, reason: "added" });
      if (result.changes.length) result.error = `Retired originals changed after migration: ${record.retired}. Stop old bridge processes and reconcile the preserved evidence; nothing was merged or deleted.`;
    } catch (error) {
      result.error = `Cannot verify migration evidence ${file}: ${error.code === "ENOENT" ? "recorded originals are missing or the volume is unavailable" : error.message}`;
    }
    return result;
  });
}

function validateRetirementRoot(root, legacy) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new BridgeError("--retirement-dir must name an existing absolute directory outside the project.");
  const resolved = fs.realpathSync(root);
  const project = fs.realpathSync(path.dirname(legacy));
  if (!fs.statSync(resolved).isDirectory() || resolved === project || resolved.startsWith(project + path.sep)) {
    throw new BridgeError("The retirement directory must be outside the project; source originals must not remain in the working tree.");
  }
  return resolved;
}

function retirementDirectory(retired, relative = "") {
  let dir = path.dirname(retired);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Unsafe migration retirement directory: ${dir}`);
  for (const part of [path.basename(retired), ...relative.split(path.sep).filter(Boolean)]) {
    dir = path.join(dir, part);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe migration retirement directory: ${dir}`);
  }
  return dir;
}

function finishLegacyCleanup(legacy, target, backup, retired = retiredMigrationDir(backup)) {
  if ([legacy, target, backup].some((root) => retired === root || retired.startsWith(root + path.sep) || root.startsWith(retired + path.sep))) {
    throw new BridgeError("The retirement vault must not overlap the source, global runtime or verified backup.");
  }
  const remaining = inspectLegacyCleanup(legacy, target, backup, retired);
  // Keep the source inode, not just an earlier copy. An old binary can replace
  // state after our hash check, or keep an append descriptor open across rename.
  // These originals are never automatically pruned as duplicate backups.
  retirementDirectory(retired);
  for (const [name, , hash] of remaining) {
    if (!ownedLegacyFile(name)) continue;
    const file = path.join(legacy, name);
    if (!fs.lstatSync(file).isFile() || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== hash) {
      throw new Error(`Legacy bridge file changed before removal: ${name}`);
    }
    const destination = path.join(retired, name);
    retirementDirectory(retired, path.dirname(name) === "." ? "" : path.dirname(name));
    try {
      fs.lstatSync(destination);
      throw new BridgeError(`Legacy data reappeared after retirement: ${file}. Both copies are preserved; stop old bridge processes before recovery.`, { code: "BRIDGE_MIGRATION_CHANGED", nextCommand: "bridge storage plan" });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { fs.renameSync(file, destination); } catch (error) {
      if (error.code !== "EXDEV") throw error;
      throw new BridgeError("Safe legacy retirement requires an atomic move on the source filesystem. Source files and verified backups are preserved. Choose an existing directory outside the project on its filesystem, then run bridge storage migrate --retirement-dir <absolute-directory>.", { code: "BRIDGE_MIGRATION_CROSS_DEVICE", operation: "migrate legacy storage", nextCommand: "bridge storage plan" });
    }
    if (!fs.lstatSync(destination).isFile() || crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex") !== hash) {
      throw new BridgeError(`A legacy writer changed ${name} during retirement. The newer file is preserved at ${destination}; stop old bridge processes before recovery.`, { code: "BRIDGE_MIGRATION_CHANGED", nextCommand: "bridge storage plan" });
    }
    syncMigrationPath(destination);
    syncMigrationAncestors(path.dirname(destination));
    syncMigrationPath(path.dirname(file));
  }
  inspectLegacyCleanup(legacy, target, backup, retired);
  if (hasLegacyRuntime(legacy)) throw new BridgeError("Legacy runtime files reappeared during migration. Stop old bridge processes; all source and retired files are preserved.", { code: "BRIDGE_MIGRATION_CHANGED", nextCommand: "bridge storage plan" });
  if (fs.existsSync(legacy)) removeEmptyLegacyDirs(legacy);
  syncMigrationPath(path.dirname(legacy));
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
    result.blocked = "Project-local .bridge still exists. Run bridge storage plan to inspect retained files; move user files you want to keep, remove the directory only when empty, then rerun bridge storage cleanup-ignore. No files were deleted.";
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
