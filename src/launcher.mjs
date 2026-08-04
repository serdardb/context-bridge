// The bridge launcher loop. Process shape (proven in T4):
//   shell └── bridge └── exactly one active agent child
// Auto-exit safety (spec §11): SIGTERM is sent ONLY to the exact child PID we
// spawned, ONLY when a persisted handoff is ready AND the agent is idle.
// Never SIGKILL. Never process-name matching. If idle is uncertain: tell the
// user instead of terminating.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { ensureState, loadState, mutateState, agentSlot, commitKnown, safeCheckpointPath, recordLauncher, liveLaunchers, STATE_VERSION, CHECKPOINT_KINDS, CONSUMED_SUFFIX, DEFAULT_LANE } from "./state.mjs";
import { adapterFor, AGENT_IDS } from "./agents/index.mjs";
import { filterAgentArgs } from "./agentargs.mjs";
import { resolveArgs, saveArgs, clearArgs, savedArgs, loadConfig, isDangerous } from "./config.mjs";
import {
  deltaWasConsumed,
  promptBody,
  fullContextFor,
  deliverableBudget,
  closingWordsNotice,
  hookDeliveryEligible,
  HOOK_DELTA_BYTES,
  PROMPT_DELTA_BYTES,
} from "./delivery.mjs";
import { bindSeed, unbindSeed } from "./seed.mjs";
import { log, dim, bold, OK, WARN, BAD, nowIso, processAlive } from "./util.mjs";
import { messageBlock } from "./delta.mjs";

const POLL_MS = 500;
const IDLE_DEBOUNCE_MS = 1000;
const TERM_GRACE_MS = 10000;

// The lane this launcher process is driving, pinned once at startup. A launcher
// follows the lane it opened for its whole life, never the on-disk `activeLane`,
// which another launcher's `lane switch` can move under it. Every read is
// re-pointed to this lane and every write is scoped to it, so two launchers on
// two lanes in two terminals never read or write each other's work. With a single
// lane this is `main` throughout and changes nothing; it is the seam the lane
// commands need, put in before they exist so the concurrency guard is proven
// first, not bolted on after.
let launcherLane = DEFAULT_LANE;

/** loadState, then re-point its view at the lane this launcher is driving. */
function loadPinned(projectDir) {
  const s = loadState(projectDir);
  if (s) s.activeLane = launcherLane;
  return s;
}

export async function runLoop(projectDir, startAgent = null, forward = []) {
  // Accepts either a bare array (older callers) or the split the CLI produces.
  const forwardArgs = Array.isArray(forward) ? forward : (forward?.agentArgs ?? []);
  const bridgeFlags = Array.isArray(forward) ? {} : (forward?.bridgeFlags ?? {});
  // `--resume <lane>` resolves to a lane this launcher pins for its whole life,
  // overriding the on-disk default. It has already been validated to exist and made
  // the active lane by the CLI, so here it is only the pin.
  const wantLane = Array.isArray(forward) ? null : (forward?.lane ?? null);
  let s = ensureState(projectDir);
  launcherLane = wantLane ?? s.activeLane ?? DEFAULT_LANE;
  s.activeLane = launcherLane;
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
    s.activeLane = launcherLane; // this launcher drives its own lane, not the on-disk default
    // A `lane new --seed` leaves an unbound seed injection for whichever agent opens
    // the lane first. Bind it to this agent under the lock (bindSeed re-checks inside
    // it, so two launchers racing one seeded lane give the seed to exactly one). If
    // this launcher LOST the race, stop cleanly rather than start a second session on
    // the lane: a hook agent would otherwise begin an untracked, seedless one. The
    // session that won runs with the seed; reopen this terminal once it is up.
    let boundSeedThisLaunch = false;
    if (s.pendingInjection?.seed && s.pendingInjection.agent == null && !agentSlot(s, agent).id) {
      const won = bindSeed(projectDir, launcherLane, agent, hookDeliveryEligible(agent, agentSlot(s, agent)));
      if (!won) {
        log(`${WARN} Another session is opening the seeded lane '${launcherLane}' and took the seed.`);
        log(dim("  Nothing was started here. Reopen once that session is running."));
        return 0;
      }
      boundSeedThisLaunch = true;
      s = loadPinned(projectDir);
    }
    const { cmd, args, note, carries, preResume } = buildCommand(projectDir, s, agent, agentArgs[agent]);
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

    // This launch consumes any pending handoff towards `agent`. Read-modify-write
    // under the lock so a hook writing the same lane in parallel is not clobbered.
    s = mutateState(projectDir, launcherLane, (st) => {
      if (st.pendingHandoff?.target === agent) st.pendingHandoff = null;
      st.activeAgent = agent;
      recordLauncher(st, process.pid, launcherLane);
      agentSlot(st, agent).set({ idle: false });
    });
    s.activeLane = launcherLane;

    if (note) log(dim(`→ ${note}`));
    // Pre-resume: agents like OpenCode cannot take a delta on the command line
    // and cannot receive one through a hook, so the launcher injects it into
    // their own store before the interactive session opens.
    //
    // For these agents the injection IS the delivery. `watchForDelivery` commits
    // when the target produces new activity after start, and a pre-inserted
    // message never produces any, so a successful injection would otherwise sit
    // pending forever and be re-injected on the next launch. So this commits on
    // success, right here, and leaves the delta pending on failure — never
    // renamed, so the next launch delivers it again, and the write is idempotent
    // so a retry cannot duplicate it. `watchForDelivery` is skipped entirely for
    // preResume agents below.
    if (preResume) {
      let injected = false;
      try {
        log(dim(`→ ${preResume.note}`));
        execFileSync(preResume.cmd, preResume.args, {
          stdio: "ignore",
          cwd: projectDir,
          env: childEnv(launcherLane),
          timeout: 15000,
        });
        injected = true;
      } catch {
        log(`${WARN} Could not inject context into ${agent}; it stays pending and the next launch will deliver it.`);
      }
      if (injected && carries) commitDelivery(projectDir, carries);
    }
    // A session we are about to create belongs to this project, and until it is
    // written into state it cannot be resumed: `bridge <agent>` would refuse and
    // the next handoff would mint yet another session. Claude records itself via
    // its SessionStart hook; every other agent needs the launcher to do it.
    const startedAt = nowIso();
    const needsLink = !agentSlot(s, agent).id;
    const child = spawn(cmd, args, { stdio: "inherit", cwd: projectDir, env: childEnv(launcherLane) });
    // **A spawn is not a delivery.** This committed here, on the reasoning that a
    // process which started is a process carrying the delta — and a started process
    // only proves the CLI launched, not that the prompt reached the model. When it
    // does not, the delta has already been renamed `.consumed` and the pending item
    // cleared, so the handoff is gone with nothing to retry and no way to tell.
    // That is not hypothetical: a Claude→Codex handoff was lost exactly this way,
    // and the only evidence afterwards was a checkpoint that never appeared.
    //
    // Delivery is now committed when the target actually says something. If it
    // never does, the pending item survives and `bridge` can hand it over again.
    // The cost of being wrong in this direction is a handoff delivered twice,
    // which is visible and recoverable; the cost in the other direction is one
    // delivered never, which is neither.
    // preResume agents committed above, at injection time; watching them for
    // after-start activity would never fire and would leave the delta pending.
    const delivery = carries && !preResume ? watchForDelivery(projectDir, agent, carries, startedAt) : null;
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
    // One last look before giving up on it. A short session — an agent that answered
    // and exited quickly — can finish between polls, and an uncommitted delta there
    // would be re-delivered on the next launch for no reason. If it still shows no
    // activity the delta stays pending on purpose: retryable beats lost.
    delivery?.settle();
    delivery?.stop();
    // Linking runs while the child is alive so status, doctor and the next
    // handoff tell the truth DURING the session, and once more after it exits
    // because a killed terminal, a sleeping machine or a SIGKILL would
    // otherwise leave the session stranded exactly as before.
    if (needsLink) linkStartedSession(projectDir, agent, startedAt, child.pid);
    process.removeListener("SIGTERM", termHandler);

    if (exit.error) {
      // A seed belongs to whoever actually OPENS the lane. This agent never started,
      // so hand the seed back: revert it to unbound, so the next agent can become the
      // first opener instead of it staying locked to a launch that never ran.
      if (boundSeedThisLaunch) unbindSeed(projectDir, launcherLane, agent);
      if (exit.error.code === "ENOENT") {
        log(`${BAD} '${cmd}' is not installed or not on PATH. Run: bridge doctor`);
      } else {
        log(`${BAD} Failed to start '${cmd}': ${exit.error.message}`);
      }
      return 1;
    }

    s = loadPinned(projectDir);
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
      // The switch is normally driven by the departing agent running the handoff
      // itself. An agent that died — a quota 429, a crash — never got to, so its
      // work would sit stranded in its own session with nothing pointing at it.
      // The whole loop used to wait blind for a handoff that could never arrive.
      // Say plainly that the work survived and exactly how to carry it forward.
      warnStrandedWork(projectDir, agent);
      return exit.code ?? 1;
    }
    log(`${OK} Bridge session ended. Run 'bridge' anytime to continue where you left off.`);
    return 0;
  }
}

/**
 * After an agent dies without handing off, tell the user its work is not lost.
 *
 * The recovery already works, it was just never reachable: the delta is built
 * from the agent's own transcript, not from the live process, so a dead agent's
 * work is still on disk. This names the one command that carries it forward and
 * the agents it can go to, so nobody has to know the incantation to avoid losing
 * a session. Silent about a clean exit with nothing pending, because then there
 * is nothing stranded to recover.
 */
export function warnStrandedWork(projectDir, agent) {
  let hasWork = false;
  try {
    const s = loadPinned(projectDir);
    const slot = agentSlot(s, agent);
    if (!slot.id) return;
    const adapter = adapterFor(agent);
    const ref = adapter.hydrate(projectDir, slot);
    if (!ref) return;
    // Messages OR files. An agent that spent its last turn editing and said
    // nothing has left work worth recovering just the same, and counting only
    // what it SAID would stay silent on exactly that session. Found in review.
    const activity = adapter.activitySince(ref, slot.mark);
    hasWork = (activity.messages?.length ?? 0) > 0 || (activity.patchedFiles?.length ?? 0) > 0;
    if (!hasWork) return;
    const targets = AGENT_IDS.filter((id) => id !== agent && agentSlot(s, id).id);
    const pick = targets[0] ?? "<target>";
    log(`${OK} ${adapter.displayName}'s work is saved, not lost. Carry it forward from any terminal:`);
    log(dim(`  bridge handoff ${pick} --from ${agent}`));
  } catch {
    // Best-effort help. Never let a recovery hint fail the exit path.
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
  const s = loadPinned(projectDir);
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
  mutateState(projectDir, launcherLane, (st) => {
    agentSlot(st, agent).set({ id: ref.id, transcriptPath: ref.transcriptPath ?? null });
  });
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
 * Commit a delta only once the receiving agent has actually said something.
 *
 * The distinction this exists for: `spawn` fires when the CLI process starts, and
 * a prompt handed to a CLI that ignores it produces exactly the same spawn as one
 * that reads it. Committing there marks a handoff delivered on the strength of an
 * event that cannot tell those apart.
 *
 * `activitySince` is vendor-specific by design (each adapter knows how to read its
 * own transcript), so this asks the adapter rather than guessing. An adapter that
 * cannot answer returns nothing, and then nothing is committed — which leaves the
 * delta pending and retryable, the safe direction.
 */
function watchForDelivery(projectDir, agent, carries, startedAt) {
  const adapter = adapterFor(agent);
  if (!adapter || typeof adapter.activitySince !== "function") {
    // No way to observe. Committing blind would restore the bug this replaces, so
    // the delta simply stays pending until something can confirm it landed. Both
    // handles are present so the caller's `delivery?.settle()` never throws on an
    // adapter that cannot watch.
    return { stop: () => {}, settle: () => {} };
  }

  function check() {
    const s = loadPinned(projectDir);
    if (!s) return;
    const slot = agentSlot(s, agent);
    if (!slot.id) return;
    const ref = adapter.hydrate(projectDir, slot) ?? { id: slot.id, transcriptPath: slot.transcriptPath };
    let seen = 0;
    try {
      seen = adapter.activitySince(ref, startedAt)?.messages?.length ?? 0;
    } catch {
      // A transcript we cannot read is not evidence of delivery.
      return;
    }
    if (seen > 0) {
      commitDelivery(projectDir, carries);
      stop();
    }
  }

  const timer = setInterval(check, POLL_MS * 4);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  return { stop, settle: check };
}

/**
 * Another launcher already running for this project is usually a forgotten tab,
 * and forgotten tabs accumulate: three were found alive on the author's machine,
 * two of them orphaned. It is only ever a warning. Launchers are tracked per pid
 * now, and dead ones are pruned on every launch, so a stale entry cannot scare
 * anyone; when the other launcher's lane is known, name it, since with lanes the
 * two are often meant to be separate rather than a forgotten duplicate.
 */
function warnAboutOtherLauncher(s) {
  const other = liveLaunchers(s).find((l) => l.pid !== process.pid);
  if (!other) return;
  const where = other.lane ? ` on lane ${other.lane}` : "";
  log(`${WARN} Another bridge launcher (pid ${other.pid})${where} is already running for this project.`);
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
    if (!seeding || adapter.injection !== "prompt") {
      if (seeding) appendKickoff(adapter, args, inj?.via);
      return { cmd, args, note };
    }
    if (inj?.via === "hook") return { cmd, args, note };
    const seeded = readDelta(projectDir, inj);
    // Carry the delta only if `promptArgs` actually put it on the command line.
    // An agent like OpenCode returns nothing here because a fresh session has no
    // store to inject into yet, so the delta must stay pending rather than be
    // marked delivered by a blank session; once the session exists and is linked,
    // the resume branch below injects it through preResume.
    const carried = seeded ? adapter.promptArgs(seeded) : [];
    args.push(...carried);
    return { cmd, args, note, carries: carried.length ? inj : null };
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
      // Agents with preResume inject into their own store (e.g. OpenCode: write
      // the delta into its session db, then open the interactive TUI). For them
      // the injection is the only delivery path, so if it cannot be built here —
      // no store, missing tool — the delta stays pending rather than being marked
      // delivered by a session that never received it. The launcher runs the
      // returned command and commits on its success.
      if (typeof adapter.preResume === "function") {
        const pre = adapter.preResume(ref, delta);
        return pre ? { cmd, args, note, carries: inj, preResume: pre } : { cmd, args, note };
      }
      const carried = adapter.promptArgs(delta);
      args.push(...carried);
      return { cmd, args, note, carries: carried.length ? inj : null };
    }
  }

  // Hook-injecting agents get the turn their hook cannot open. `carries` stays
  // unset on purpose: the hook still owns delivery, and claiming it here would
  // mark the delta delivered by something that never carried it.
  if ((adapter.injection === "hook" || inj?.via === "hook") && inj?.agent === agent && (inj.id ?? slot.id) === slot.id) {
    appendKickoff(adapter, args, inj.via);
  }
  return { cmd, args, note };
}

/**
 * Open a turn for an agent whose context arrives out of band.
 *
 * Guarded on the adapter implementing it, so an agent that has no way to accept an
 * opening prompt is simply left as it was rather than handed an argument its CLI
 * would treat as a file, a subcommand, or an error.
 */
function appendKickoff(adapter, args, via = null) {
  if (adapter.injection !== "hook" && via !== "hook") return;
  if (typeof adapter.kickoffArgs !== "function") return;
  args.push(...adapter.kickoffArgs());
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
  const deltaPath = safeCheckpointPath(projectDir, inj.deltaFile);
  if (!deltaPath) {
    log(`${WARN} Pending delta path is not inside .bridge (${inj.deltaFile}); the agent starts without it.`);
    return null;
  }
  let delta;
  try {
    delta = fs.readFileSync(deltaPath, "utf8");
  } catch {
    log(`${WARN} Pending delta could not be read (${inj.deltaFile}); the agent starts without it.`);
    return null;
  }
  return promptBody(delta, fullContextFor(projectDir, inj.deltaFile));
}

/**
 * Mark a delta as delivered, exactly once, after the agent carrying it is up.
 * The rename is what makes "once" true across a crash: whoever renames the file
 * owns the delivery. knownBy moves at the same moment, never before, so a launch
 * that failed can never leave context recorded as though it had arrived.
 */
function commitDelivery(projectDir, inj) {
  if (!inj?.deltaFile) return;
  const deltaPath = safeCheckpointPath(projectDir, inj.deltaFile);
  if (!deltaPath) return; // a deltaFile that escapes .bridge is never renamed
  try {
    fs.renameSync(deltaPath, deltaPath + CONSUMED_SUFFIX);
  } catch {
    // Already renamed, or gone. Either way it is not ours to commit.
    return;
  }
  if (!loadPinned(projectDir)) return;
  mutateState(projectDir, launcherLane, (st) => {
    commitKnown(st, inj);
    if (st.pendingInjection?.deltaFile === inj.deltaFile) st.pendingInjection = null;
  });
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

  const deltaPath = safeCheckpointPath(projectDir, inj.deltaFile);
  if (!deltaPath) return; // a deltaFile that escapes .bridge is never appended to
  // These used to be cut to their first 220 characters, by a second copy of a
  // rule written by hand in a file nobody was looking at. The departing agent's
  // last answer is the substantive one often enough that appending it at all was
  // a deliberate fix, and clipping it undid most of that fix in silence.
  const verbatim = tail.messages.map((m) => messageBlock(m, adapter.displayName)).join("\n\n");
  const fullPath = deltaPath.replace(new RegExp(`${CHECKPOINT_KINDS.delta.replace(".", "\\.")}$`), CHECKPOINT_KINDS.fullContext);

  // The full context checkpoint takes them first and always, because it has no
  // budget over it and because the delta may not be able to hold them.
  try {
    fs.appendFileSync(fullPath, `\n## Closing words from ${adapter.displayName}\n\n${verbatim}\n`);
  } catch {
    // A missing checkpoint is not fatal; what follows still tells the truth.
  }

  // Whether the delta can hold them is a real question and was never asked.
  //
  // The delta is composed to fill its road's budget, and this appends to it
  // afterwards with the process that decided that budget already finished. So a
  // full delta plus closing words exceeds the limit, and `fit` cuts the tail at
  // delivery — which is exactly these words, the last answer this whole function
  // exists to save. Measured before the fix: 130728 bytes composed against a
  // 131072 ceiling became 133690, and the closing words were what went.
  //
  // The room is known here, so it is checked here. When they fit they travel in
  // the delta as before. When they do not, the delta says where they are instead
  // of carrying a copy that will be cut off mid-sentence somewhere else.
  // Delivery appends its own pointer to this file on the way out, so the room
  // here is the road minus that line, not the road.
  const road = deliverableBudget(
    inj.via === "hook" ? HOOK_DELTA_BYTES : PROMPT_DELTA_BYTES,
    fullContextFor(projectDir, inj.deltaFile)
  );
  const block = `\n\nClosing words from ${adapter.displayName}\n\n${verbatim}\n`;
  // Guaranteed to fit: the handoff reserved exactly this string before it
  // composed anything, using the same function.
  const pointer = closingWordsNotice(adapter.displayName);
  let used = 0;
  try {
    used = fs.statSync(deltaPath).size;
  } catch {
    return; // already consumed or gone: the switch still stands
  }
  try {
    fs.appendFileSync(deltaPath, used + Buffer.byteLength(block) <= road ? block : pointer);
  } catch {
    return; // already consumed or unwritable: the switch still stands
  }
  // The closing words are now part of the delta destined for the other agent,
  // so the packed mark has to move with them: committing the pre-handoff mark
  // would either resend them later or, worse, skip them entirely.
  const finalMark = adapter.currentMark(ref);
  mutateState(projectDir, launcherLane, (st) => {
    agentSlot(st, agent).set({ mark: finalMark });
    const stInj = st.pendingInjection;
    if (stInj?.sources) stInj.sources[agent] = finalMark;
  });
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
      s = loadPinned(projectDir);
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
    const fresh = loadPinned(projectDir);
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

export function childEnv(lane = null) {
  const env = { ...process.env };
  // The lane this launcher is driving, so the agent's own hooks write the session
  // they belong to rather than whatever lane happens to be active project-wide.
  // The hook reads this first and falls back to matching the session id only when
  // it is absent, which is exactly the first-session case where no id exists yet.
  if (lane) env.CONTEXT_BRIDGE_LANE = lane;
  // Never look like a nested Claude session to the child TUIs.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Codex exports its thread id into the session, so without this it inherits
  // into whatever we spawn and makes a Grok or Antigravity session look like a
  // Codex one. Hygiene, not the guarantee: source detection prefers this
  // launcher's own record precisely so that a missed variable cannot mislead it.
  delete env.CODEX_THREAD_ID;
  // OpenCode: no known host-detection env var exported to children, but clean
  // any future ones for the same hygiene reason as Codex above.
  delete env.OPENCODE_SESSION_ID;
  // Mark agent children so `bridge handoff` can tell whether the launcher is
  // actually watching (auto-switch) or the user started the agent bare (manual).
  env.CONTEXT_BRIDGE_LAUNCHER = "1";
  return env;
}
