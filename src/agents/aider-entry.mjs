import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createAiderSession, aiderSessionRef } from "./aider-sessions.mjs";
import { resolveAiderRuntime } from "./aider-runtime.mjs";
import { writeJsonAtomic } from "../util.mjs";
import { openAiderLifeline } from "./aider-lifeline.mjs";

// New sessions are prepared in this child, not while constructing a command.
// Their launch identity therefore belongs to the launcher's observation window.
export async function runAiderEntry(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    new: { type: "boolean" }, session: { type: "string" },
    "native-args": { type: "string", default: "[]" }, prompt: { type: "string" },
    once: { type: "boolean" }, smoke: { type: "boolean" },
  }, strict: true, allowPositionals: false });
  if (values.smoke) {
    if (values.new || values.session || values.once || values.prompt !== undefined) throw new Error("Invalid Aider smoke mode.");
    const cwd = process.cwd(), home = process.env.CONTEXT_BRIDGE_HOME;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-aider-smoke-"));
    try {
      fs.mkdirSync(path.join(scratch, "project"));
      process.chdir(path.join(scratch, "project"));
      process.env.CONTEXT_BRIDGE_HOME = path.join(scratch, "runtime");
      return await runAiderEntry(["--new", "--once", "--native-args", values["native-args"],
        "--prompt", "Reply with exactly: bridge-ok"]);
    } finally {
      process.chdir(cwd);
      if (home === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = home;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (Boolean(values.new) === Boolean(values.session)) throw new Error("Choose exactly one Aider session mode.");
  if (values.once && !values.prompt) throw new Error("One-turn Aider mode requires a prompt.");
  let native;
  try { native = JSON.parse(values["native-args"]); } catch {}
  if (!Array.isArray(native) || native.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("Invalid Aider native argument list.");
  }
  const project = process.cwd();
  const ref = values.new ? createAiderSession(project) : aiderSessionRef(project, values.session);
  const runtime = resolveAiderRuntime({ env: { ...process.env,
    CONTEXT_BRIDGE_AIDER_PYTHON: process.env.CONTEXT_BRIDGE_AIDER_PYTHON ?? ref.python } });
  if (runtime.cmd !== ref.python) throw new Error("The linked Aider session belongs to a different Python environment.");
  const directory = path.dirname(ref.eventsPath);
  writeJsonAtomic(path.join(directory, "launch.json"), { version: 1, sessionId: ref.id,
    projectId: ref.projectId, pid: process.pid, at: new Date().toISOString() });
  const args = [...runtime.flags, fileURLToPath(new URL("aider_driver.py", import.meta.url)),
    "--session-dir", directory, "--session-id", ref.id, "--project-id", ref.projectId,
    "--native-args", JSON.stringify(native)];
  if (values.prompt !== undefined) args.push("--prompt", values.prompt);
  if (values.once) args.push("--once");
  const lifeline = await openAiderLifeline();
  let child;
  try {
    child = spawn(runtime.cmd, args, { cwd: project, stdio: "inherit",
      env: { ...process.env, CONTEXT_BRIDGE_AIDER_PARENT: lifeline.environment,
        GIT_PYTHON_REFRESH: process.env.GIT_PYTHON_REFRESH ?? "quiet" } });
  } catch (error) { lifeline.close(); throw error; }
  const terminate = () => child.kill("SIGTERM");
  // Terminal Ctrl+C reaches both processes. Aider owns interrupt/retry handling;
  // exiting this wrapper would close its PTY while the SDK is still running.
  // Do not forward SIGINT again: that would turn one interrupt into two.
  const interrupt = () => {};
  process.on("SIGTERM", terminate);
  process.on("SIGINT", interrupt);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
  } finally {
    lifeline.close();
    process.off("SIGTERM", terminate);
    process.off("SIGINT", interrupt);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runAiderEntry(); }
  catch { console.error("bridge: Aider startup failed; the pending handoff has not been acknowledged."); process.exitCode = 1; }
}
