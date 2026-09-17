import fs from "node:fs";
import path from "node:path";
import { loadState, laneDirsOnDisk, isValidLaneName, readableCheckpointsDir, CHECKPOINT_KINDS, CONSUMED_SUFFIX, DEFAULT_LANE } from "./state.mjs";
import { AGENT_IDS } from "./agents/index.mjs";

function lanesFor(projectDir, wanted) {
  if (wanted) {
    if (!isValidLaneName(wanted)) throw new Error(`Invalid lane name '${wanted}'.`);
    return [wanted];
  }
  const state = loadState(projectDir, { readOnly: true });
  return [...new Set([DEFAULT_LANE, ...Object.keys(state?.lanes ?? {}), ...laneDirsOnDisk(projectDir)])].filter(isValidLaneName);
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
  const found = [];
  let from = 0;
  while (true) {
    const at = lower.indexOf(wanted, from);
    if (at < 0) break;
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    const lineEnd = text.indexOf("\n", at);
    found.push({ line: text.slice(0, at).split("\n").length, text: text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim().slice(0, 300) });
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
  for (const currentLane of lanesFor(projectDir, lane)) {
    const dir = readableCheckpointsDir(projectDir, currentLane);
    if (!dir) continue;
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const kind = kindFor(name);
      if (!kind) continue;
      const base = name.endsWith(CONSUMED_SUFFIX) ? name.slice(0, -CONSUMED_SUFFIX.length) : name;
      const stem = base.slice(0, -CHECKPOINT_KINDS[kind].length);
      if (branch !== null) {
        // Branch belongs to the historical handoff, never the current checkout.
        // Treat missing/old/unsafe metadata as unknown, not as a match.
        try {
          const audit = path.join(dir, stem + CHECKPOINT_KINDS.audit);
          if (!fs.lstatSync(audit).isFile() || JSON.parse(fs.readFileSync(audit, "utf8")).git?.branch !== branch) continue;
        } catch { continue; }
      }
      const route = stem.match(/-([a-z]+)-to-([a-z]+)$/);
      if (agent && (!route || !route.slice(1).includes(agent))) continue;
      if (since || until) {
        const stamp = stem.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
        const time = stamp ? Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`) : NaN;
        if (!Number.isFinite(time) || time < lower || time > upper) continue;
      }
      let text;
      try {
        const file = path.join(dir, name);
        if (!fs.lstatSync(file).isFile()) continue;
        text = fs.readFileSync(file, "utf8");
      } catch { continue; }
      const found = matches(text, query.trim());
      if (found.length) results.push({ lane: currentLane, kind, file: name, matches: found });
    }
  }
  return results.sort((a, b) => `${b.file}\0${a.lane}`.localeCompare(`${a.file}\0${b.lane}`));
}
