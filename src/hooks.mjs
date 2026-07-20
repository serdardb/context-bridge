// `bridge internal-hook <event>` — invoked by the Claude Code plugin hooks.
// Reads the hook input JSON from stdin. Silently no-ops for projects that
// have no .bridge/ state (the plugin may be installed user-wide).
import fs from "node:fs";
import path from "node:path";
import { loadState, saveState } from "./state.mjs";

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

function hookSessionStart(projectDir, s, input) {
  let dirty = false;

  // Record the native Claude session refs (never shown to the user).
  if (!s.agents.claude.id && input.session_id) {
    s.agents.claude.id = input.session_id;
    s.agents.claude.transcriptPath = input.transcript_path || null;
    dirty = true;
  } else if (s.agents.claude.id === input.session_id && input.transcript_path) {
    if (s.agents.claude.transcriptPath !== input.transcript_path) {
      s.agents.claude.transcriptPath = input.transcript_path;
      dirty = true;
    }
  }

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
  // A Claude turn finished. Only meaningful while a handoff away from claude
  // is pending — flip the idle marker the launcher waits for.
  if (s.pendingHandoff?.ready && s.pendingHandoff.target !== "claude" && s.activeAgent === "claude") {
    if (!s.agents.claude.id || s.agents.claude.id === input.session_id) {
      s.agents.claude.idle = true;
      saveState(projectDir, s);
    }
  }
  return 0;
}

function hookUserPromptSubmit(projectDir, s) {
  if (s.agents.claude.idle) {
    s.agents.claude.idle = false;
    saveState(projectDir, s);
  }
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
