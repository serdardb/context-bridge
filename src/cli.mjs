import { runLoop } from "./launcher.mjs";
import { runDoctor } from "./doctor.mjs";
import { runHook } from "./hooks.mjs";
import { handoffCodex, handoffClaude } from "./handoff.mjs";
import { loadState } from "./state.mjs";
import { log, bold, dim, OK, NONE } from "./util.mjs";

const VERSION = "0.1.0";

const HELP = `${bold("context-bridge")} ${VERSION} — Switch agents. Not context.

Usage:
  bridge                 Start the bridged session loop (resumes where you left off)
  bridge claude          Start the loop with Claude
  bridge codex           Start the loop with Codex
  bridge doctor [--fix]  Check agents, auth, plugins and routes ( --fix bootstraps )
  bridge status          Show project bridge status

Inside the agents:
  Claude Code:  /bridge codex     hand off to Codex
  Codex:        $bridge claude    hand off back to Claude
`;

export async function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const cmd = args[0];
  const projectDir = process.cwd();

  if (flags.has("--version") || cmd === "version") {
    log(VERSION);
    return;
  }
  if (flags.has("--help") || cmd === "help") {
    log(HELP);
    return;
  }

  switch (cmd) {
    case undefined:
    case "claude":
    case "codex":
      process.exitCode = await runLoop(projectDir, cmd ?? null);
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
      log(`  claude session ${mask(s.agents.claude.sessionId)}   synced ${s.agents.claude.lastSyncAt ?? dim("never")}`);
      log(`  codex thread   ${mask(s.agents.codex.threadId)}   synced ${s.agents.codex.lastSyncAt ?? dim("never")}`);
      log(`  pending        ${s.pendingHandoff ? `handoff → ${s.pendingHandoff.target}` : s.pendingInjection ? `injection → ${s.pendingInjection.agent}` : dim("none")}`);
      return;
    }

    case "handoff": {
      const target = args[1];
      const opts = {
        decisions: valueOf(argv, "--decisions"),
        next: valueOf(argv, "--next"),
      };
      if (target === "codex") {
        log(handoffCodex(projectDir, opts));
      } else if (target === "claude") {
        log(handoffClaude(projectDir, opts));
      } else {
        log(`Usage: bridge handoff <codex|claude> [--decisions "…"] [--next "…"]`);
        process.exitCode = 1;
      }
      return;
    }

    case "internal-hook":
      process.exitCode = await runHook(args[1]);
      return;

    default:
      log(`Unknown command '${cmd}'.\n\n${HELP}`);
      process.exitCode = 1;
  }
}

function valueOf(argv, name) {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(name + "="));
  return pref ? pref.slice(name.length + 1) : "";
}
