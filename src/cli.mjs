import { runLoop } from "./launcher.mjs";
import { runDoctor } from "./doctor.mjs";
import { runHook } from "./hooks.mjs";
import { handoffCodex, handoffClaude } from "./handoff.mjs";
import { loadState } from "./state.mjs";
import { pruneCheckpoints, DEFAULT_KEEP_GROUPS, DEFAULT_MAX_AGE_DAYS } from "./clean.mjs";
import { splitLauncherArgs } from "./agentargs.mjs";
import { AGENT_IDS } from "./agents/index.mjs";
import { log, bold, dim, OK, NONE } from "./util.mjs";

const VERSION = "0.6.0";

const HELP = `${bold("context-bridge")} ${VERSION} — Switch agents. Not context.

Usage:
  bridge                 Start the bridged session loop (resumes where you left off)
  bridge claude [flags]  Start the loop with Claude ( flags go to Claude as-is )
  bridge codex  [flags]  Start the loop with Codex  ( flags go to Codex as-is )
  bridge doctor [--fix]  Check agents, auth, plugins and routes ( --fix bootstraps )
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
  Claude Code:  /bridge codex     hand off to Codex
  Codex:        $bridge claude    hand off back to Claude
`;

const COMMANDS = ["claude", "codex", "doctor", "status", "clean", "handoff", "internal-hook", "help", "version"];
const LAUNCHER_COMMANDS = ["claude", "codex"];

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

  switch (cmd) {
    case undefined:
    case "claude":
    case "codex":
      // Anything after the agent name is the agent's own flag, forwarded as-is.
      process.exitCode = await runLoop(projectDir, cmd ?? null, splitLauncherArgs(tailAfter(argv, cmd)));
      return;

    case "doctor":
      process.exitCode = await runDoctor(projectDir, {
        fix: flags.has("--fix"),
        json: flags.has("--json"),
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
      return;
    }

    case "handoff": {
      const target = args[1];
      const opts = {
        decisions: valueOf(argv, "--decisions"),
        next: valueOf(argv, "--next"),
        adopt: flags.has("--adopt"),
      };
      if (target === "codex") {
        log(handoffCodex(projectDir, opts));
      } else if (target === "claude") {
        log(handoffClaude(projectDir, opts));
      } else {
        log(`Usage: bridge handoff <codex|claude> [--decisions "…"] [--next "…"] [--adopt]`);
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
      if (res.deletedGroups === 0) {
        log(`${NONE} Nothing to prune (${res.groups} checkpoint groups, all recent or protected).`);
      } else {
        log(`${OK} ${verb} ${res.deletedGroups} checkpoint groups (${res.deletedFiles} files). ${res.groups - res.deletedGroups} kept.`);
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
