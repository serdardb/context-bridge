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
console.error("Pi ConPTY: starting native terminal");
const terminal = spawn(executable, args, {
  name: "xterm-256color", cols: 120, rows: 40,
  // Pin the terminal implementation as well as node-pty, not the runner's OS DLL.
  useConpty: true, useConptyDll: true,
  cwd: process.cwd(), env: process.env,
});
console.error("Pi ConPTY: native terminal started");
let output = "", answered = false, timedOut = false, quitTimer;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`Pi ConPTY timeout: answered=${answered}\n${output.slice(-8192)}`);
  // ConPTY teardown itself may block. Bound cleanup of this fixture's tree.
  spawnSync(path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
    ["/PID", String(terminal.pid), "/T", "/F"], { timeout: 5000, stdio: "ignore" });
  process.exit(1);
}, 30000);
terminal.onData((data) => {
  output += data;
  if (!answered && output.includes("PI_NATIVE_RESPONSE_3")) {
    answered = true;
    console.error("Pi ConPTY: native response observed; requesting normal exit");
    quitTimer = setTimeout(() => terminal.write("\x04"), 500);
  }
});
terminal.onExit(({ exitCode }) => {
  console.error(`Pi ConPTY: native exit ${exitCode}`);
  clearTimeout(timer);
  clearTimeout(quitTimer);
  if (exitCode !== 0 || timedOut || !answered) {
    process.stderr.write(`Native Pi ConPTY failed: exit=${exitCode}, timeout=${timedOut}, answered=${answered}\n${output}\n`,
      () => process.exit(1));
  } else {
    // The native child has exited successfully. Do not retain node-pty's
    // ConPTY worker handles in this single-purpose acceptance helper.
    process.stdout.write("PI_NATIVE_RESPONSE_3\n", () => process.exit(0));
  }
});
