// Native parent-death/lock test; uses Python's stdlib, not an installed Aider SDK.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const python = process.argv[2];
assert.ok(python && path.isAbsolute(python));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-parent-native-"));
const lock = path.join(root, "session.lock");
const driver = fileURLToPath(new URL("../../src/agents/aider_driver.py", import.meta.url));
const locks = fileURLToPath(new URL("../../src/agents/aider_lock.py", import.meta.url));
const program = `import importlib.util,os,sys,time
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module
load('driver',sys.argv[1]).watch_parent()
with load('locks',sys.argv[2]).session_lock(sys.argv[3]):
    print('READY '+str(os.getpid()),flush=True)
    time.sleep(60)
`;
const runner = path.join(root, "entry.mjs");
fs.writeFileSync(runner, `import {spawn} from 'node:child_process';
import {openAiderLifeline} from ${JSON.stringify(new URL("../../src/agents/aider-lifeline.mjs", import.meta.url).href)};
const link=await openAiderLifeline();
const child=spawn(${JSON.stringify(python)},${JSON.stringify(["-I", "-B", "-c", program, driver, locks, lock])},
 {stdio:['ignore','inherit','inherit'],env:{...process.env,CONTEXT_BRIDGE_AIDER_PARENT:link.environment}});
child.on('error',()=>{link.close();process.exitCode=1;});
child.on('close',code=>{link.close();process.exitCode=code ?? 1;});
`);
const owner = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "pipe"] });
const closed = once(owner, "close");
let sdkPid, errors = "";
owner.stderr.on("data", (chunk) => { errors += chunk; });
const timeout = setTimeout(() => {
  owner.kill("SIGKILL");
  if (sdkPid) try { process.kill(sdkPid, "SIGKILL"); } catch {}
}, 15000);
try {
  await new Promise((resolve, reject) => {
    let output = "";
    owner.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/READY (\d+)/);
      if (match) { sdkPid = Number(match[1]); resolve(); }
    });
    owner.once("error", reject);
    owner.once("close", () => reject(new Error(`entry exited before lock acquisition: ${errors}`)));
  });
  const inode = fs.statSync(lock).ino;
  const killed = Date.now();
  owner.kill("SIGKILL");
  await closed; // Inherited SDK stdout keeps this open unless Python also exits.
  assert.ok(Date.now() - killed < 5000, "parent watcher must exit before test cleanup kills the child");
  const probe = spawnSync(python, ["-I", "-B", "-c", `import importlib.util,sys
s=importlib.util.spec_from_file_location('locks',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with m.session_lock(sys.argv[2]): print('RECOVERED')
`, locks, lock], { encoding: "utf8", timeout: 5000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), "RECOVERED");
  assert.equal(fs.statSync(lock).ino, inode);
  console.log(JSON.stringify({ platform: process.platform, parentKilledAlone: true,
    childExited: true, lockRecovered: true, sdkInstalledRequired: false }));
} finally {
  clearTimeout(timeout);
  owner.kill("SIGKILL");
  if (sdkPid) try { process.kill(sdkPid, "SIGKILL"); } catch {}
  await closed;
  fs.rmSync(root, { recursive: true, force: true });
}
