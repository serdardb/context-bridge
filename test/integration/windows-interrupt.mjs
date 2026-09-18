// Isolate terminal delivery, wrapper inheritance and blocked Python socket reads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "win32");
const python = process.argv[2];
const probe = fileURLToPath(new URL("windows-interrupt.py", import.meta.url));
const terminal = fileURLToPath(new URL("native-conpty.mjs", import.meta.url));
const wrapper = `const {spawn}=require('node:child_process');
const child=spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit'});
process.on('SIGINT',()=>{});
child.on('exit',code=>{process.exitCode=code??1});`;
const results = [];
for (const [name, command] of [
  ["direct-python", [python, "-I", probe, "sleep"]],
  ["node-wrapper", [process.execPath, "-e", wrapper, python, "-I", probe, "sleep"]],
  ["blocked-socket", [python, "-I", probe, "socket"]],
]) {
  const result = spawnSync(process.execPath, [terminal, ...command], {
    env: { ...process.env, BRIDGE_TEST_PTY_FLOW: "aider", BRIDGE_TEST_PTY_TRACE: "1" },
    encoding: "utf8", timeout: 40000, maxBuffer: 128 * 1024,
  });
  const receipt = { name, status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
  results.push(receipt);
  console.log(JSON.stringify(receipt));
}
assert.ok(results.every(result => result.status === 0), "Windows interrupt diagnostic failed; inspect individual receipts");
