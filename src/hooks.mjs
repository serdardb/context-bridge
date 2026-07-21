// `bridge internal-hook <event>` — invoked by the Claude Code plugin hooks.
// Reads the hook input JSON from stdin. Silently no-ops for projects that
// have no .bridge/ state (the plugin may be installed user-wide).
import fs from "node:fs";
import path from "node:path";
import { loadState, saveState, commitKnown, agentSlot } from "./state.mjs";
import { fileExists, nowIso } from "./util.mjs";
import { adapterFor } from "./agents/index.mjs";

/**
 * Is this hook running inside an agent that is not Claude?
 *
 * The question is not academic. Grok loads Claude's own `~/.claude/settings.json`
 * hooks by default, for compatibility, so a bridge hook can fire inside a Grok
 * session and write Claude's slot from another agent's conversation. The
 * corruption would be silent: an id that looks perfectly valid, pointing at the
 * wrong session.
 *
 * Only Grok is detected, and only by `GROK_HOOK_EVENT`, which its documentation
 * says the hook runner injects into every hook process. That is a marker of a
 * hook, not of a session, which is exactly the distinction that matters here.
 *
 * Codex is deliberately NOT guarded against, and the first attempt at this got it
 * wrong. `CODEX_THREAD_ID` looked like a Codex marker but it is ambient session
 * environment: it inherits into every child process, so any hook running without
 * `CLAUDECODE` beside it was refused, including Claude's own. Review caught it and
 * a test reproduces it. Guarding Codex needs a real hook-runner marker, which we
 * do not have yet and will not invent; the exposure is small in the meantime,
 * because Codex only runs a hook someone configured in its own files and we never
 * write ours there.
 *
 * Requiring positive proof of Claude instead was considered and refused. Making
 * every state write depend on `CLAUDECODE` means the day Claude stops exporting
 * it, the bridge stops recording sessions and says nothing. A guard should fail
 * towards working.
 */
function observedHost(env = process.env) {
  // Only hook-runner markers count, and only ones that exist. Two attempts got
  // this wrong in opposite directions: refusing on CODEX_THREAD_ID, which is
  // ambient session environment inherited by every child, made Claude's own hook
  // refuse itself; then a CODEX_HOOK_EVENT was added that simply does not exist,
  // checked against the shipped binary after review asked for proof. Codex
  // therefore has no marker here, which is the honest state rather than a
  // convenient one.
  return env.GROK_HOOK_EVENT ? "grok" : null;
}

/**
 * Is this hook running inside the agent it was installed for?
 *
 * Each hook command names its own agent (`internal-hook session-start --agent
 * codex`), so the question is a comparison rather than a guess. It has to be
 * asked because Grok loads Claude's own `~/.claude/settings.json` hooks by
 * default: a bridge hook can fire in the wrong agent and write the wrong
 * conversation into a project's state, and the result would look healthy.
 *
 * Only a positively identified foreign host refuses. An unknown environment is
 * allowed through, because a guard that demands proof of identity stops the
 * bridge working the day a vendor renames a variable, and it should fail
 * towards working.
 */
function foreignHost(declaredAgent = "claude", env = process.env) {
  const observed = observedHost(env);
  if (!observed || observed === declaredAgent) return null;
  return observed;
}

export async function runHook(event, agent = "claude") {
  const host = foreignHost(agent);
  if (host) {
    // stderr, never stdout: stdout is the hook's protocol channel with the agent.
    const name = (id) => adapterFor(id)?.displayName ?? id;
    process.stderr.write(
      `context-bridge: ignoring the '${event}' hook installed for ${name(agent)}, because it is running inside ` +
        `${name(host)}. It would write the wrong conversation into this project's state.\n`
    );
    return 0;
  }
  const input = await readStdinJson();
  const projectDir = input?.cwd || process.cwd();
  let s;
  try {
    s = loadState(projectDir);
  } catch {
    return 0; // unreadable/foreign state — never break the user's session
  }
  if (!s) return 0;

  // Codex hooks record their own agent. Delta delivery still travels by prompt
  // for it: the hook can inject context (proven), but hooks do not run until the
  // user trusts them once and that trust cannot be read back, so binding
  // delivery to something unverifiable would risk losing context silently.
  // Recording that the hook ran is exactly what makes the switch provable later.
  if (agent === "codex") return codexHook(projectDir, s, event, input);

  if (event === "session-start") return hookSessionStart(projectDir, s, input);
  if (event === "stop") return hookStop(projectDir, s, input);
  if (event === "user-prompt-submit") return hookUserPromptSubmit(projectDir, s, input);
  return 0;
}

/**
 * Link Claude's session to the project, but only once there is something to link
 * TO. Claude names the transcript at SessionStart and writes it at the first
 * message, so a session opened and closed without a word leaves state pointing at
 * a file that never existed — seen live in a fresh-install test, where the
 * project ended up linked to nothing and the next handoff died on it.
 *
 * The id itself is not thrown away: SessionStart is the one moment we learn it
 * for certain, so it is held as a candidate and promoted the moment the file
 * appears. Every Claude hook calls this, because any of them may be the first to
 * run after the transcript lands.
 */
function linkClaudeSession(s, input) {
  const id = input?.session_id;
  const transcriptPath = input?.transcript_path || null;
  if (!id) return false;

  if (s.agents.claude.id === id) {
    // Already linked: keep the path fresh, Claude may have moved the file.
    if (transcriptPath && s.agents.claude.transcriptPath !== transcriptPath) {
      s.agents.claude.transcriptPath = transcriptPath;
      return true;
    }
    return false;
  }
  if (s.agents.claude.id) return false; // a different session is linked; leave it alone

  if (!transcriptPath || !fileExists(transcriptPath)) {
    // Remember the candidate without claiming the link. An empty session that
    // never writes its file simply expires here instead of poisoning state.
    if (s.agents.claude.pendingId !== id || s.agents.claude.pendingPath !== transcriptPath) {
      s.agents.claude.pendingId = id;
      s.agents.claude.pendingPath = transcriptPath;
      return true;
    }
    return false;
  }

  s.agents.claude.id = id;
  s.agents.claude.transcriptPath = transcriptPath;
  delete s.agents.claude.pendingId;
  delete s.agents.claude.pendingPath;
  return true;
}

function hookSessionStart(projectDir, s, input) {
  let dirty = linkClaudeSession(s, input);

  // Inject a pending Codex→Claude delta exactly once. Two delivery modes:
  //  - id set: on resume of that original session (proven in T1)
  //  - id null: Codex-first project — deliver to the first Claude
  //    session that starts here, whatever its source.
  const inj = s.pendingInjection;
  const injectHere =
    inj?.agent === "claude" &&
    (inj.id == null || (input.source === "resume" && inj.id === input.session_id));
  if (injectHere) {
    const deltaPath = path.join(projectDir, inj.deltaFile);
    let delta = null;
    try {
      delta = fs.readFileSync(deltaPath, "utf8");
    } catch {}
    if (delta) {
      try {
        fs.renameSync(deltaPath, deltaPath + ".consumed");
      } catch {
        return 0;
      }
      commitKnown(s, inj);
      s.pendingInjection = null;
      saveState(projectDir, s);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: delta,
          },
        })
      );
      return 0;
    }
    // Delta missing: never silently lose context — surface it in-session.
    s.pendingInjection = null;
    saveState(projectDir, s);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            "[Bridge] A Codex→Claude context delta was pending but its file could not be read. " +
            "Context may be incomplete — ask the user what happened in Codex, or check .bridge/checkpoints/.",
        },
      })
    );
    return 0;
  }

  if (dirty) saveState(projectDir, s);
  return 0;
}

function hookStop(projectDir, s, input) {
  // A turn just ended, so the transcript exists now if it ever will.
  let dirty = linkClaudeSession(s, input);

  // A Claude turn finished. Only meaningful while a handoff away from claude
  // is pending — flip the idle marker the launcher waits for.
  if (s.pendingHandoff?.ready && s.pendingHandoff.target !== "claude" && s.activeAgent === "claude") {
    if (!s.agents.claude.id || s.agents.claude.id === input.session_id) {
      s.agents.claude.idle = true;
      dirty = true;
    }
  }
  // One write per hook: both changes belong to the same turn ending.
  if (dirty) saveState(projectDir, s);
  return 0;
}

function hookUserPromptSubmit(projectDir, s, input) {
  // The user just spoke, which is what brings the transcript into being.
  let dirty = linkClaudeSession(s, input);
  if (s.agents.claude.idle) {
    s.agents.claude.idle = false;
    dirty = true;
  }
  if (dirty) saveState(projectDir, s);
  return 0;
}

function readStdinJson() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    setTimeout(() => resolve(null), 3000).unref();
  });
}

/**
 * Codex's side of the same job. Its hook input carries `session_id` and
 * `transcript_path`, which makes linking a fact rather than the filesystem
 * guesswork `adoptStartedSession` has to do, and every run stamps `hookSeen` so
 * a later version can tell whether hooks are actually live in this project
 * instead of assuming it.
 */
function codexHook(projectDir, s, event, input) {
  const slot = agentSlot(s, "codex");
  let dirty = false;

  if (!s.agents.codex.hookSeen || s.agents.codex.hookSeen < nowIso().slice(0, 10)) {
    s.agents.codex.hookSeen = nowIso();
    dirty = true;
  }

  const id = input?.session_id;
  const transcriptPath = input?.transcript_path || null;
  if (id && !slot.id && transcriptPath && fileExists(transcriptPath)) {
    slot.set({ id, transcriptPath });
    dirty = true;
  } else if (id && slot.id === id && transcriptPath && slot.transcriptPath !== transcriptPath) {
    slot.set({ transcriptPath });
    dirty = true;
  }

  // A finished turn is what the launcher waits for before switching away.
  if (event === "stop" && s.pendingHandoff?.ready && s.pendingHandoff.target !== "codex" && s.activeAgent === "codex") {
    if (!slot.id || slot.id === id) {
      slot.set({ idle: true });
      dirty = true;
    }
  }
  if (event === "user-prompt-submit" && slot.idle) {
    slot.set({ idle: false });
    dirty = true;
  }

  if (dirty) saveState(projectDir, s);
  return 0;
}
