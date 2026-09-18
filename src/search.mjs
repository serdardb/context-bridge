import fs from "node:fs";
import path from "node:path";
import { loadState, laneDirsOnDisk, isValidLaneName, readableCheckpointsDir, CHECKPOINT_KINDS, CONSUMED_SUFFIX, DEFAULT_LANE } from "./state.mjs";
import { AGENT_IDS } from "./agents/index.mjs";
import { readOwnedFile } from "./util.mjs";

function lanesFor(projectDir, wanted, issues) {
  if (wanted) {
    if (!isValidLaneName(wanted)) throw new Error(`Invalid lane name '${wanted}'.`);
    return [wanted];
  }
  const state = loadState(projectDir, { readOnly: true });
  const disk = laneDirsOnDisk(projectDir, { onUnavailable: (reason, lane = null) => issues.push({ lane, reason }) });
  return [...new Set([DEFAULT_LANE, ...Object.keys(state?.lanes ?? {}), ...disk])].filter(isValidLaneName);
}

function kindFor(name) {
  if (name.endsWith(CONSUMED_SUFFIX)) name = name.slice(0, -CONSUMED_SUFFIX.length);
  for (const [kind, suffix] of Object.entries(CHECKPOINT_KINDS).sort((a, b) => b[1].length - a[1].length)) {
    if (name.endsWith(suffix)) return kind;
  }
  return null;
}

function dateBoundary(value, end = false) {
  if (value === null) return end ? Infinity : -Infinity;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Search dates must use YYYY-MM-DD (UTC).");
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error(`Invalid search date '${value}'.`);
  return time + (end ? 86400000 - 1 : 0);
}

function matches(text, needle) {
  const lower = text.toLocaleLowerCase();
  const wanted = needle.toLocaleLowerCase();
  const lines = text.split("\n");
  const found = [];
  let from = 0;
  while (true) {
    const at = lower.indexOf(wanted, from);
    if (at < 0) break;
    // Case conversion can expand characters; offsets only belong to `lower`.
    // Newlines survive conversion, so their count still identifies the source line.
    const line = lower.slice(0, at).split("\n").length;
    found.push({ line, text: lines[line - 1].trim().slice(0, 300) });
    from = at + Math.max(1, wanted.length);
    if (found.length >= 20) break;
  }
  return found;
}

export function searchProject(projectDir, query, { lane = null, agent = null, branch = null, since = null, until = null } = {}) {
  if (typeof query !== "string" || !query.trim()) throw new Error("Search needs a non-empty query.");
  if (agent && !AGENT_IDS.includes(agent)) throw new Error(`Unknown search agent '${agent}'.`);
  if (branch !== null && (typeof branch !== "string" || !branch.trim())) throw new Error("Search branch must not be empty.");
  const lower = dateBoundary(since);
  const upper = dateBoundary(until, true);
  if (lower > upper) throw new Error("Search --since must not be after --until.");
  const results = [];
  const issues = [];
  for (const currentLane of lanesFor(projectDir, lane, issues)) {
    const dir = readableCheckpointsDir(projectDir, currentLane);
    const issue = (reason, file) => issues.push({ lane: currentLane, ...(file ? { file } : {}), reason });
    if (!dir) { issue("unsafe-checkpoints-directory"); continue; }
    let names;
    try { names = fs.readdirSync(dir); } catch (error) {
      if (error.code !== "ENOENT") issue("unreadable-checkpoints-directory");
      continue;
    }
    for (const name of names) {
      const kind = kindFor(name);
      if (!kind) continue;
      const base = name.endsWith(CONSUMED_SUFFIX) ? name.slice(0, -CONSUMED_SUFFIX.length) : name;
      const stem = base.slice(0, -CHECKPOINT_KINDS[kind].length);
      const route = stem.match(/-([a-z]+)-to-([a-z]+)$/);
      if (agent && (!route || !route.slice(1).includes(agent))) continue;
      if (since || until) {
        const stamp = stem.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
        const time = stamp ? Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`) : NaN;
        if (!Number.isFinite(time) || time < lower || time > upper) continue;
      }
      if (branch !== null) {
        // Unknown historical metadata cannot establish either a match or a miss.
        let recorded;
        try {
          const audit = path.join(dir, stem + CHECKPOINT_KINDS.audit);
          recorded = JSON.parse(readOwnedFile(audit, { encoding: "utf8" })).git?.branch;
        } catch { issue("unknown-branch", name); continue; }
        if (typeof recorded !== "string" || !recorded.trim()) { issue("unknown-branch", name); continue; }
        if (recorded !== branch) continue;
      }
      let text;
      try {
        const file = path.join(dir, name);
        text = readOwnedFile(file, { encoding: "utf8" });
      } catch (error) { issue(error.code === "BRIDGE_UNSAFE_FILE" ? "unsafe-checkpoint" : "unreadable-checkpoint", name); continue; }
      const found = matches(text, query.trim());
      if (found.length) results.push({ lane: currentLane, kind, file: name, matches: found });
    }
  }
  results.sort((a, b) => `${b.file}\0${a.lane}`.localeCompare(`${a.file}\0${b.lane}`));
  return { results, incomplete: issues.length > 0, issues, snippetsOnly: true };
}
