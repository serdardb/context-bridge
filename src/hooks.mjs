// `bridge internal-hook <event>` — invoked by the Claude Code plugin hooks.
// Reads the hook input JSON from stdin. Silently no-ops for projects that
// have no .bridge/ state (the plugin may be installed user-wide).
import fs from "node:fs";
import path from "node:path";
import { loadState, saveState, commitKnown } from "./state.mjs";
import { fileExists } from "./util.mjs";

export async function runHook(event) {
  const input = await readStdinJson();
  const projectDir = input?.cwd || process.cwd();
  let s;
  try {
    s = loadState(projectDir);
  } catch {
    return 0; // unreadable/foreign state — never break the user's session
  }
  if (!s) return 0;

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
