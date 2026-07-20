// The bridge launcher loop. Process shape (proven in T4):
//   shell └── bridge └── exactly one active agent child
// Auto-exit safety (spec §11): SIGTERM is sent ONLY to the exact child PID we
// spawned, ONLY when a persisted handoff is ready AND the agent is idle.
// Never SIGKILL. Never process-name matching. If idle is uncertain: tell the
// user instead of terminating.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureState, loadState, saveState, agentSlot, commitKnown } from "./state.mjs";
import { adapterFor, AGENT_IDS } from "./agents/index.mjs";
import { filterAgentArgs } from "./agentargs.mjs";
import { log, dim, bold, OK, WARN, BAD, oneLine } from "./util.mjs";

const POLL_MS = 500;
const IDLE_DEBOUNCE_MS = 1000;
const TERM_GRACE_MS = 10000;

export async function runLoop(projectDir, startAgent = null, forwardArgs = []) {
  let s = ensureState(projectDir);
  let agent = startAgent || s.activeAgent || "claude";

  // Forwarded args belong to the agent named on the command line (or, when none
  // was named, to the one this loop starts with). They are never carried across
  // a switch: a Claude flag is meaningless or harmful to Codex.
  const agentArgs = Object.fromEntries(AGENT_IDS.map((id) => [id, []]));
  if (forwardArgs.length) {
    const { kept, dropped } = filterAgentArgs(agent, forwardArgs);
    agentArgs[agent] = kept;
    for (const d of dropped) {
      if (d.isValue) continue;
      log(`${WARN} Ignoring ${d.arg}: ${d.why}.`);
    }
  }

  // Ctrl+C typed inside the child goes to the whole foreground process group —
  // the child handles it; the launcher must survive (proven in T4).
  process.on("SIGINT", () => {});

  log(bold("context-bridge") + dim(" · Switch agents. Not context."));

  for (;;) {
    s = ensureState(projectDir);
    const { cmd, args, note } = buildCommand(projectDir, s, agent, agentArgs[agent]);
    if (agentArgs[agent]?.length) {
      log(dim(`→ Forwarding to ${agent}: ${agentArgs[agent].join(" ")}`));
    }
    if (!cmd) {
      log(`${BAD} ${note}`);
      return 1;
    }

    // This launch consumes any pending handoff towards `agent`.
    if (s.pendingHandoff?.target === agent) s.pendingHandoff = null;
    s.activeAgent = agent;
    agentSlot(s, agent).set({ idle: false });
    saveState(projectDir, s);

    if (note) log(dim(`→ ${note}`));
    const child = spawn(cmd, args, { stdio: "inherit", cwd: projectDir, env: childEnv() });

    const termHandler = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    process.once("SIGTERM", termHandler);

    const watcher = watchForHandoff(projectDir, agent, child);
    const exit = await waitForExit(child);
    watcher.stop();
    process.removeListener("SIGTERM", termHandler);

    if (exit.error) {
      if (exit.error.code === "ENOENT") {
        log(`${BAD} '${cmd}' is not installed or not on PATH. Run: bridge doctor`);
      } else {
        log(`${BAD} Failed to start '${cmd}': ${exit.error.message}`);
      }
      return 1;
    }

    s = loadState(projectDir);
    // The agent's closing message is written after the handoff command runs, so
    // it is never in the delta the handoff produced. Now that the process has
    // exited it IS on disk: fold it in before the other agent reads anything.
    if (s) appendFinalWords(projectDir, s, agent);
    const pending = s?.pendingHandoff;
    if (pending?.target && pending.target !== agent) {
      log("");
      log(`${OK} Switching: ${bold(agent)} → ${bold(pending.target)}`);
      agent = pending.target;
      continue;
    }

    if (exit.code !== 0 && exit.code !== 143 && exit.signal !== "SIGTERM") {
      log(`${WARN} ${agent} exited with status ${exit.code ?? exit.signal}. Bridge state is preserved — run 'bridge' to continue.`);
      return exit.code ?? 1;
    }
    log(`${OK} Bridge session ended. Run 'bridge' anytime to continue where you left off.`);
    return 0;
  }
}

export function buildCommand(projectDir, s, agent, extra = []) {
  const adapter = adapterFor(agent);
  if (!adapter) return { cmd: null, args: [], note: `Unknown agent '${agent}'.` };

  const slot = agentSlot(s, agent);
  const inj = s.pendingInjection;
  const seeding = !slot.id && inj?.agent === agent && inj.id == null;
  if (!slot.id && !seeding && adapter.injection === "prompt") {
    // Nothing to resume and no context waiting: starting blind would silently
    // drop the user into an empty session that the bridge does not track.
    return {
      cmd: null,
      args: [],
      note: `No linked ${adapter.displayName} session yet. Hand off to it from another agent first.`,
    };
  }
  if (!slot.id) {
    // A fresh session. Prompt-injecting agents get the delta as their opening
    // message; hook-injecting ones receive it through their own session hook.
    const { cmd, args } = adapter.startCommand(extra);
    const note = `Starting a new ${adapter.displayName} session for this project…`;
    if (!seeding || adapter.injection !== "prompt") return { cmd, args, note };
    const seeded = consumeDelta(projectDir, s, inj, agent);
    if (seeded) args.push(...adapter.promptArgs(seeded));
    return { cmd, args, note };
  }

  const ref = adapter.hydrate(projectDir, slot) ?? { id: slot.id, transcriptPath: slot.transcriptPath };
  const { cmd, args } = adapter.resumeCommand(ref, extra);
  const note = `Resuming your ${adapter.displayName} session…`;

  // Prompt-injecting agents receive a pending delta as the auto-submitted resume
  // prompt (proven in T2 for Codex). Hook-injecting agents get it from their own
  // session hook instead, so nothing is appended here.
  if (adapter.injection === "prompt" && inj?.agent === agent && (inj.id ?? slot.id) === slot.id) {
    const delta = consumeDelta(projectDir, s, inj, agent);
    if (delta) args.push(...adapter.promptArgs(delta));
  }
  return { cmd, args, note };
}

/**
 * Read a pending delta and mark it consumed, exactly once. Returns null when it
 * could not be read or claimed — and says so, because a silently dropped delta is
 * indistinguishable from having no context at all.
 */
function consumeDelta(projectDir, s, inj, agent) {
  const deltaPath = path.join(projectDir, inj.deltaFile);
  let delta;
  try {
    delta = fs.readFileSync(deltaPath, "utf8");
  } catch {
    log(`${WARN} Pending delta could not be read (${inj.deltaFile}); starting ${agent} without it.`);
    return null;
  }
  try {
    fs.renameSync(deltaPath, deltaPath + ".consumed");
  } catch {
    log(`${WARN} Pending delta could not be consumed (${inj.deltaFile}); starting ${agent} without it.`);
    return null;
  }
  // The delta reached its target: record what it carried, so the next handoff
  // to this agent starts from here instead of resending it.
  commitKnown(s, inj);
  s.pendingInjection = null;
  saveState(projectDir, s);
  return delta;
}

/**
 * Append whatever the departing agent said after it ran the handoff. Without
 * this its final answer, usually the substantive one, is silently dropped: the
 * handoff runs mid-turn, and the message is only persisted when the turn ends.
 */
export function appendFinalWords(projectDir, s, agent) {
  const inj = s.pendingInjection;
  if (!inj || inj.agent === agent) return;
  const adapter = adapterFor(agent);
  const slot = agentSlot(s, agent);
  if (!adapter || !slot.id) return;

  const ref = adapter.hydrate(projectDir, slot);
  if (!ref) return;
  let tail;
  try {
    tail = adapter.activitySince(ref, slot.mark);
  } catch {
    return;
  }
  if (!tail.messages.length) return;

  const deltaPath = path.join(projectDir, inj.deltaFile);
  const oneLiners = tail.messages.map((m) => `- ${m.role === "user" ? "User" : adapter.displayName}: ${oneLine(m.text, 220)}`);
  try {
    fs.appendFileSync(deltaPath, `\n\nClosing words from ${adapter.displayName}\n${oneLiners.join("\n")}\n`);
  } catch {
    return; // already consumed or unwritable: the switch still stands
  }
  // The companion promises exact wording, so it gets the closing words in full.
  // Skipping it would quietly make the file a worse record than the summary.
  const fullPath = deltaPath.replace(/\.md$/, "-full.md");
  const verbatim = tail.messages
    .map((m) => `### ${m.role === "user" ? "User" : adapter.displayName}${m.at ? ` — ${m.at}` : ""}\n\n${m.text}`)
    .join("\n\n");
  try {
    fs.appendFileSync(fullPath, `\n## Closing words from ${adapter.displayName}\n\n${verbatim}\n`);
  } catch {
    // The delta already carries them; the companion missing out is not fatal.
  }
  // The closing words are now part of the delta destined for the other agent,
  // so the packed mark has to move with them: committing the pre-handoff mark
  // would either resend them later or, worse, skip them entirely.
  const finalMark = adapter.currentMark(ref);
  slot.set({ mark: finalMark });
  if (inj.sources) inj.sources[agent] = finalMark;
  saveState(projectDir, s);
  log(dim(`→ Added ${tail.messages.length} closing message(s) from ${agent} to the handoff.`));
}

/**
 * Watch .bridge/state.json for a ready handoff away from the running agent,
 * then terminate the child — idle-safely.
 */
function watchForHandoff(projectDir, agent, child) {
  let stopped = false;
  let terminated = false;
  let idleSince = null;
  let warnedManual = false;

  const timer = setInterval(() => {
    if (stopped || terminated) return;
    let s;
    try {
      s = loadState(projectDir);
    } catch {
      return;
    }
    const pending = s?.pendingHandoff;
    if (!pending?.ready || pending.target === agent) {
      idleSince = null;
      return;
    }

    // Idle checks (spec §11). Each adapter answers from its own session files;
    // an adapter returning null reports idleness out of band instead (Claude does
    // this through its Stop hook, which writes the marker in state).
    const adapter = adapterFor(agent);
    const slot = agentSlot(s, agent);
    let idle = false;
    if (adapter) {
      const ref = slot.id ? adapter.hydrate(projectDir, slot) : null;
      const fromFiles = ref ? adapter.idleAfter(ref, pending.requestedAt) : null;
      idle = fromFiles === null ? slot.idle : fromFiles === true;
    }

    if (!idle) {
      // Uncertain/no idle signal: after a generous window, fall back to a
      // clear manual message rather than terminating (safety over magic).
      if (!warnedManual && Date.now() - Date.parse(pending.requestedAt) > 60000) {
        warnedManual = true;
        process.stderr.write(
          `\n${WARN} bridge: handoff to ${pending.target} is ready but ${agent} did not report idle.\n` +
            `   Exit ${agent} normally and the bridge will continue automatically.\n`
        );
      }
      return;
    }

    if (!idleSince) {
      idleSince = Date.now();
      return; // debounce: confirm idle persists across one more poll
    }
    if (Date.now() - idleSince < IDLE_DEBOUNCE_MS) return;

    // Final consistency re-check straight from disk before signaling.
    const fresh = loadState(projectDir);
    if (!fresh?.pendingHandoff?.ready || fresh.pendingHandoff.target === agent) return;

    terminated = true;
    process.stderr.write(`\n${OK} bridge: ${agent} is idle — switching to ${fresh.pendingHandoff.target}…\n`);
    try {
      child.kill("SIGTERM"); // exact child PID only; never SIGKILL (proven safe in T4)
    } catch {}
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        process.stderr.write(
          `${WARN} bridge: ${agent} did not exit after SIGTERM. Please exit it manually; state is safe.\n`
        );
      }
    }, TERM_GRACE_MS).unref();
  }, POLL_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function childEnv() {
  const env = { ...process.env };
  // Never look like a nested Claude session to the child TUIs.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Mark agent children so `bridge handoff` can tell whether the launcher is
  // actually watching (auto-switch) or the user started the agent bare (manual).
  env.CONTEXT_BRIDGE_LAUNCHER = "1";
  return env;
}
