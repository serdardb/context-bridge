// Agent argument forwarding.
//
// Everything typed after `bridge [agent]` belongs to that agent and is forwarded
// verbatim: no allow-list, no parsing of values, so every flag the agent supports
// today or adds tomorrow just works. Args are spawn-time only — they live in the
// launcher process, are re-applied every time that agent is spawned, are never
// carried to the other agent, and are never written to disk (a permission-bypass
// flag must not come back silently days later).
//
// Two exceptions, both loud:
//   1. `--cb-*` is reserved for the bridge itself and is never forwarded.
//   2. Flags that would break the bridge's own session link are dropped with a
//      warning, because `bridge` means "work in the linked session".
import { BridgeError } from "./util.mjs";

const CONFLICTS = {
  claude: [
    { flags: ["-c", "--continue"], value: "none", why: "the bridge resumes the linked session" },
    { flags: ["--resume"], value: "optional", why: "the bridge supplies the linked session itself" },
    { flags: ["--session-id"], value: "required", why: "the bridge supplies the linked session itself" },
    { flags: ["--fork-session"], value: "none", why: "forking mints a new session id and breaks the link" },
    {
      flags: ["--no-session-persistence"],
      value: "none",
      why: "without a saved transcript the bridge cannot build a delta",
    },
    { flags: ["-p", "--print"], value: "optional", why: "the launcher runs the interactive TUI" },
  ],
  codex: [
    { flags: ["--last"], value: "none", why: "codex rejects --last together with the delta prompt" },
    { flags: ["-C", "--cd"], value: "required", why: "bridge state belongs to this project directory" },
    { flags: ["--remote"], value: "required", why: "a remote session writes no local rollout to read" },
    { flags: ["--remote-auth-token-env"], value: "required", why: "only used with --remote" },
  ],
};

/**
 * Split the tail of a launcher command into bridge flags and agent args.
 * Rejects unknown `--cb-*` flags instead of silently dropping them.
 */
export function splitLauncherArgs(tail) {
  const agentArgs = [];
  for (const arg of tail) {
    if (arg.startsWith("--cb-") || arg === "--cb") {
      throw new BridgeError(
        `Unknown bridge flag '${arg}'. The --cb-* namespace is reserved for context-bridge; ` +
          "this version defines none. Agent flags are forwarded as-is, so drop the --cb- prefix."
      );
    }
    agentArgs.push(arg);
  }
  return agentArgs;
}

/**
 * Drop the args that would break the bridge's session link.
 * Returns {kept, dropped: [{arg, why}]} — callers must report `dropped`.
 */
export function filterAgentArgs(agent, args) {
  const rules = CONFLICTS[agent] ?? [];
  const kept = [];
  const dropped = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const rule = ruleFor(rules, arg);
    if (!rule) {
      kept.push(arg);
      continue;
    }
    dropped.push({ arg, why: rule.why });
    if (arg.includes("=")) continue; // --flag=value: the value rode along
    const next = args[i + 1];
    if (next === undefined) continue;
    if (rule.value === "required" || (rule.value === "optional" && !next.startsWith("-"))) {
      dropped.push({ arg: next, why: rule.why, isValue: true });
      i++;
    }
  }
  return { kept, dropped };
}

function ruleFor(rules, arg) {
  const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
  return rules.find((r) => r.flags.includes(name));
}
