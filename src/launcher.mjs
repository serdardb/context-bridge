// The bridge launcher loop. Process shape (proven in T4):
//   shell └── bridge └── exactly one active agent child (claude | codex)
// Auto-exit safety (spec §11): SIGTERM is sent ONLY to the exact child PID we
// spawned, ONLY when a persisted handoff is ready AND the agent is idle.
// Never SIGKILL. Never process-name matching. If idle is uncertain: tell the
// user instead of terminating.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureState, loadState, saveState } from "./state.mjs";
import { rolloutIdleAfter } from "./delta.mjs";
import { findRolloutPath } from "./discover.mjs";
import { log, dim, bold, OK, WARN, BAD, nowIso } from "./util.mjs";

const POLL_MS = 500;
const IDLE_DEBOUNCE_MS = 1000;
const TERM_GRACE_MS = 10000;

export async function runLoop(projectDir, startAgent = null) {
  let s = ensureState(projectDir);
  let agent = startAgent || s.activeAgent || "claude";

  // Ctrl+C typed inside the child goes to the whole foreground process group —
  // the child handles it; the launcher must survive (proven in T4).
  process.on("SIGINT", () => {});

  log(bold("context-bridge") + dim(" · Switch agents. Not context."));

  for (;;) {
    s = ensureState(projectDir);
    const { cmd, args, note } = buildCommand(projectDir, s, agent);
    if (!cmd) {
      log(`${BAD} ${note}`);
      return 1;
    }

    // This launch consumes any pending handoff towards `agent`.
    if (s.pendingHandoff?.target === agent) s.pendingHandoff = null;
    s.activeAgent = agent;
    s.agents[agent].idle = false;
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

function buildCommand(projectDir, s, agent) {
  if (agent === "claude") {
    const sid = s.agents.claude.sessionId;
    return sid
      ? { cmd: "claude", args: ["--resume", sid], note: "Resuming your Claude session…" }
      : { cmd: "claude", args: [], note: "Starting a new Claude session for this project…" };
  }
  if (agent === "codex") {
    const tid = s.agents.codex.threadId;
    if (!tid) {
      return {
        cmd: null,
        args: [],
        note: "No linked Codex thread yet. Start inside Claude and run /bridge codex for the first switch.",
      };
    }
    const args = ["resume", tid];
    // Deliver a pending Claude→Codex delta as the auto-submitted resume prompt (proven in T2).
    const inj = s.pendingInjection;
    if (inj?.agent === "codex" && inj.threadId === tid) {
      const deltaPath = path.join(projectDir, inj.deltaFile);
      try {
        const delta = fs.readFileSync(deltaPath, "utf8");
        args.push(delta);
        // consume exactly once
        try {
          fs.renameSync(deltaPath, deltaPath + ".consumed");
        } catch {}
        s.pendingInjection = null;
        saveState(projectDir, s);
      } catch {
        // If unreadable, do not pretend: leave marker, tell the user.
        log(`${WARN} Pending Claude→Codex delta could not be read (${inj.deltaFile}); resuming Codex without it.`);
      }
    }
    return { cmd: "codex", args, note: "Resuming your Codex thread…" };
  }
  return { cmd: null, args: [], note: `Unknown agent '${agent}'.` };
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

    // Idle checks (spec §11): claude via Stop-hook marker; codex via
    // task_complete appearing in the rollout after the handoff request.
    let idle = false;
    if (agent === "claude") {
      idle = s.agents.claude.idle === true;
    } else if (agent === "codex") {
      const rollout = s.agents.codex.rolloutPath || findRolloutPath(s.agents.codex.threadId || "");
      idle = rollout ? rolloutIdleAfter(rollout, pending.requestedAt) : false;
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
  return env;
}
