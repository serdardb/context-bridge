import fs from "node:fs";
import path from "node:path";
import { inspectRegisteredProject } from "./project-inspect.mjs";
import { registeredProjects, storageHome, withProjectRegistration, projectOperations } from "./storage.mjs";
import { BridgeError, readOwnedFile, syncPublishedDirectory } from "./util.mjs";

function directoryExists(dir) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BridgeError("Unsafe project lifecycle directory; nothing was removed.");
    return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function importPending(id) {
  const dir = path.join(storageHome(), "imports");
  if (!directoryExists(dir)) return false;
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith(".pending.json"))) {
    const record = JSON.parse(readOwnedFile(path.join(dir, name), { encoding: "utf8" }));
    if (typeof record?.project !== "string") throw new BridgeError("Unrecognized import journal; lifecycle change refused.");
    if (record.project === id) return true;
  }
  return false;
}

function retirementBlockers(id) {
  const report = inspectRegisteredProject(id);
  const blockers = [];
  if (!report.complete) blockers.push("stored evidence could not be completely inspected");
  if (report.pending.length) blockers.push("pending deliveries exist");
  if (report.launchers.length) blockers.push("a recorded launcher is alive");
  if (report.preparations.length) blockers.push("unfinished handoff preparations exist");
  if (report.operations.length) blockers.push("unfinished operation records exist");
  if (report.migrationEvidence.some(entry => entry.file === `migrations/${id}.json` || entry.file.includes(".migrating-"))) {
    blockers.push("unfinished migration evidence exists");
  }
  try { if (importPending(id)) blockers.push("an unfinished artifact import exists"); }
  catch { blockers.push("artifact import journals could not be safely inspected"); }
  return blockers;
}

/** Recoverable rename only. Project code, native sessions and backups stay put. */
export function projectLifecycle(id, action, { apply = false } = {}) {
  if (!["retire", "restore"].includes(action)) throw new BridgeError("Unknown project lifecycle action.");
  const project = registeredProjects().find(record => record.id === id);
  if (!project) throw new BridgeError("Unknown registered project UUID.");
  const target = action === "retire" ? "retired" : "active";
  const transition = action === "retire" ? "retiring" : "restoring";
  const origin = action === "retire" ? "active" : "retired";
  const inspect = record => {
    const current = record.lifecycle ?? "active";
    if (![origin, transition, target].includes(current)) throw new BridgeError("Finish the existing project lifecycle transition before starting another.");
    const blockers = current === "active" && action === "retire" ? retirementBlockers(id) : [];
    if (current === "retired" && action === "restore" && !inspectRegisteredProject(id).complete) blockers.push("archived evidence could not be completely inspected");
    if (current !== target && projectOperations(id).length && !blockers.includes("unfinished operation records exist")) blockers.push("unfinished operation records exist");
    return { id, action, lifecycle: current, applied: false, blockers };
  };
  if (!apply) return inspect(project);
  return withProjectRegistration(id, (record, publish) => {
    const report = inspect(record);
    if (report.blockers.length || report.lifecycle === target) return report;
    const activeBase = path.join(storageHome(), "projects");
    const archiveBase = path.join(storageHome(), "retired-projects");
    for (const base of [activeBase, archiveBase]) directoryExists(base);
    const active = path.join(activeBase, id), archive = path.join(archiveBase, id);
    const source = action === "retire" ? active : archive;
    const destination = action === "retire" ? archive : active;
    const sourcePresent = directoryExists(source), destinationPresent = directoryExists(destination);
    if (sourcePresent && destinationPresent) throw new BridgeError("Both active and archived project stores exist; refusing to merge or overwrite evidence.");
    if (action === "restore" && (record.retirement?.version !== 1 || typeof record.retirement.hadStore !== "boolean")) throw new BridgeError("Invalid retirement journal; evidence retained.");
    if (report.lifecycle !== transition) {
      if (destinationPresent) throw new BridgeError("Unexpected destination store; lifecycle change refused.");
      if (action === "retire") record.retirement = { version: 1, hadStore: sourcePresent, startedAt: new Date().toISOString() };
      record.lifecycle = transition;
      publish();
    }
    if (record.retirement?.version !== 1 || typeof record.retirement.hadStore !== "boolean") throw new BridgeError("Invalid retirement journal; evidence retained.");
    if (record.retirement.hadStore && !sourcePresent && !destinationPresent) throw new BridgeError("Recorded project store is missing; lifecycle transition remains incomplete.");
    if (!record.retirement.hadStore && (sourcePresent || destinationPresent)) throw new BridgeError("Unexpected data for a store recorded as absent; lifecycle transition remains incomplete.");
    if (sourcePresent) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      syncPublishedDirectory(path.dirname(destination));
      syncPublishedDirectory(destination);
      try { fs.renameSync(source, destination); }
      catch (cause) {
        throw new BridgeError("Project store move failed. The lifecycle transition remains pending; inspect storage permissions and filesystem boundaries before retrying. No copy or overwrite fallback was used.", {
          code: "BRIDGE_PROJECT_MOVE_FAILED", cause, nextCommand: `bridge project ${action} ${id} --apply`,
        });
      }
    }
    if (record.retirement.hadStore) {
      syncPublishedDirectory(source);
      syncPublishedDirectory(destination);
    }
    record.lifecycle = target;
    if (action === "restore") delete record.retirement;
    publish();
    return { ...report, lifecycle: target, applied: true };
  });
}
