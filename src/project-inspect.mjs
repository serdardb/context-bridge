import fs from "node:fs";
import path from "node:path";
import { registeredProjects, storageHome } from "./storage.mjs";
import { STATE_VERSION, liveLaunchers } from "./state.mjs";
import { BridgeError, readOwnedFile } from "./util.mjs";

/** Read stored metadata by UUID even when its former working directory is gone. */
export function inspectRegisteredProject(id) {
  const project = registeredProjects().find(record => record.id === id);
  if (!project) throw new BridgeError("Unknown registered project UUID.", { code: "BRIDGE_PROJECT_UNKNOWN" });
  const report = { ...project, store: "absent", state: "absent", files: 0, bytes: 0,
    pending: [], launchers: [], preparations: [], migrationEvidence: [], issues: [], complete: true };
  const issue = (file, reason) => { report.complete = false; report.issues.push({ file, reason }); };
  // These survive outside the UUID store. Inventory only: a receipt's presence
  // does not validate its contents or the external retirement location it names.
  for (const area of ["migrations", "migration-receipts", "retired-migrations"]) {
    const dir = path.join(storageHome(), area);
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { issue(area, "unsafe-migration-directory"); continue; }
    } catch (error) {
      if (error.code !== "ENOENT") issue(area, "unreadable-migration-directory");
      continue;
    }
    let names;
    try { names = fs.readdirSync(dir).sort(); }
    catch { issue(area, "unreadable-migration-directory"); continue; }
    for (const name of names) {
      if (name !== `${id}.json` && name !== `${id}.lock` && !name.startsWith(`${id}-`)) continue;
      const relative = `${area}/${name}`;
      try {
        const stat = fs.lstatSync(path.join(dir, name));
        if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
          issue(relative, "unsafe-migration-entry");
          continue;
        }
        report.migrationEvidence.push({ file: relative, type: stat.isDirectory() ? "directory" : "file" });
      } catch { issue(relative, "unreadable-migration-entry"); }
    }
  }
  const base = path.join(storageHome(), "projects"), root = path.join(base, id);
  for (const dir of [base, root]) {
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { issue(".", "unsafe-store"); return report; }
    } catch (error) {
      if (error.code !== "ENOENT") issue(".", "unreadable-store");
      return report;
    }
  }
  report.store = "present";
  const scan = (dir, relative = "") => {
    let names;
    try { names = fs.readdirSync(dir).sort(); }
    catch { issue(relative || ".", "unreadable-directory"); return; }
    for (const name of names) {
      const rel = relative ? `${relative}/${name}` : name;
      try {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) issue(rel, "linked-entry");
        else if (stat.isDirectory()) scan(file, rel);
        else if (stat.isFile() && stat.nlink === 1) {
          report.files++;
          report.bytes += stat.size;
          if (name.startsWith(".handoff-") && name.endsWith(".json")) report.preparations.push(rel);
        } else issue(rel, "unsupported-entry");
      } catch { issue(rel, "unreadable-entry"); }
    }
  };
  scan(root);
  try {
    const raw = readOwnedFile(path.join(root, "state.json"), { encoding: "utf8", missing: true });
    if (raw !== null) {
      const state = JSON.parse(raw);
      if (state?.version !== STATE_VERSION || !state.lanes || typeof state.lanes !== "object" || Array.isArray(state.lanes)) {
        report.state = "unsupported";
        issue("state.json", "unsupported-state");
      } else {
        report.state = "present";
        report.launchers = liveLaunchers(state);
        for (const [lane, value] of Object.entries(state.lanes)) {
          if (!value || typeof value !== "object" || Array.isArray(value)) { issue("state.json", "invalid-lane"); continue; }
          if (value.pendingHandoff) report.pending.push({ lane, kind: "handoff" });
          if (value.pendingInjection) report.pending.push({ lane, kind: value.pendingInjection.seed ? "seed" : "injection" });
        }
      }
    }
  } catch { report.state = "unreadable"; issue("state.json", "unreadable-state"); }
  return report;
}
