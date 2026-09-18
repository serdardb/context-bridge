import fs from "node:fs";
import path from "node:path";
import { loadState, readableCheckpointsDir } from "./state.mjs";
import { pendingDeliveryStatus } from "./delivery.mjs";
import { AGENT_IDS } from "./agents/index.mjs";
import { laneWorkspace } from "./worktree.mjs";
import { BridgeError } from "./util.mjs";

export function switchHistory(projectDir, lane) {
  const unreadable = (cause) => new BridgeError("Switch history could not be read safely. Check stored evidence and permissions before retrying; no empty history was assumed.", {
    code: "BRIDGE_HISTORY_UNREADABLE", cause, operation: "read switch history",
  });
  const dir = readableCheckpointsDir(projectDir, lane);
  if (!dir) throw unreadable();
  let names;
  try { names = fs.readdirSync(dir); } catch (cause) {
    if (cause.code === "ENOENT") return [];
    throw unreadable(cause);
  }
  const seen = new Map();
  for (const name of names) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([a-z]+)-to-([a-z]+)/);
    if (!m) continue;
    const [, day, hh, mm, ss, ms, source, target] = m;
    const at = new Date(`${day}T${hh}:${mm}:${ss}.${ms}Z`);
    if (Number.isNaN(at.getTime())) continue;
    seen.set(`${at.toISOString()}-${source}-${target}`, { at, source, target });
  }
  return [...seen.values()].sort((a, b) => b.at - a.at);
}

function laneStatus(projectDir, name, lane) {
  if (Object.hasOwn(lane, "worktree")) {
    try {
      const workspace = laneWorkspace(projectDir, name);
      const child = loadState(workspace.projectDir, { readOnly: true });
      const childLane = child.lanes[workspace.lane];
      if (Object.hasOwn(childLane, "worktree")) throw new Error("Nested workspace link");
      return { ...laneStatus(workspace.projectDir, workspace.lane, childLane), workspace: { kind: "git-worktree", available: true } };
    } catch {
      return { activeAgent: null, linkedAgents: [], pending: null, delivery: null,
        recentSwitches: [], workspace: { kind: "git-worktree", available: false } };
    }
  }
  const pending = lane.pendingHandoff
    ? { kind: "handoff", target: lane.pendingHandoff.target }
    : lane.pendingInjection?.seed ? { kind: "seed" }
      : lane.pendingInjection ? { kind: "injection", agent: lane.pendingInjection.agent } : null;
  return {
    activeAgent: lane.activeAgent ?? null,
    linkedAgents: AGENT_IDS.filter((id) => lane.agents?.[id]?.id),
    pending,
    delivery: pendingDeliveryStatus(projectDir, lane.pendingInjection),
    recentSwitches: switchHistory(projectDir, name).slice(0, 5)
      .map(({ at, source, target }) => ({ at: at.toISOString(), source, target })),
  };
}

// Reads persisted evidence only: no probes, migration writes, session discovery,
// or delivery acknowledgement. The result deliberately omits transcript paths,
// session IDs, opaque watermarks and conversation text.
export function projectStatus(projectDir) {
  const s = loadState(projectDir, { readOnly: true });
  if (!s) return { state: "absent" };
  const lanes = Object.keys(s.lanes).sort().map((name) => ({
    name, active: name === s.activeLane, ...laneStatus(projectDir, name, s.lanes[name]),
  }));
  const active = lanes.find((lane) => lane.active);
  const { name: _name, active: _active, ...current } = active;
  return {
    state: "present", project: path.basename(s.project), activeLane: s.activeLane,
    ...current, lanes,
  };
}
