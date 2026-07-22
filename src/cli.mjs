import { runLoop } from "./launcher.mjs";
import { runDoctor } from "./doctor.mjs";
import { runHook } from "./hooks.mjs";
import { handoff } from "./handoff.mjs";
import { loadState } from "./state.mjs";
import { pruneCheckpoints, DEFAULT_KEEP_GROUPS, DEFAULT_MAX_AGE_DAYS, DEFAULT_KEEP_COMPANIONS } from "./clean.mjs";
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
      const debug = flags.has("--debug");
      const mask = (id) => (id ? (debug ? id : id.slice(0, 8) + "…") : dim("not linked"));
      log(bold("context-bridge status"));
      log(`  project        ${s.project}`);
      log(`  active agent   ${s.activeAgent ?? dim("none")}`);
      for (const agentId of AGENT_IDS) {
        const slot = s.agents?.[agentId] ?? {};
        const synced = slot.mark ? (typeof slot.mark === "string" ? slot.mark : JSON.stringify(slot.mark)) : dim("never");
        log(`  ${agentId.padEnd(14)} ${mask(slot.id)}   synced ${synced}`);
      }
      log(`  pending        ${s.pendingHandoff ? `handoff → ${s.pendingHandoff.target}` : s.pendingInjection ? `injection → ${s.pendingInjection.agent}` : dim("none")}`);

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
        log(dim(`  bridge handoff ${target} --from ${agentId}`));
      }

      // Which agents each one has been caught up with. Free: it is already state.
      const linked = AGENT_IDS.filter((a) => s.agents?.[a]?.id);
      if (linked.length > 1) {
        log("");
        log("  caught up with");
        for (const target of linked) {
          const seen = linked.filter((src) => src !== target && s.knownBy?.[target]?.[src]);
          const missing = linked.filter((src) => src !== target && !s.knownBy?.[target]?.[src]);
          log(
            `  ${target.padEnd(14)} ${seen.length ? seen.join(", ") : dim("nobody")}` +
              `${missing.length ? dim(`   (never synced: ${missing.join(", ")})`) : ""}`
          );
        }
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
        decisions: valueOf(argv, "--decisions"),
        next: valueOf(argv, "--next"),
        adopt: flags.has("--adopt"),
        from,
      };
      const usage = `Usage: bridge handoff <${AGENT_IDS.join("|")}> [--from <agent>] [--decisions "…"] [--next "…"] [--adopt]`;
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
      // Companions are deleted on their own schedule, so counting only whole
      // groups reported "nothing to prune" while dozens of files were going.
      if (res.deletedGroups === 0 && res.deletedCompanions === 0) {
        log(`${NONE} Nothing to prune (${res.groups} checkpoint groups, all recent or protected).`);
      } else {
        if (res.deletedGroups) {
          log(`${OK} ${verb} ${res.deletedGroups} checkpoint groups (${res.deletedFiles} files). ${res.groups - res.deletedGroups} kept.`);
        }
        if (res.deletedCompanions) {
          log(`${OK} ${verb} ${res.deletedCompanions} un-truncated context files kept beyond the newest ${DEFAULT_KEEP_COMPANIONS}.`);
        }
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

function valueOf(argv, name) {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(name + "="));
  return pref ? pref.slice(name.length + 1) : "";
}
