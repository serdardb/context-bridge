import { runLoop } from "./launcher.mjs";
import { runDoctor } from "./doctor.mjs";
import { runHook } from "./hooks.mjs";
import { handoff } from "./handoff.mjs";
import {
  loadState,
  ensureState,
  readableCheckpointsDir,
  mutateProject,
  mutateState,
  createLane,
  switchActiveLane,
  removeLaneFromState,
  unlinkAgent,
  laneSummaries,
  laneHasLiveLauncher,
  isValidLaneName,
  isInsideDir,
  bridgeDir,
  DEFAULT_LANE,
} from "./state.mjs";
import { pruneCheckpoints, DEFAULT_KEEP_GROUPS, DEFAULT_MAX_AGE_DAYS } from "./clean.mjs";
import { splitLauncherArgs } from "./agentargs.mjs";
import { loadConfig, savedArgs, isDangerous } from "./config.mjs";
import { AGENT_IDS, adapterFor } from "./agents/index.mjs";
import { log, bold, dim, OK, BAD, NONE, WARN } from "./util.mjs";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// Read from the manifest rather than repeating it. This was a hardcoded string,
// and a release bumped package.json while `bridge --version` kept answering the
// previous version to everyone who installed it. Two sources of one truth drift
// the moment somebody remembers only one of them, which is every time.
const VERSION = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
).version;

// Wide enough for the longest command label there actually is. This was a fixed
// 16, which fitted every agent until one was called antigravity and its
// description ran into its name. A fifth agent would have found it again.
const LABEL_WIDTH = Math.max(...AGENT_IDS.map((a) => a.length + " [flags]".length), "doctor [--fix]".length) + 2;
/** Column the descriptions start in: "  " + "bridge " + the widest label. */
const COL = 2 + "bridge ".length + LABEL_WIDTH;
const cmd = (label) => `  ${`bridge ${label}`.padEnd(COL - 2)}`;
const cont = " ".repeat(COL);

export const HELP = `${bold("context-bridge")} ${VERSION} — Switch agents. Not context.

Usage:
${cmd("")}Start the bridged session loop (resumes where you left off)
${AGENT_IDS.map((a) => `${cmd(`${a} [flags]`)}Start the loop with ${adapterFor(a).displayName} ( flags go to it as-is )`).join("\n")}
${cmd("doctor [--fix]")}Check agents, auth, plugins and routes ( --fix bootstraps,
${cont}--deep asks each agent a real one-line question )
${cmd("status")}Show project bridge status
${cmd("inspect")}Show what the last handoff's agents actually ran ( failures first;
${cont}--json for the raw manifest )
${cmd("clean")}Prune old checkpoints (keeps newest ${DEFAULT_KEEP_GROUPS} handoffs and
${cont}everything younger than ${DEFAULT_MAX_AGE_DAYS} days; --dry-run, --keep N,
${cont}--days N, --all; a pending injection is never deleted)
${cmd("lane")}List lines of work in this project ( lane new <name> starts a
${cont}separate one, lane switch <name> moves the default, lane rm <name>
${cont}--yes deletes one; lanes share files, not sessions )
${cmd("unlink <agent>")}Forget one agent's session in the active lane, and every
${cont}watermark that named it, so the next switch links it fresh

Agent flags:
  bridge claude --dangerously-skip-permissions --model claude-fable-5
  Put the agent name first, then its flags. They are forwarded untouched and reused
  every time the bridge reopens it in this launcher run. Nothing is written to
  disk: the next 'bridge' starts from the agent's own defaults again.

  --cb-save-args         Keep the flags typed with this launch in .bridge/config.json
                         and use them every time this agent opens in this project
  --cb-clear-args        Forget them again
  --resume [lane]        Open a specific lane; with no name, pick one from a list
                         ( a bare 'bridge' resumes the lane you were last in )

Recovering a dead agent:
  If an agent hits a quota limit or crashes mid-switch, it cannot run the handoff
  itself and its work is left in its own session. From any healthy terminal:
    bridge handoff <target> --from <the-dead-agent>
  rebuilds the delta straight from that agent's transcript on disk.

Inside the agents:
  ${adapterFor("claude").displayName}:  /bridge <agent>   hand off to another agent
  ${AGENT_IDS.filter((a) => a !== "claude")
    .map((a) => adapterFor(a).displayName)
    .join(", ")}:  $bridge <agent>   hand off to another agent
`;

const LAUNCHER_COMMANDS = AGENT_IDS;
const COMMANDS = [...AGENT_IDS, "doctor", "status", "clean", "inspect", "handoff", "lane", "unlink", "internal-hook", "help", "version"];

export async function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const cmd = args[0];
  const projectDir = process.cwd();

  // --help and --version belong to the bridge only until an agent is named.
  // After `bridge claude` they are Claude's own flags, like every other flag.
  if (!LAUNCHER_COMMANDS.includes(cmd)) {
    if (flags.has("--version") || cmd === "version") {
      log(VERSION);
      return;
    }
    if (flags.has("--help") || cmd === "help") {
      log(HELP);
      return;
    }
  }

  if (AGENT_IDS.includes(cmd)) {
    process.exitCode = await launchAgent(projectDir, cmd, argv);
    return;
  }

  switch (cmd) {
    case undefined:
      // Anything after the agent name is the agent's own flag, forwarded as-is.
      process.exitCode = await launchAgent(projectDir, null, argv);
      return;

    case "doctor":
      process.exitCode = await runDoctor(projectDir, {
        fix: flags.has("--fix"),
        json: flags.has("--json"),
        deep: flags.has("--deep"),
      });
      return;

    case "status": {
      const s = loadState(projectDir);
      if (!s) {
        log(`${NONE} No bridge state in this project yet. Run 'bridge' to start.`);
        return;
      }
      // What this used to print was true and unreadable. Every agent's progress
      // was shown as its raw watermark, and a watermark is opaque by design:
      // Claude's is an ISO instant, Grok's a {rows, ts} object printed as JSON,
      // Antigravity's a bare step number. Three agents, three shapes, one column
      // labelled "synced", and nobody could say synced from what, to whom, or
      // when. The fix is not to format the watermark better. It is to stop
      // showing it: what a person wants is who handed to whom and how recently,
      // and that was already on disk in the checkpoint filenames, unread.
      const debug = flags.has("--debug");
      const history = switchHistory(projectDir, s?.activeLane);
      const lastOut = new Map(); // agent -> when it last handed its work onward
      for (const h of history) if (!lastOut.has(h.source)) lastOut.set(h.source, h.at);

      log(bold("context-bridge") + dim(` · ${s.project}`));
      log("");
      const here = s.activeAgent ? (adapterFor(s.activeAgent)?.displayName ?? s.activeAgent) : dim("nobody yet");
      log(`  You are in     ${here}`);
      const pending = s.pendingHandoff
        ? `handoff → ${adapterFor(s.pendingHandoff.target)?.displayName ?? s.pendingHandoff.target}`
        : s.pendingInjection
          ? `context waiting for ${adapterFor(s.pendingInjection.agent)?.displayName ?? s.pendingInjection.agent}`
          : dim("nothing");
      log(`  Pending        ${pending}`);

      if (history.length) {
        log("");
        log("  Recent switches");
        // Both columns are padded, not just the timestamp: agent names differ in
        // length, so aligning only the stamp leaves the arrows staggered and the
        // list stops being scannable at a glance, which was the whole complaint.
        const recent = history.slice(0, 5).map((h) => ({
          when: clock(h.at),
          from: adapterFor(h.source)?.displayName ?? h.source,
          to: adapterFor(h.target)?.displayName ?? h.target,
        }));
        const stampW = Math.max(...recent.map((h) => h.when.length));
        const fromW = Math.max(...recent.map((h) => h.from.length));
        for (const h of recent) {
          log(`    ${dim(h.when.padEnd(stampW))}  ${h.from.padEnd(fromW)} → ${h.to}`);
        }
      }

      // Outside the block on purpose. The list is only as long as the
      // checkpoints that survive, and when pruning takes all of them there is no
      // list at all — which is precisely when saying so matters most. Keeping
      // this inside the branch meant the notice appeared for a partly-trimmed
      // history and vanished for a completely erased one, telling the least
      // where there was least to see. Found in review.
      const forgotten = AGENT_IDS.some((id) => s.agents?.[id]?.mark && !lastOut.has(id));
      if (forgotten) {
        if (!history.length) {
          log("");
          log("  Recent switches");
        }
        log(dim("    older switches are no longer kept: their checkpoints have been pruned"));
      }

      log("");
      log("  Agents");
      const width = Math.max(...AGENT_IDS.map((a) => (adapterFor(a)?.displayName ?? a).length)) + 3;
      for (const agentId of AGENT_IDS) {
        const slot = s.agents?.[agentId] ?? {};
        const name = (adapterFor(agentId)?.displayName ?? agentId).padEnd(width);
        if (!slot.id) {
          log(`    ${name}${dim("not linked")}`);
          continue;
        }
        const when = lastOut.get(agentId);
        // A mark is only ever set by handing off, so an agent that carries one
        // has handed off whether or not a checkpoint still proves it. Retention
        // deletes those checkpoints, and the first version of this read their
        // absence as "has never handed off" — not incomplete but false, about an
        // agent that had handed off many times. The state knew all along.
        const state =
          agentId === s.activeAgent
            ? "you are here"
            : when
              ? `handed off ${ago(when)}`
              : slot.mark
                ? dim("handed off before the kept history")
                : dim("has never handed off");
        log(`    ${name}${state}${debug ? dim(`   ${slot.id}  mark ${JSON.stringify(slot.mark)}`) : ""}`);
      }

      // Saved launch flags. Listed even when empty for the agents that have them,
      // because a saved permission bypass that nobody can find is one nobody can
      // undo, and `--cb-clear-args` is only useful if you know there is something
      // to clear.
      const config = loadConfig(projectDir);
      const armedAgents = AGENT_IDS.filter((agentId) => savedArgs(config, agentId).length);
      if (armedAgents.length) {
        log("");
        log("  saved launch flags");
        for (const agentId of armedAgents) {
          const args = savedArgs(config, agentId);
          const loud = args.some(isDangerous);
          log(`  ${agentId.padEnd(14)} ${args.join(" ")}${loud ? "   (changes what it may do without asking)" : ""}`);
        }
        log(dim(`  forget them with: bridge <agent> --cb-clear-args`));
      }
      // Work that never made it out of an agent, and the command that frees it.
      //
      // This lives here rather than only in the launcher because the launcher can
      // only speak at the moment an agent exits, and the case it was written for
      // never produces one: an agent out of quota does not die, it sits in its
      // own interface and eventually says the quota is gone. Nothing exits,
      // nothing fires, and the work waits with nobody mentioning it. Status reads
      // the disk instead, so it answers the same whether the agent crashed, hung,
      // stalled on a limit, or was closed days ago — and status is where a
      // confused person actually looks.
      //
      // Only agents that are NOT the active one count. The one you are working in
      // is supposed to have unsent work; saying so every time would be noise, and
      // noise is how a real warning gets ignored.
      for (const agentId of AGENT_IDS) {
        if (agentId === s.activeAgent) continue;
        const slot = s.agents?.[agentId];
        if (!slot?.id) continue;
        let stranded = false;
        try {
          const adapter = adapterFor(agentId);
          const ref = adapter.hydrate(projectDir, slot);
          if (!ref) continue;
          const activity = adapter.activitySince(ref, slot.mark);
          stranded = (activity.messages?.length ?? 0) > 0 || (activity.patchedFiles?.length ?? 0) > 0;
        } catch {
          continue; // an unreadable session is doctor's problem, not this line's
        }
        if (!stranded) continue;
        const target = AGENT_IDS.find((id) => id !== agentId && s.agents?.[id]?.id) ?? "<target>";
        log("");
        log(`  ${adapterFor(agentId).displayName} has work that was never handed off. It is saved, not lost:`);
        log(dim(`    bridge handoff ${target} --from ${agentId}`));
      }

      // Only the gaps. This was a full matrix of who had caught up with whom,
      // which is exact and unreadable: on a healthy project every cell says the
      // same thing and the one cell that matters is buried among them. A pair
      // that has never exchanged anything is worth a sentence; a pair that is up
      // to date is worth nothing, and printing it anyway is how the one real line
      // gets skipped.
      const linked = AGENT_IDS.filter((a) => s.agents?.[a]?.id);
      const gaps = [];
      for (const target of linked) {
        for (const src of linked) {
          if (src === target || s.knownBy?.[target]?.[src]) continue;
          gaps.push(
            `${adapterFor(target)?.displayName ?? target} has never received ` +
              `${adapterFor(src)?.displayName ?? src}'s work`
          );
        }
      }
      if (gaps.length) {
        log("");
        log("  Not yet shared");
        for (const g of gaps) log(`    ${g}`);
      }
      return;
    }

    case "inspect": {
      const { latestManifest, renderManifest } = await import("./audit.mjs");
      const { loadState } = await import("./state.mjs");
      let lane;
      try {
        lane = loadState(projectDir)?.activeLane;
      } catch {}
      const found = latestManifest(projectDir, lane);
      if (!found) {
        log(`${NONE} No audit manifest yet. One is written beside the delta on the next handoff.`);
        return;
      }
      if (flags.has("--json")) {
        log(JSON.stringify(found.manifest, null, 2));
        return;
      }
      log(dim(found.rel));
      log(renderManifest(found.manifest));
      return;
    }

    case "handoff": {
      const target = args[1];
      // `--from` names the departing agent explicitly instead of inferring it.
      // The whole normal flow runs inside the departing agent, so it never needs
      // to say who it is. But when that agent has died — a quota 429, a crash —
      // it cannot run the command at all, and its work is stranded in its own
      // session with no way to carry it forward. This is the escape hatch: from
      // any healthy terminal, `bridge handoff codex --from antigravity` rebuilds
      // the delta straight from the dead agent's transcript on disk, because the
      // agent being alive was never what the handoff actually needed.
      const from = valueOf(argv, "--from") || null;
      const opts = {
        summary: valueOf(argv, "--summary"),
        decisions: valueOf(argv, "--decisions"),
        next: valueOf(argv, "--next"),
        adopt: flags.has("--adopt"),
        from,
      };
      const usage =
        `Usage: bridge handoff <${AGENT_IDS.join("|")}> [--summary "…"] [--decisions "…"] [--next "…"]` +
        " [--from <agent>] [--adopt]";
      if (!AGENT_IDS.includes(target)) {
        log(usage);
        process.exitCode = 1;
        return;
      }
      if (from && !AGENT_IDS.includes(from)) {
        log(`${BAD} Unknown --from agent '${from}'. Known: ${AGENT_IDS.join(", ")}.`);
        process.exitCode = 1;
        return;
      }
      log(handoff(projectDir, target, opts));
      return;
    }

    case "clean": {
      const res = pruneCheckpoints(projectDir, {
        keep: intFlag(argv, "--keep"),
        days: intFlag(argv, "--days"),
        all: flags.has("--all"),
        dryRun: flags.has("--dry-run"),
      });
      if (
        res.skippedCorruptState ||
        res.skippedNoState ||
        res.skippedEscapingBridge ||
        res.skippedMalformedPending ||
        res.skippedInvalidLane
      ) {
        const why = res.skippedCorruptState
          ? ".bridge/state.json could not be read"
          : res.skippedEscapingBridge
            ? ".bridge resolves outside the project (symlink escape)"
            : res.skippedInvalidLane
              ? "state names a lane whose name could not be a real lane directory"
              : res.skippedMalformedPending
                ? "pendingInjection.deltaFile is malformed or points outside the checkpoint namespace"
                : "there are checkpoints but no .bridge/state.json";
        log(
          `${WARN} ${why}, so nothing was pruned. Without readable state a pending delta cannot be told from an orphan, ` +
            `and deleting could take a handoff. Run 'bridge doctor' to sort out the state, then clean.`
        );
        process.exitCode = 1;
        return;
      }
      const verb = flags.has("--dry-run") ? "Would delete" : "Deleted";
      // There is one schedule now. This used to report two, because the full
      // context files were pruned on their own clock and counting groups alone
      // said "nothing to prune" while dozens of files were going.
      if (res.deletedGroups === 0) {
        log(`${NONE} Nothing to prune (${res.groups} checkpoint groups, all recent or protected).`);
      } else {
        log(`${OK} ${verb} ${res.deletedGroups} checkpoint groups (${res.deletedFiles} files). ${res.groups - res.deletedGroups} kept.`);
      }
      return;
    }

    case "lane": {
      process.exitCode = runLane(projectDir, args.slice(1), flags);
      return;
    }

    case "unlink": {
      process.exitCode = runUnlink(projectDir, args[1]);
      return;
    }

    case "internal-hook": {
      // The hook command names the agent it was installed for, so the identity
      // guard can compare that against the environment it actually woke up in.
      const forIndex = argv.indexOf("--agent");
      const hookAgent = forIndex >= 0 ? argv[forIndex + 1] : "claude";
      process.exitCode = await runHook(args[1], AGENT_IDS.includes(hookAgent) ? hookAgent : "claude");
      return;
    }

    default:
      // A flag's value lands here when no agent was named: `bridge --model opus`
      // makes 'opus' look like a command. Say so instead of just "unknown".
      if (flags.size) {
        log(
          `Unknown command '${cmd}'. If it was a value for an agent flag, name the agent first:\n` +
            `  bridge claude ${argv.join(" ")}\n\n${HELP}`
        );
      } else {
        log(`Unknown command '${cmd}'.\n\n${HELP}`);
      }
      process.exitCode = 1;
  }
}

/**
 * Everything except the agent name belongs to the agent — including flags typed
 * before it, so `bridge --model opus claude` cannot drop them silently.
 */
function tailAfter(argv, cmd) {
  if (!cmd) return [...argv];
  const i = argv.indexOf(cmd);
  return i === -1 ? [...argv] : [...argv.slice(0, i), ...argv.slice(i + 1)];
}

function intFlag(argv, name) {
  const v = valueOf(argv, name);
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}


/**
 * Every switch this project has made, newest first, read from the names of the
 * checkpoints themselves.
 *
 * The history was always on disk and never shown: each checkpoint is written as
 * `<when>-<source>-to-<target>`, so the sequence of who handed to whom is
 * recoverable without storing anything new. Status used to answer "how far is
 * each agent synced" with a raw watermark, which told nobody anything, while the
 * question people actually ask — what happened, in what order — sat unread in a
 * directory listing.
 */
function switchHistory(projectDir, lane) {
  // Read through the containment gate: a symlinked lane checkpoints directory must
  // not let status enumerate an external directory and present its names as this
  // project's own switch history.
  const dir = readableCheckpointsDir(projectDir, lane);
  if (!dir) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const seen = new Map();
  for (const name of names) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([a-z]+)-to-([a-z]+)/);
    if (!m) continue;
    const [, day, hh, mm, ss, ms, source, target] = m;
    const at = new Date(`${day}T${hh}:${mm}:${ss}.${ms}Z`);
    if (Number.isNaN(at.getTime())) continue;
    // A handoff writes several files under one stem; count the switch once.
    seen.set(`${at.toISOString()}-${source}-${target}`, { at, source, target });
  }
  return [...seen.values()].sort((a, b) => b.at - a.at);
}

/** "2m ago", "20h ago", "3d ago" — a duration people read without doing arithmetic. */
function ago(date, now = Date.now()) {
  const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * When a switch happened: always the date, always the clock.
 *
 * The first version printed only the time, and dropped the date for anything
 * from today on the theory that the hour is enough within your own day. It is
 * not, because you do not read this only on the day you made the switch: come
 * back after two days and a line saying 10:31 is indistinguishable from this
 * morning. A timestamp that cannot be placed is worse than none, because it
 * gets believed. Serdar caught it by asking the obvious question nobody had.
 */
function clock(date) {
  const day = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return `${day} ${date.toTimeString().slice(0, 5)}`;
}

function valueOf(argv, name) {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(name + "="));
  return pref ? pref.slice(name.length + 1) : "";
}

/**
 * `bridge lane` and its subcommands: the user-facing surface for lines of work.
 *   bridge lane                 list every lane, the active one marked, newest first
 *   bridge lane new <name>      create an empty lane and switch to it
 *   bridge lane switch <name>   point the default lane at an existing one
 *   bridge lane rm <name>       delete a lane and its checkpoints (guarded)
 * Returns a process exit code. `args` is the tail after `lane`.
 */
function runLane(projectDir, args, flags) {
  const sub = args[0];
  const name = args[1];

  if (sub === undefined) {
    const s = loadState(projectDir);
    if (!s) {
      log(`${NONE} No bridge state in this project yet. Run 'bridge' to start.`);
      return 0;
    }
    const summaries = laneSummaries(projectDir, s);
    log(bold("Lanes") + dim(` · ${s.project}`));
    log("");
    const width = Math.max(...summaries.map((l) => l.name.length));
    for (const l of summaries) {
      const marker = l.active ? bold("* ") : "  ";
      const when = l.lastActive ? ago(new Date(l.lastActive)) : "no activity yet";
      const who = l.agents.length
        ? l.agents.map((id) => adapterFor(id)?.displayName ?? id).join(", ")
        : "no agents linked";
      const title = l.title ? dim(` (${l.title})`) : "";
      log(`  ${marker}${l.name.padEnd(width)}${title}  ${dim(when)}  ${dim(who)}`);
    }
    if (summaries.length === 1) {
      log("");
      log(dim("  One lane. 'bridge lane new <name>' starts a second, separate line of work."));
    }
    return 0;
  }

  if (sub === "new") {
    if (!name) {
      log("Usage: bridge lane new <name>");
      return 1;
    }
    if (!isValidLaneName(name)) {
      log(`${BAD} Invalid lane name '${name}'. Use letters, digits, dot, dash or underscore, starting with a letter or digit.`);
      return 1;
    }
    ensureState(projectDir);
    try {
      mutateProject(projectDir, (disk) => {
        createLane(disk, name);
        switchActiveLane(disk, name);
      });
    } catch (e) {
      log(`${BAD} ${e.message}`);
      return 1;
    }
    log(`${OK} Created lane ${bold(name)} and switched to it. The next 'bridge' opens here.`);
    log(dim("  It starts empty on purpose: a new line of work carries no context from another."));
    return 0;
  }

  if (sub === "switch") {
    if (!name) {
      log("Usage: bridge lane switch <name>");
      return 1;
    }
    try {
      mutateProject(projectDir, (disk) => switchActiveLane(disk, name));
    } catch (e) {
      log(`${BAD} ${e.message}`);
      return 1;
    }
    log(`${OK} Switched to lane ${bold(name)}. A bare 'bridge' with no launcher running opens here.`);
    return 0;
  }

  if (sub === "rm") {
    if (!name) {
      log("Usage: bridge lane rm <name> [--dry-run] [--yes]");
      return 1;
    }
    const s = loadState(projectDir);
    if (!s) {
      log(`${NONE} No bridge state in this project yet.`);
      return 1;
    }
    if (name === DEFAULT_LANE) {
      log(`${BAD} The ${DEFAULT_LANE} lane cannot be removed.`);
      return 1;
    }
    if (!s.lanes?.[name]) {
      log(`${BAD} No lane named '${name}'.`);
      return 1;
    }
    if (name === s.activeLane) {
      log(`${BAD} Lane '${name}' is active. Switch away first: bridge lane switch <other>.`);
      return 1;
    }
    // Resurrection itself is blocked in mutateState (it refuses to recreate a
    // removed lane). This guard protects the live session's work: removing a lane a
    // launcher is actively driving would silently drop that session's later writes.
    // The per-lane launcher record makes it exact now — a launcher on ANOTHER lane
    // no longer blocks this removal, only one on the lane being removed does.
    if (laneHasLiveLauncher(s, name)) {
      log(`${BAD} A bridge launcher is running on lane '${name}'.`);
      log(dim("  Close that bridge terminal first, so a live session's work is not lost under the removal."));
      return 1;
    }
    const laneDir = path.join(bridgeDir(projectDir), "lanes", name);
    if (flags.has("--dry-run")) {
      log(`${WARN} Would remove lane ${bold(name)} and its checkpoints (${path.relative(projectDir, laneDir)}/).`);
      return 0;
    }
    if (!flags.has("--yes")) {
      log(`${WARN} Removing lane '${name}' deletes it and its checkpoints, and cannot be undone.`);
      log(dim("  Re-run with --yes to confirm, or --dry-run to preview."));
      return 1;
    }
    try {
      mutateProject(projectDir, (disk) => removeLaneFromState(disk, name));
    } catch (e) {
      log(`${BAD} ${e.message}`);
      return 1;
    }
    // Delete the lane's own directory, but only when it truly resolves inside this
    // project's .bridge — never follow a symlink out on the way to an rm -rf.
    if (isInsideDir(bridgeDir(projectDir), projectDir) && isInsideDir(laneDir, bridgeDir(projectDir))) {
      try {
        fs.rmSync(laneDir, { recursive: true, force: true });
      } catch {
        // the state entry is already gone; a leftover directory is not fatal
      }
    }
    log(`${OK} Removed lane ${bold(name)}.`);
    return 0;
  }

  log(`${BAD} Unknown 'bridge lane' subcommand '${sub}'. Try: bridge lane [new|switch|rm] <name>.`);
  return 1;
}

/**
 * `bridge unlink <agent>`: forget one agent's session in the active lane. Clears
 * its slot and every watermark that names it, in both directions, so the next
 * switch links a fresh session instead of resuming a dead one. Replaces the old
 * `rm -rf .bridge` sledgehammer, which took every agent's link, not just one.
 */
function runUnlink(projectDir, agentId) {
  if (!AGENT_IDS.includes(agentId)) {
    log(`Usage: bridge unlink <${AGENT_IDS.join("|")}>`);
    return 1;
  }
  const s = loadState(projectDir);
  if (!s) {
    log(`${NONE} No bridge state in this project yet.`);
    return 1;
  }
  const name = adapterFor(agentId)?.displayName ?? agentId;
  const lane = s.activeLane ?? DEFAULT_LANE;
  // Unlink is for a session you have finished with. If a launcher is live on this
  // lane, the session may still be running, and its next hook, or a handoff already
  // in flight, would re-link the very agent you just forgot from a pre-unlink
  // snapshot. Refuse while a launcher drives this lane; a launcher on another lane
  // no longer blocks it, now that the record is per-lane. The precise per-session
  // generation barrier is the deferred follow-up.
  if (laneHasLiveLauncher(s, lane)) {
    log(`${BAD} A bridge launcher is running on lane '${lane}'.`);
    log(dim("  Unlink is for a session you are done with. Close that bridge terminal first, so a live session cannot re-link the agent you forget."));
    return 1;
  }
  let changed = false;
  mutateState(projectDir, null, (disk) => {
    changed = unlinkAgent(disk, agentId);
  });
  if (!changed) {
    log(`${NONE} ${name} is not linked in lane ${lane}; nothing to unlink.`);
    return 0;
  }
  log(`${OK} Unlinked ${name} from lane ${bold(lane)}. Its session and every watermark that named it are cleared.`);
  log(dim("  The next switch to it links a fresh session."));
  return 0;
}

/**
 * Resolve which lane to open, then start the launcher on it. `--resume <lane>`
 * enters a named lane, `--resume` alone opens a picker, and no flag resumes the lane
 * the project was last in. Entering a lane also makes it the active one, so a later
 * bare `bridge` comes back to it. `agent` is null for a bare `bridge`.
 */
async function launchAgent(projectDir, agent, argv) {
  const parsed = extractResume(tailAfter(argv, agent));
  if (parsed.error) {
    log(`${BAD} ${parsed.error}`);
    return 1;
  }
  const { resume, rest } = parsed;
  const r = resolveResumeLane(projectDir, resume);
  if (r.error) {
    log(`${BAD} ${r.error}`);
    return 1;
  }
  let lane = r.lane;
  if (r.pick) {
    lane = await pickLane(projectDir);
    if (!lane) {
      log(`${NONE} No lane chosen.`);
      return 0;
    }
  }
  if (lane) {
    // Entering a lane makes it the default too, so "the lane you were last in" is
    // true next time. A launcher already running on another lane is pinned and
    // unaffected by this move.
    mutateProject(projectDir, (disk) => switchActiveLane(disk, lane));
  }
  return runLoop(projectDir, agent, { ...splitLauncherArgs(rest), lane });
}

/**
 * Pull the bridge-owned `--resume [lane]` out of an agent's forwarded args. The
 * bridge holds `--resume` back from the agent anyway (it manages the session), so
 * here it selects a lane. Returns { resume, rest }: `resume` is undefined when
 * absent, a lane name when one follows, or `true` for the bare picker form; `rest`
 * is the remaining args to forward to the agent.
 */
export function extractResume(tail) {
  const hits = [];
  const rest = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a === "--resume") {
      const next = tail[i + 1];
      const hasName = next !== undefined && !next.startsWith("-");
      hits.push(hasName ? next : true);
      if (hasName) i++; // consume the lane name too, so it never reaches the agent
    } else if (a.startsWith("--resume=")) {
      hits.push(a.slice("--resume=".length)); // may be "" for a bare --resume=
    } else {
      rest.push(a);
    }
  }
  if (hits.length === 0) return { resume: undefined, rest };
  // More than one --resume is ambiguous, and leaving a second one in `rest` would
  // hand it to an agent that does not drop it (Codex, OpenCode). Refuse instead of
  // guessing which lane was meant.
  if (hits.length > 1) return { error: "Use --resume at most once." };
  const only = hits[0];
  if (only === "") return { error: "Empty --resume=; give it a lane name, or use --resume with no value to pick one." };
  return { resume: only, rest };
}

/**
 * A picker answer to a whole number 0..count, or null for anything else. Parsing
 * with parseInt alone accepted "1abc" as 1, silently choosing a lane the user did
 * not type; the whole string must be digits.
 */
export function parseChoice(answer, count) {
  const t = String(answer).trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= count ? n : null;
}

/**
 * Resolve `--resume`'s value: a lane to open, null to fall back to the lane the
 * project was last in, or a picker request. A named lane must already exist — new
 * lanes are made deliberately with `lane new`, never conjured by a resume typo.
 * Returns { lane } | { pick: true } | { error }.
 */
export function resolveResumeLane(projectDir, resume) {
  if (resume === undefined) return { lane: null };
  const s = loadState(projectDir);
  if (resume === true) {
    // Nothing to choose between yet: open the one lane there is.
    if (!s || Object.keys(s.lanes ?? {}).length <= 1) return { lane: null };
    return { pick: true };
  }
  if (!isValidLaneName(resume)) return { error: `Invalid lane name '${resume}'.` };
  if (!s?.lanes?.[resume]) {
    return { error: `No lane named '${resume}'. Start it with 'bridge lane new ${resume}', or 'bridge lane' to list them.` };
  }
  return { lane: resume };
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Interactive lane picker for a bare `bridge <agent> --resume`. Lists the lanes
 * newest-active first with "New lane" on top, and returns the chosen lane's name, a
 * freshly created one, or null if the choice was empty or invalid (the caller treats
 * null as cancel).
 */
async function pickLane(projectDir) {
  const s = loadState(projectDir);
  const summaries = laneSummaries(projectDir, s);
  log(bold("Which lane?"));
  log(`  ${dim("0)")} New lane`);
  summaries.forEach((l, idx) => {
    const when = l.lastActive ? ago(new Date(l.lastActive)) : "no activity yet";
    log(`  ${dim(`${idx + 1})`)} ${l.name}${l.active ? dim(" (current)") : ""}  ${dim(when)}`);
  });
  const answer = (await prompt(`Lane [0-${summaries.length}, Enter = ${summaries[0].name}]: `)).trim();
  if (!answer) return summaries[0].name;
  const n = parseChoice(answer, summaries.length);
  if (n === null) return null;
  if (n === 0) {
    const name = (await prompt("New lane name: ")).trim();
    if (!isValidLaneName(name)) {
      log(`${BAD} Invalid lane name '${name}'.`);
      return null;
    }
    if (s.lanes?.[name]) return name; // already exists: just open it
    mutateProject(projectDir, (disk) => createLane(disk, name));
    log(`${OK} Created lane ${bold(name)}.`);
    return name;
  }
  return summaries[n - 1].name;
}
