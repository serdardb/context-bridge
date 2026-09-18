import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

assert.equal(process.platform, "win32", "this acceptance exercises Windows ConPTY");
const modulePath = process.env.BRIDGE_TEST_PTY_MODULE;
assert.ok(modulePath && path.isAbsolute(modulePath), "supply an isolated node-pty installation");
const { spawn } = createRequire(import.meta.url)(modulePath);
const [executable, ...args] = process.argv.slice(2);
assert.ok(executable && path.isAbsolute(executable));
const terminal = spawn(executable, args, {
  name: "xterm-256color", cols: 120, rows: 40,
  cwd: process.cwd(), env: process.env,
});
let output = "", answered = false, timedOut = false, quitTimer;
const timer = setTimeout(() => {
  timedOut = true;
  terminal.kill();
}, 30000);
terminal.onData((data) => {
  output += data;
  if (!answered && output.includes("PI_NATIVE_RESPONSE_3")) {
    answered = true;
    quitTimer = setTimeout(() => terminal.write("\x04"), 500);
  }
});
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  clearTimeout(quitTimer);
  if (exitCode !== 0 || timedOut || !answered) {
    console.error(`Native Pi ConPTY failed: exit=${exitCode}, timeout=${timedOut}, answered=${answered}\n${output}`);
    process.exitCode = 1;
  } else console.log("PI_NATIVE_RESPONSE_3");
});
