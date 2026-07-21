// `bridge handoff <target>` — runs inside the agent you are leaving.
// It persists state and a pending marker; the launcher does the actual switching.
//
// One function serves every direction. The source agent is whoever is running,
// the target is whoever was asked for, and each side's behaviour comes from its
// adapter rather than from its name.
import path from "node:path";
import { ensureState, saveState, writeCheckpoint, agentSlot, knownMark, STATE_VERSION } from "./state.mjs";
import { adapterFor, AGENT_IDS } from "./agents/index.mjs";
import { transferClaudeSession } from "./transfer.mjs";
import { gitDelta, currentGitSha, composeDelta, composeFullContext } from "./delta.mjs";
import { pruneCheckpoints, supersedePending, dropDeliveredCompanions } from "./clean.mjs";
import { hookDeliveryEligible } from "./delivery.mjs";
import { nowIso, tryExec, OK, WARN, BridgeError, fileExists, processAlive, log } from "./util.mjs";

/** True when this handoff runs inside an agent spawned by the bridge launcher. */
function underLauncher() {
  return process.env.CONTEXT_BRIDGE_LAUNCHER === "1";
}

/** Auto-prune after a handoff writes its checkpoints. Never fails the handoff, never silent. */
function autoPrune(projectDir, lines) {
  try {
    const res = pruneCheckpoints(projectDir);
    if (res.deletedGroups > 0) {
      lines.push(`${OK} Pruned ${res.deletedGroups} old checkpoint groups (older than 7 days, beyond the newest 20).`);
    }
  } catch {}
}

function splitNotes(s) {
  return String(s || "")
    .split(/;|\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Which agent is running this command. The env markers are exact when present;
 * otherwise the launcher's own record of the active agent is authoritative.
 */
function detectSource(s, target) {
  const fromEnv = process.env.CODEX_THREAD_ID ? "codex" : process.env.CLAUDECODE ? "claude" : null;
  const candidate = fromEnv ?? s.activeAgent ?? null;
  if (candidate && candidate !== target) return candidate;

  const others = AGENT_IDS.filter((agentId) => agentId !== target);
  // Only one other agent is linked: it must be the one handing off.
  const linked = others.filter((agentId) => agentSlot(s, agentId).id);
  if (linked.length === 1) return linked[0];
  if (linked.length > 1) {
    throw new BridgeError(
      `Cannot tell which agent is handing off to ${target}: ${linked.join(" and ")} are both linked. ` +
        "Run this from inside an agent started by the bridge."
    );
  }
  // Nothing linked yet: only one agent has a session in this project, so a
  // first handoff from a bare session still works (adoption rules still apply).
  const discovered = others.filter((agentId) => adapterFor(agentId).discover(projectDirOf(s)));
  if (discovered.length === 1) return discovered[0];
  throw new BridgeError(
    `Cannot tell which agent is handing off to ${target}: no linked or discoverable ` +
      `${others.join(" or ")} session in this project. ` +
      "Run this from inside an agent started in this directory."
  );
}

/**
 * A session we hold an id for, whose file is not there, is a broken link rather
 * than an empty one. Naming it here means the reason travels with the handoff
 * instead of surfacing later as somebody else's error.
 */
function warnIfSourceUnreadable(projectDir, sourceId, sourceSlot) {
  if (!sourceSlot?.id) return; // nothing linked yet is a different, handled case
  const adapter = adapterFor(sourceId);
  let ref = null;
  try {
    ref = adapter?.hydrate?.(projectDir, sourceSlot) ?? null;
  } catch {}
  const transcriptPath = ref?.transcriptPath ?? sourceSlot.transcriptPath ?? null;
  if (transcriptPath && fileExists(transcriptPath)) return;
  log(
    `${WARN} The linked ${adapter?.displayName ?? sourceId} session has no transcript on disk yet` +
      `${transcriptPath ? ` (${path.basename(transcriptPath)})` : ""}; ` +
      "this handoff can only carry your notes and the git delta."
  );
}

function projectDirOf(s) {
  return s.project;
}

function kb(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A handoff only records state; the launcher is what starts the target later.
 * So a missing target binary is a warning, not a failure — the work is still
 * saved, and the launcher reports the missing command clearly when it tries.
 */
function preflight(agentId, lines = []) {
  const adapter = adapterFor(agentId);
  // Ask the adapter what it runs. An agent's id and its binary are not the same
  // thing: Antigravity is launched as `agy`, and assuming otherwise reported a
  // perfectly installed agent as missing.
  const cmd = adapter?.startCommand?.()?.cmd ?? agentId;
  if (!tryExec(cmd, ["--version"])) {
    lines.push(
      `${WARN} ${adapter?.displayName ?? agentId} is not installed or not on PATH (${cmd}), ` +
        "so the switch will fail until it is. Run: bridge doctor"
    );
  }
}

/**
 * The official import is different: it runs right now, inside this command, and
 * it cannot work without a usable Codex. Failing early beats failing halfway.
 */
function preflightOfficialImport() {
  if (!tryExec("codex", ["--version"])) {
    throw new BridgeError("Codex CLI is not installed. Install with: npm install -g @openai/codex, then try again");
  }
  if (tryExec("codex", ["login", "status"]) === null) {
    throw new BridgeError(
      "Codex is installed but not authenticated. Run: codex login  (your ChatGPT subscription can be used), then try again"
    );
  }
}

/**
 * A launcher records the state version it understands before it spawns an agent.
 * A mismatch means the process watching for this handoff cannot read the file we
 * are about to write, so the switch will not fire. Say which way round it is:
 * "older launcher" is wrong when the launcher is in fact the newer one.
 */
function launcherIsStale(s, lines) {
  if (!underLauncher()) return false;
  const seen = s.launcher?.stateVersion ?? null;
  const pid = s.launcher?.pid ?? null;
  // A marker describes a process. If that process is gone, the marker describes
  // nobody, and a matching version proves nothing: something has to be watching
  // for the switch to happen at all.
  const markerAlive = pid ? processAlive(pid) : null;
  if (seen === STATE_VERSION && markerAlive !== false) return false;

  const which =
    seen === null
      ? "a launcher that predates this check"
      : seen === STATE_VERSION
        ? "a launcher that has since exited"
        : seen < STATE_VERSION
          ? `an older bridge launcher (understands state v${seen}, this bridge writes v${STATE_VERSION})`
          : `a newer bridge launcher (understands state v${seen}, this bridge writes v${STATE_VERSION})`;
  const gone = markerAlive === false && seen !== STATE_VERSION ? ", and that launcher process is no longer running" : "";
  lines.push(
    `${WARN} This agent is running under ${which}${gone}. ` +
      "The handoff is saved either way, but automatic switching may not fire."
  );
  return true;
}


/**
 * Make sure the source agent is linked, adopting its running session when needed.
 * Deterministic identity adopts silently; a heuristic match needs --adopt.
 */
function ensureSourceLinked(projectDir, s, sourceId, adopt, lines) {
  const slot = agentSlot(s, sourceId);
  if (slot.id) return false;

  const adapter = adapterFor(sourceId);
  const found = adapter.discover(projectDir);
  if (!found) {
    throw new BridgeError(
      `No ${adapter.displayName} session found for this project, and none is linked. ` +
        `Start ${adapter.displayName} in this directory, or hand off from an agent that is linked.`
    );
  }
  if (found.deterministic !== true && !adopt) {
    throw new BridgeError(
      `No ${adapter.displayName} session is linked for this project, but an unlinked one working in this directory was found. ` +
        "Confirm with the user that it is the right session, then rerun the same command with --adopt.",
      { exitCode: 2, code: "adopt-confirmation-needed" }
    );
  }
  slot.set({ id: found.id, transcriptPath: found.transcriptPath ?? null, mark: null });
  lines.push(
    found.deterministic === true
      ? `${OK} Adopted this ${adapter.displayName} session (started outside the bridge) as the project's linked one.`
      : `${OK} Adopted the most recent ${adapter.displayName} session of this project (user-confirmed).`
  );
  if (!found.transcriptPath) {
    // Never silent: without the transcript the delta loses the conversation and
    // carries only git and decision truth.
    lines.push(
      `${WARN} Its transcript file was not found, so the delta will carry git and decision truth only, ` +
        "not the conversation."
    );
  }
  return true; // adopted: the whole session is new to the other side
}

/** Hand the current session off to `target`. Returns a short user-facing report. */
export function handoff(
  projectDir,
  target,
  // `transfer` and `checkTarget` are injectable so the official-import path can be
  // exercised without shelling out to the OpenAI plugin or a real login.
  {
    decisions = "",
    next: nextNotes = "",
    adopt = false,
    from = null,
    transfer = transferClaudeSession,
    checkTarget = preflight,
  } = {}
) {
  const targetAdapter = adapterFor(target);
  if (!targetAdapter) throw new BridgeError(`Unknown agent '${target}'. Known: ${AGENT_IDS.join(", ")}.`);

  const s = ensureState(projectDir);
  const lines = [];
  const sourceId = from ?? detectSource(s, target);
  if (sourceId === target) throw new BridgeError(`Already in ${targetAdapter.displayName}; nothing to hand off.`);
  const sourceAdapter = adapterFor(sourceId);

  checkTarget(target, lines);
  const staleLauncher = launcherIsStale(s, lines);
  const adopted = ensureSourceLinked(projectDir, s, sourceId, adopt, lines);
  const sourceSlot = agentSlot(s, sourceId);
  const targetSlot = agentSlot(s, target);
  const now = nowIso();

  // Say plainly when the source we are about to read is not on disk. It is a
  // warning rather than a refusal because one legitimate case exists already: a
  // Codex thread adopted from the environment whose rollout has not been written
  // yet still carries its decisions across. The paths that genuinely need the
  // file fail on their own, and now with one clear line instead of a stack.
  warnIfSourceUnreadable(projectDir, sourceId, sourceSlot);

  // FIRST switch, Claude to Codex only: the official OpenAI transfer seeds a full
  // thread. No other pair has an equivalent, so those first switches carry the
  // bounded delta plus its full-context companion instead.
  if (!targetSlot.id && sourceId === "claude" && target === "codex") {
    if (transfer === transferClaudeSession) preflightOfficialImport();
    const res = transfer(sourceSlot.transcriptPath);
    const targetRef = targetAdapter.hydrate(projectDir, { id: res.threadId });
    targetSlot.set({ id: res.threadId, transcriptPath: targetRef?.transcriptPath ?? null });
    // The import copies the whole Claude conversation into the new thread, and a
    // v3 mark means "my own stream is shared up to here". Leaving the target
    // unmarked would make the first return replay the entire imported history
    // back at Claude.
    targetSlot.set({ mark: targetRef ? targetAdapter.currentMark(targetRef) : now });
    const sourceMark = sourceAdapter.currentMark(sourceAdapter.hydrate(projectDir, sourceSlot));
    sourceSlot.set({ mark: sourceMark });
    // The import carried Claude's conversation into the thread, so Codex has
    // seen it; without this seed the first return would hand it all back.
    s.knownBy ??= {};
    (s.knownBy[target] ??= {})[sourceId] = sourceMark;
    s.git = { sha: currentGitSha(projectDir), recordedAt: now };
    sourceSlot.set({ idle: false });
    s.pendingHandoff = { target, ready: true, requestedAt: now };
    saveState(projectDir, s);
    lines.push(`${OK} First switch: Claude session imported into Codex via the official OpenAI transfer.`);
    lines.push(...switchNote(targetAdapter, targetSlot, sourceAdapter, staleLauncher));
    return lines.join("\n");
  }

  // Gather from EVERY agent the target has not caught up with, not only from the
  // one handing off. Without this a chain loses history at each hop: what Claude
  // told Grok never reaches Codex, because Grok's own stream is all that travels.
  const packed = {};
  const streams = [];
  const work = [];
  let messageCount = 0;
  for (const otherId of AGENT_IDS) {
    if (otherId === target) continue;
    const slot = agentSlot(s, otherId);
    if (!slot.id) continue;
    const adapter = adapterFor(otherId);
    const ref = adapter.hydrate(projectDir, slot);
    if (!ref) continue;
    // An adopted source is new to everyone, so it starts from the beginning.
    const since = otherId === sourceId && adopted ? null : knownMark(s, target, otherId);
    let activity;
    try {
      activity = adapter.activitySince(ref, since);
    } catch {
      continue;
    }
    packed[otherId] = adapter.currentMark(ref);
    if (!activity.messages.length && !activity.patchedFiles.length) continue;
    streams.push({ id: otherId, label: adapter.displayName, messages: activity.messages });
    messageCount += activity.messages.length;
    work.push(...activity.patchedFiles.map((f) => `Modified via ${adapter.displayName}: ${f}`));
  }
  const sourceRef = sourceAdapter.hydrate(projectDir, sourceSlot);
  const git = gitDelta(projectDir, s.git.sha);
  const sections = {
    sources: streams.length ? streams : [{ id: sourceId, label: sourceAdapter.displayName, messages: [] }],
    decisions: splitNotes(decisions),
    work: [...work, ...git.lines],
    next: splitNotes(nextNotes),
  };

  // Re-issuing a handoff to the same target replaces the undelivered one instead
  // of leaving it behind: those orphans were pure waste, and two pending packages
  // for one agent is a state nobody can reason about.
  if (s.pendingInjection?.agent === target) {
    const dropped = supersedePending(projectDir, s.pendingInjection);
    if (dropped.files) {
      lines.push(`${OK} Replaced the previous undelivered handoff to ${targetAdapter.displayName} (${kb(dropped.bytes)} freed).`);
    }
    s.pendingInjection = null;
  }

  const stem = `${ts(now)}-${sourceId}-to-${target}`;
  const full = composeFullContext(sections);
  const fullRel = writeCheckpoint(projectDir, `${stem}-full.md`, full);

  // The 8KB delta exists because the other side already knows the earlier
  // conversation. On a FIRST switch it knows nothing, so clipping would hand it
  // a worse start than the official Claude→Codex import gives — which is exactly
  // the second-class treatment Grok objected to. Send everything instead: the
  // limit was never the channel, only the assumption of shared history.
  const firstSwitch = !targetSlot.id;
  let delta;
  if (firstSwitch) {
    delta =
      full +
      `\nThis is the first switch to ${targetAdapter.displayName} in this project, so the whole conversation is above, ` +
      "un-clipped. Later handoffs carry only what is new.";
  } else {
    delta = composeDelta(sections);
    delta +=
      `\n\nTemporary full context companion: ${fullRel}` +
      " — messages above are clipped to one line each. Read it during this receiving session if exact wording matters; " +
      "it may be pruned after this agent hands off.";
  }
  if (adopted) {
    delta += sourceRef?.transcriptPath
      ? `\n\nFull transcript of the adopted ${sourceAdapter.displayName} session: ${sourceRef.transcriptPath}` +
        "\nRead it if you need more detail than this bounded delta."
      : `\n\n[Bridge warning] The adopted ${sourceAdapter.displayName} session's history could not be read, ` +
        "so this delta carries git and decision truth only. Ask the user to fill in anything that seems missing.";
  }
  if (targetAdapter.injection === "prompt") {
    delta += "\n\nAcknowledge this context in one short sentence and continue from here. Do not repeat it back.";
  }
  const deltaRel = writeCheckpoint(projectDir, `${stem}.md`, delta);

  s.pendingInjection = {
    agent: target,
    // The road this delta takes, decided here and honoured by exactly one
    // deliverer. Inferring it later from the agent's injection mode looked
    // tempting and is fragile: seeding a first session, resuming one, and
    // resuming one whose hooks are live are three different cases that would
    // have to be told apart from the same field.
    via: hookDeliveryEligible(target, targetSlot) ? "hook" : "prompt",
    // null = nothing to resume on that side: the delta seeds the first session
    // the target opens in this project.
    id: targetSlot.id ?? null,
    deltaFile: deltaRel,
    createdAt: now,
    // What this delta carries, per source. Committed to knownBy only once the
    // delta is final, which is after the launcher has added any closing words:
    // committing here would mark the departing agent's last answer as delivered
    // before it was even written.
    sources: packed,
  };
  sourceSlot.set({ mark: sourceRef ? sourceAdapter.currentMark(sourceRef) : now, idle: false });
  s.git = { sha: currentGitSha(projectDir), recordedAt: now };
  s.pendingHandoff = { target, ready: true, requestedAt: now };
  saveState(projectDir, s);

  const others = streams.filter((st) => st.id !== sourceId).map((st) => st.label);
  lines.push(
    `${OK} Prepared ${sourceAdapter.displayName}→${targetAdapter.displayName} context delta ` +
      `(${messageCount} messages, ${sections.work.length} work items, ${kb(Buffer.byteLength(delta))}` +
      `${others.length ? `, including catch-up from ${others.join(" and ")}` : ""}).`
  );

  // This agent is handing off, which proves it had a live session after anything
  // delivered to it arrived and is done reading those companions. From here the
  // native transcripts and knownBy are the record.
  const freed = dropDeliveredCompanions(projectDir, sourceId);
  if (freed.files) {
    lines.push(
      `${OK} Cleared ${freed.files} delivered context file${freed.files === 1 ? "" : "s"} ` +
        `for ${sourceAdapter.displayName} (${kb(freed.bytes)} freed).`
    );
  }
  autoPrune(projectDir, lines);
  lines.push(...switchNote(targetAdapter, targetSlot, sourceAdapter, staleLauncher));
  if (!decisions && !nextNotes) {
    lines.push(`${WARN} No --decisions/--next notes were provided; the delta contains conversation + git truth only.`);
  }
  return lines.join("\n");
}

/** The one honest sentence about what happens next, launcher or not. */
function switchNote(targetAdapter, targetSlot, sourceAdapter, staleLauncher = false) {
  const what = targetSlot.id
    ? `resume your ${targetAdapter.displayName} session`
    : `start a fresh ${targetAdapter.displayName} session seeded with this context`;
  if (underLauncher() && !staleLauncher) {
    return [`${OK} Handoff is ready. The bridge launcher will close ${sourceAdapter.displayName} and ${what} automatically.`];
  }
  if (underLauncher() && staleLauncher) {
    return [
      `${OK} Handoff is ready.`,
      `${WARN} If the switch stalls, exit ${sourceAdapter.displayName} and run 'bridge ${targetAdapter.id}' to ${what}. ` +
        `Nothing is lost: this ${sourceAdapter.displayName} session stays linked and resumes next time.`,
    ];
  }
  return [
    `${OK} Handoff is ready.`,
    `${WARN} This session is not running under the bridge launcher, so nothing switches automatically: ` +
      `exit ${sourceAdapter.displayName} and run 'bridge ${targetAdapter.id}' to ${what}. ` +
      `Nothing is lost: this ${sourceAdapter.displayName} session stays linked and resumes next time.`,
  ];
}

/** Kept for the existing skills and CLI wiring. */
export function handoffCodex(projectDir, opts = {}) {
  return handoff(projectDir, "codex", { ...opts, from: opts.from ?? "claude" });
}

export function handoffClaude(projectDir, opts = {}) {
  return handoff(projectDir, "claude", opts);
}

function ts(iso) {
  return iso.replace(/[:.]/g, "-");
}
