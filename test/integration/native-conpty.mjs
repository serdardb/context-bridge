import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

assert.equal(process.platform, "win32", "this acceptance exercises Windows ConPTY");
const modulePath = process.env.BRIDGE_TEST_PTY_MODULE;
assert.ok(modulePath && path.isAbsolute(modulePath), "supply an isolated node-pty installation");
const { spawn } = createRequire(import.meta.url)(modulePath);
const [executable, ...args] = process.argv.slice(2);
assert.ok(executable && path.isAbsolute(executable));
const aider = process.env.BRIDGE_TEST_PTY_FLOW === "aider";
const label = aider ? "Aider" : "Pi";
const response = aider ? "PTY_NATIVE_COMPLETED_5368" : "PI_NATIVE_RESPONSE_3";
console.error(`${label} ConPTY: starting native terminal`);
const terminal = spawn(executable, args, {
  name: "xterm-256color", cols: 120, rows: 40,
  // Pin the terminal implementation as well as node-pty, not the runner's OS DLL.
  useConpty: true, useConptyDll: true,
  cwd: process.cwd(), env: process.env,
});
console.error(`${label} ConPTY: native terminal started`);
let output = "", answered = false, timedOut = false, quitTimer, followTimer;
let interrupted = false, followed = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`${label} ConPTY timeout: answered=${answered}\n${output.slice(-8192)}`);
  // ConPTY teardown itself may block. Bound cleanup of this fixture's tree.
  spawnSync(path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
    ["/PID", String(terminal.pid), "/T", "/F"], { timeout: 5000, stdio: "ignore" });
  process.exit(1);
}, 30000);
terminal.onData((data) => {
  output += data;
  if (aider && !interrupted && output.includes("INTERRUPTED_STREAM_8741")) {
    interrupted = true;
    const win32Input = output.lastIndexOf("\x1b[?9001h") > output.lastIndexOf("\x1b[?9001l");
    console.error(`${label} ConPTY: interrupt with win32-input-mode=${win32Input}`);
    // Honor ConPTY's requested keyboard protocol: Ctrl down, C down/up, Ctrl up.
    terminal.write(win32Input
      ? "\x1b[17;29;0;1;8;1_\x1b[67;46;3;1;8;1_\x1b[67;46;3;0;8;1_\x1b[17;29;0;0;0;1_"
      : "\x03");
  }
  if (aider && interrupted && !followed && output.includes("^C again to exit")) {
    followed = true;
    followTimer = setTimeout(() => terminal.write("PTY_FOLLOW_UP_4529\r"), 2200);
  }
  if (!answered && (!aider || followed) && output.includes(response)) {
    answered = true;
    console.error(`${label} ConPTY: native response observed; requesting normal exit`);
    quitTimer = setTimeout(() => terminal.write(aider ? "/exit\r" : "\x04"), 500);
  }
});
terminal.onExit(({ exitCode }) => {
  console.error(`${label} ConPTY: native exit ${exitCode}`);
  clearTimeout(timer);
  clearTimeout(quitTimer);
  clearTimeout(followTimer);
  if (exitCode !== 0 || timedOut || !answered) {
    process.stderr.write(`Native ${label} ConPTY failed: exit=${exitCode}, timeout=${timedOut}, answered=${answered}\n${output}\n`,
      () => process.exit(1));
  } else {
    // The native child has exited successfully. Do not retain node-pty's
    // ConPTY worker handles in this single-purpose acceptance helper.
    process.stdout.write(`${response}\n`, () => process.exit(0));
  }
});
