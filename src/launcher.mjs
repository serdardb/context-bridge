// The bridge launcher loop. Process shape (proven in T4):
//   shell └── bridge └── exactly one active agent child
// Auto-exit safety (spec §11): SIGTERM is sent ONLY to the exact child PID we
// spawned, ONLY when a persisted handoff is ready AND the agent is idle.
// Never SIGKILL. Never process-name matching. If idle is uncertain: tell the
// user instead of terminating.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureState, loadState, saveState, agentSlot, commitKnown, STATE_VERSION } from "./state.mjs";
import { adapterFor, AGENT_IDS } from "./agents/index.mjs";
import { filterAgentArgs } from "./agentargs.mjs";
import { resolveArgs, saveArgs, clearArgs, savedArgs, loadConfig, isDangerous } from "./config.mjs";
import { deltaWasConsumed, promptBody, companionFor } from "./delivery.mjs";
import { log, dim, bold, OK, WARN, BAD, oneLine, nowIso, processAlive } from "./util.mjs";

const POLL_MS = 500;
const IDLE_DEBOUNCE_MS = 1000;
const TERM_GRACE_MS = 10000;

export async function runLoop(projectDir, startAgent = null, forward = []) {
  // Accepts either a bare array (older callers) or the split the CLI produces.
  const forwardArgs = Array.isArray(forward) ? forward : (forward?.agentArgs ?? []);
  const bridgeFlags = Array.isArray(forward) ? {} : (forward?.bridgeFlags ?? {});
  let s = ensureState(projectDir);
  let agent = startAgent || s.activeAgent || "claude";

  if (bridgeFlags.clearArgs) {
    const gone = clearArgs(projectDir, agent);
    log(gone.length ? `${OK} Forgot the saved flags for ${agent}: ${gone.join(" ")}` : `${OK} ${agent} had no saved flags.`);
  }
  let justSaved = false;
  if (bridgeFlags.saveArgs) {
    const saved = saveArgs(projectDir, agent, forwardArgs);
    justSaved = true; // they are in the config now, so do not also count them as typed
    log(`${OK} Saved for ${agent}, and used on every launch from now on: ${saved.join(" ")}`);
    log(dim(`  Undo with: bridge ${agent} --cb-clear-args`));
  }

  // Flags belong to the agent named on the command line (or, when none was
  // named, to the one this loop starts with). They are never carried across a
  // switch: a Claude flag is meaningless or harmful to Codex. Saved defaults for
  // this project come first, and what was typed now comes last, so the moment
  // always has the final word over the default.
  const agentArgs = Object.fromEntries(AGENT_IDS.map((id) => [id, []]));
  for (const id of AGENT_IDS) {
    const typed = id === agent && !justSaved ? forwardArgs : [];
    const { all } = resolveArgs(projectDir, id, typed);
    if (!all.length) continue;
    const { kept, dropped } = filterAgentArgs(id, all);
    agentArgs[id] = kept;
    for (const d of dropped) {
      if (d.isValue) continue;
      log(`${WARN} Ignoring ${d.arg}: ${d.why}.`);
    }
  }

  // Ctrl+C typed inside the child goes to the whole foreground process group —
  // the child handles it; the launcher must survive (proven in T4).
  process.on("SIGINT", () => {});

  log(bold("context-bridge") + dim(" · Switch agents. Not context."));
  warnAboutOtherLauncher(s);

  for (;;) {
    s = ensureState(projectDir);
    const { cmd, args, note, carries } = buildCommand(projectDir, s, agent, agentArgs[agent]);
    if (agentArgs[agent]?.length) {
      const armed = agentArgs[agent].filter(isDangerous);
      // Dim for ordinary flags, plain for the ones that change what the agent may
      // do without asking. A permission bypass nobody notices is the failure this
      // whole project keeps finding in other places.
      if (armed.length) {
        log(`${WARN} ${adapterFor(agent)?.displayName ?? agent} is being launched with ${armed.join(" ")}`);
      }
      log(dim(`→ Forwarding to ${agent}: ${agentArgs[agent].join(" ")}`));
    }
    if (!cmd) {
      log(`${BAD} ${note}`);
      return 1;
    }

    // This launch consumes any pending handoff towards `agent`.
    if (s.pendingHandoff?.target === agent) s.pendingHandoff = null;
    s.activeAgent = agent;
    s.launcher = { stateVersion: STATE_VERSION, pid: process.pid, recordedAt: nowIso() };
    agentSlot(s, agent).set({ idle: false });
    saveState(projectDir, s);

    if (note) log(dim(`→ ${note}`));
    // A session we are about to create belongs to this project, and until it is
    // written into state it cannot be resumed: `bridge <agent>` would refuse and
    // the next handoff would mint yet another session. Claude records itself via
    // its SessionStart hook; every other agent needs the launcher to do it.
    const startedAt = nowIso();
    const needsLink = !agentSlot(s, agent).id;
    const child = spawn(cmd, args, { stdio: "inherit", cwd: projectDir, env: childEnv() });
    // The delta is only delivered once something is actually carrying it. A spawn
    // that fails must leave the pending delta exactly where it was.
    child.once("spawn", () => carries && commitDelivery(projectDir, carries));
    const linker = needsLink ? watchForNewSession(projectDir, agent, startedAt, child.pid) : null;

    const termHandler = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    process.once("SIGTERM", termHandler);

    const pendingBefore = s.pendingInjection?.agent === agent ? s.pendingInjection : null;
    const watcher = watchForHandoff(projectDir, agent, child);
    const exit = await waitForExit(child);
    watcher.stop();
    linker?.stop();
    // Linking runs while the child is alive so status, doctor and the next
    // handoff tell the truth DURING the session, and once more after it exits
    // because a killed terminal, a sleeping machine or a SIGKILL would
    // otherwise leave the session stranded exactly as before.
    if (needsLink) linkStartedSession(projectDir, agent, startedAt, child.pid);
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
    // Hook delivery is a judgement, not a certainty: hooks do not run until the
    // user trusts them and that trust can be withdrawn without telling anyone.
    // So the guess is checked rather than believed. Nothing is resent
    // automatically, because the next handoff supersedes this delta anyway; what
    // matters is that a delta which never arrived is never passed over quietly.
    if (pendingBefore?.via === "hook" && pendingBefore.agent === agent && !deltaWasConsumed(projectDir, pendingBefore)) {
      log(`${WARN} The context for ${agent} was not delivered: its hooks did not run.`);
      log(dim(`  It is still at ${pendingBefore.deltaFile}, and the next handoff will carry it again.`));
      log(dim(`  Codex runs hooks only after you review them once with /hooks.`));
    }
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

/**
 * Write the session this launcher started into state, if and only if exactly one
 * candidate matches. Several candidates means the user legitimately has another
 * session of the same agent open, and stealing one into this project's state
 * would be worse than leaving it unlinked: the existing `--adopt` confirmation
 * path still handles that case, with a human answering.
 */
function linkStartedSession(projectDir, agent, startedAt, childPid) {
  const adapter = adapterFor(agent);
  if (!adapter?.adoptStartedSession) return false;
  const s = loadState(projectDir);
  if (!s || agentSlot(s, agent).id) return false; // already linked, nothing to do

  let candidates = [];
  try {
    candidates = adapter.adoptStartedSession(projectDir, { startedAt, childPid }) ?? [];
  } catch {
    return false;
  }
  if (candidates.length !== 1) {
    if (candidates.length > 1) {
      log(
        `${WARN} Found ${candidates.length} new ${adapter.displayName} sessions for this project; ` +
          "not linking any of them. Hand off from inside the one you want."
      );
    }
    return false;
  }
  const ref = candidates[0];
  // The mark stays null on purpose: this session has said nothing the bridge has
  // packed yet, so its first handoff must carry the conversation from its start.
  agentSlot(s, agent).set({ id: ref.id, transcriptPath: ref.transcriptPath ?? null });
  saveState(projectDir, s);
  log(dim(`→ Linked this ${adapter.displayName} session to the project.`));
  return true;
}

/** Poll for the started session while the child runs, then stop at the first link. */
function watchForNewSession(projectDir, agent, startedAt, childPid) {
  const timer = setInterval(() => {
    if (linkStartedSession(projectDir, agent, startedAt, childPid)) stop();
  }, POLL_MS * 4);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  return { stop };
}

/**
 * Another launcher already running for this project is usually a forgotten tab,
 * and forgotten tabs accumulate: three were found alive on the author's machine,
 * two of them orphaned. It is only ever a warning. `state.launcher.pid` records
 * the last writer, not an owner, so a stale entry must not scare anyone either.
 */
function warnAboutOtherLauncher(s) {
  const pid = s?.launcher?.pid;
  if (!pid || pid === process.pid || !processAlive(pid)) return;
  log(`${WARN} Another bridge launcher (pid ${pid}) is already running for this project.`);
  log(dim("  Both will keep working, but they do not share one session. Close the one you are done with."));
}

/**
 * Has the agent finished the turn it was in when the handoff was requested?
 *
 * A turn ending is something an agent can simply tell us through its Stop hook,
 * and something we otherwise have to infer by re-reading its transcript looking
 * for a vendor-specific completion record.
 *
 * The marker is read first because it is both cheaper and truer: it costs
 * nothing, it arrives when the turn ends rather than whenever the file is next
 * flushed, and it does not depend on a field name a vendor may rename. It cannot
 * be stale either, since the launcher clears it before every launch, so a marker
 * found here belongs to this run.
 *
 * Parsing stays as the fallback, and that is not tidiness. Hooks do not run
 * until they are trusted, and a launcher that listened only for a hook would
 * wait for a switch that can never come.
 */
export function turnHasEnded(projectDir, s, agent, pending) {
  const slot = agentSlot(s, agent);
  if (slot.idle === true) return true;

  const adapter = adapterFor(agent);
  if (!adapter) return false;
  const ref = slot.id ? adapter.hydrate(projectDir, slot) : null;
  return ref ? adapter.idleAfter(ref, pending.requestedAt) === true : false;
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
    if (inj?.via === "hook") return { cmd, args, note };
    const seeded = readDelta(projectDir, inj);
    if (seeded) args.push(...adapter.promptArgs(seeded));
    return { cmd, args, note, carries: seeded ? inj : null };
  }

  const ref = adapter.hydrate(projectDir, slot) ?? { id: slot.id, transcriptPath: slot.transcriptPath };
  const { cmd, args } = adapter.resumeCommand(ref, extra);
  const note = `Resuming your ${adapter.displayName} session…`;

  // Prompt-injecting agents receive a pending delta as the auto-submitted resume
  // prompt (proven in T2 for Codex). Hook-injecting agents get it from their own
  // session hook instead, so nothing is appended here.
  // `via` is the whole guard against delivering twice: a hook putting the delta
  // into the conversation while the prompt also carried it would repeat it word
  // for word.
  if (inj?.via !== "hook" && adapter.injection === "prompt" && inj?.agent === agent && (inj.id ?? slot.id) === slot.id) {
    const delta = readDelta(projectDir, inj);
    if (delta) {
      args.push(...adapter.promptArgs(delta));
      return { cmd, args, note, carries: inj };
    }
  }
  return { cmd, args, note };
}

/**
 * Read a pending delta, and change nothing.
 *
 * Building a command used to consume in the same breath: the file was renamed and
 * knownBy was committed before the agent had even been spawned. That made two
 * failures possible and one of them silent. Inspecting what a launch would look
 * like destroyed the delta being inspected, which is how one was lost while
 * diagnosing an unrelated bug; worse, a spawn that then failed left context
 * marked as delivered when nothing had received it. Reading and committing are
 * now separate, and committing happens only after the child is actually running.
 *
 * The body is bounded here because the limit belongs to the road, not to the
 * delta: a command line is finite in a way a file is not.
 */
function readDelta(projectDir, inj) {
  if (!inj?.deltaFile) return null;
  let delta;
  try {
    delta = fs.readFileSync(path.join(projectDir, inj.deltaFile), "utf8");
  } catch {
    log(`${WARN} Pending delta could not be read (${inj.deltaFile}); the agent starts without it.`);
    return null;
  }
  return promptBody(delta, companionFor(projectDir, inj.deltaFile));
}

/**
 * Mark a delta as delivered, exactly once, after the agent carrying it is up.
 * The rename is what makes "once" true across a crash: whoever renames the file
 * owns the delivery. knownBy moves at the same moment, never before, so a launch
 * that failed can never leave context recorded as though it had arrived.
 */
function commitDelivery(projectDir, inj) {
  if (!inj?.deltaFile) return;
  const deltaPath = path.join(projectDir, inj.deltaFile);
  try {
    fs.renameSync(deltaPath, deltaPath + ".consumed");
  } catch {
    // Already renamed, or gone. Either way it is not ours to commit.
    return;
  }
  const s = loadState(projectDir);
  if (!s) return;
  commitKnown(s, inj);
  if (s.pendingInjection?.deltaFile === inj.deltaFile) s.pendingInjection = null;
  saveState(projectDir, s);
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
  // The companion holds exact wording for the receiving session, so it gets the
  // closing words in full while it still exists.
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
  let warnedUnreadable = false;

  const timer = setInterval(() => {
    if (stopped || terminated) return;
    let s;
    try {
      s = loadState(projectDir);
    } catch (e) {
      // Almost always: this launcher started before a state upgrade and can no
      // longer read the file. Silence here looks exactly like "no handoff is
      // pending", so the user sits waiting for a switch that can never come.
      if (!warnedUnreadable) {
        warnedUnreadable = true;
        process.stderr.write(
          `\n${WARN} bridge: cannot read .bridge/state.json — ${e.message}\n` +
            `   This launcher is running older code than the state file. Exit ${agent} and run 'bridge' again;\n` +
            "   the pending handoff is saved and will be applied by the new launcher.\n"
        );
      }
      return;
    }
    const pending = s?.pendingHandoff;
    if (!pending?.ready || pending.target === agent) {
      idleSince = null;
      return;
    }

    const idle = turnHasEnded(projectDir, s, agent, pending);

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
