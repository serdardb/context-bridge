import { runLoop } from "./launcher.mjs";
import { runDoctor } from "./doctor.mjs";
import { runHook } from "./hooks.mjs";
import { handoff } from "./handoff.mjs";
import { loadState } from "./state.mjs";
import { pruneCheckpoints, DEFAULT_KEEP_GROUPS, DEFAULT_MAX_AGE_DAYS, DEFAULT_KEEP_COMPANIONS } from "./clean.mjs";
import { splitLauncherArgs } from "./agentargs.mjs";
import { loadConfig, savedArgs, isDangerous } from "./config.mjs";
import { AGENT_IDS, adapterFor } from "./agents/index.mjs";
import { log, bold, dim, OK, NONE } from "./util.mjs";

const VERSION = "0.8.0";

const HELP = `${bold("context-bridge")} ${VERSION} — Switch agents. Not context.

Usage:
  bridge                 Start the bridged session loop (resumes where you left off)
${AGENT_IDS.map((a) => `  bridge ${(a + " [flags]").padEnd(16)}Start the loop with ${adapterFor(a).displayName} ( flags go to it as-is )`).join("\n")}
  bridge doctor [--fix]  Check agents, auth, plugins and routes ( --fix bootstraps,
                         --deep asks each agent a real one-line question )
  bridge status          Show project bridge status
  bridge clean           Prune old checkpoints (keeps newest ${DEFAULT_KEEP_GROUPS} handoffs and
                         everything younger than ${DEFAULT_MAX_AGE_DAYS} days; --dry-run, --keep N,
                         --days N, --all; a pending injection is never deleted)

Agent flags:
  bridge claude --dangerously-skip-permissions --model claude-fable-5
  Put the agent name first, then its flags. They are forwarded untouched and reused
  every time the bridge reopens it in this launcher run. Nothing is written to
  disk: the next 'bridge' starts from the agent's own defaults again.

Inside the agents:
  Claude Code:  /bridge <agent>   hand off to another agent
  Codex, Grok:  $bridge <agent>   hand off to another agent
`;

const LAUNCHER_COMMANDS = AGENT_IDS;
const COMMANDS = [...AGENT_IDS, "doctor", "status", "clean", "handoff", "internal-hook", "help", "version"];

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

    case "handoff": {
      const target = args[1];
      const opts = {
        decisions: valueOf(argv, "--decisions"),
        next: valueOf(argv, "--next"),
        adopt: flags.has("--adopt"),
      };
      if (AGENT_IDS.includes(target)) {
        log(handoff(projectDir, target, opts));
      } else {
        log(`Usage: bridge handoff <${AGENT_IDS.join("|")}> [--decisions "…"] [--next "…"] [--adopt]`);
        process.exitCode = 1;
      }
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

    case "internal-hook":
      process.exitCode = await runHook(args[1]);
      return;

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
