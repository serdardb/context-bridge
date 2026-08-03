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
import { adapterFor } from "./agents/index.mjs";

// The conflicting flags are declared once, on each adapter, and read straight
// from there. A second copy of this table used to live here and it drifted:
// OpenCode's declared conflicts were only half-enforced, and Grok's and
// Antigravity's were not enforced at all, so flags that break the bridge's own
// session link passed straight through. One source now, and a test asserts the
// enforcement reads it.

/**
 * Split the tail of a launcher command into bridge flags and agent args.
 * Rejects unknown `--cb-*` flags instead of silently dropping them.
 */
export function splitLauncherArgs(tail) {
  const agentArgs = [];
  const bridgeFlags = { saveArgs: false, clearArgs: false };
  for (const arg of tail) {
    // The --cb-* namespace belongs to the bridge, never to the agent, which is
    // what makes it the right home for a flag about the flags.
    if (arg === "--cb-save-args") {
      bridgeFlags.saveArgs = true;
      continue;
    }
    if (arg === "--cb-clear-args") {
      bridgeFlags.clearArgs = true;
      continue;
    }
    if (arg.startsWith("--cb-") || arg === "--cb") {
      throw new BridgeError(
        `Unknown bridge flag '${arg}'. The --cb-* namespace is reserved for context-bridge; ` +
          "this version defines --cb-save-args and --cb-clear-args. " +
          "Agent flags are forwarded as-is, so drop the --cb- prefix."
      );
    }
    agentArgs.push(arg);
  }
  return { agentArgs, bridgeFlags };
}

/**
 * Drop the args that would break the bridge's session link.
 * Returns {kept, dropped: [{arg, why}]} — callers must report `dropped`.
 */
export function filterAgentArgs(agent, args) {
  const rules = adapterFor(agent)?.conflictFlags ?? [];
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
