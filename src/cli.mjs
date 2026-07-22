import { runLoop } from "./launcher.mjs";
import { runDoctor } from "./doctor.mjs";
import { runHook } from "./hooks.mjs";
import { handoff } from "./handoff.mjs";
import { loadState } from "./state.mjs";
import { pruneCheckpoints, DEFAULT_KEEP_GROUPS, DEFAULT_MAX_AGE_DAYS } from "./clean.mjs";
import { splitLauncherArgs } from "./agentargs.mjs";
import { loadConfig, savedArgs, isDangerous } from "./config.mjs";
import { AGENT_IDS, adapterFor } from "./agents/index.mjs";
import { log, bold, dim, OK, BAD, NONE } from "./util.mjs";
import fs from "node:fs";
import path from "node:path";
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

Agent flags:
  bridge claude --dangerously-skip-permissions --model claude-fable-5
  Put the agent name first, then its flags. They are forwarded untouched and reused
  every time the bridge reopens it in this launcher run. Nothing is written to
  disk: the next 'bridge' starts from the agent's own defaults again.

  --cb-save-args         Keep the flags typed with this launch in .bridge/config.json
                         and use them every time this agent opens in this project
  --cb-clear-args        Forget them again

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
const COMMANDS = [...AGENT_IDS, "doctor", "status", "clean", "inspect", "handoff", "internal-hook", "help", "version"];

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
    process.exitCode = await runLoop(projectDir, cmd, splitLauncherArgs(tailAfter(argv, cmd)));
    return;
  }

  switch (cmd) {
    case undefined:
      // Anything after the agent name is the agent's own flag, forwarded as-is.
      process.exitCode = await runLoop(projectDir, null, splitLauncherArgs(tailAfter(argv, cmd)));
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
      const history = switchHistory(projectDir);
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
      const found = latestManifest(projectDir);
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
function switchHistory(projectDir) {
  let names;
  try {
    names = fs.readdirSync(path.join(projectDir, ".bridge", "checkpoints"));
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
