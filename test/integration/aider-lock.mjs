// Opt-in native Python process acceptance; no Aider installation is required.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const python = process.argv[2];
assert.ok(python && path.isAbsolute(python), "supply an absolute trusted Python interpreter");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-aider-lock-"));
const lock = path.join(root, "session.lock");
const marker = path.join(root, "writer-started");
const module = fileURLToPath(new URL("../../src/agents/aider_lock.py", import.meta.url));
const program = `import importlib.util,sys
s=importlib.util.spec_from_file_location('locks',sys.argv[1])
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with m.session_lock(sys.argv[2]):
    if sys.argv[3]=='hold':
        print('LOCKED',flush=True)
        sys.stdin.read()
    else:
        open(sys.argv[3],'w').write('owned')
`;
const args = (mode, file = lock) => ["-I", "-B", "-c", program, module, file, mode];
const holder = spawn(python, args("hold"), { stdio: ["pipe", "pipe", "pipe"] });
const closed = once(holder, "close");
const timer = setTimeout(() => holder.kill("SIGKILL"), 10000);
let stderr = "";
holder.stderr.on("data", (chunk) => { stderr += chunk; });
try {
  await new Promise((resolve, reject) => {
    let output = "";
    holder.stdout.on("data", (chunk) => { output += chunk; if (output.includes("LOCKED")) resolve(); });
    holder.on("error", reject);
    holder.on("close", () => reject(new Error(`holder exited before ready: ${stderr}`)));
  });
  const inode = fs.statSync(lock).ino;
  const competing = spawnSync(python, args(marker), { encoding: "utf8", timeout: 5000 });
  assert.notEqual(competing.status, 0);
  assert.match(competing.stderr, /already has a writer/);
  assert.equal(fs.existsSync(marker), false, "second writer must not execute its body");
  holder.kill("SIGKILL");
  await closed;
  const recovered = spawnSync(python, args(marker), { encoding: "utf8", timeout: 5000 });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.readFileSync(marker, "utf8"), "owned");
  assert.equal(fs.statSync(lock).ino, inode, "recovery must not replace the stable lock inode");
  const link = path.join(root, "linked.lock");
  fs.symlinkSync(marker, link);
  const unsafe = spawnSync(python, args(marker, link), { encoding: "utf8", timeout: 5000 });
  assert.notEqual(unsafe.status, 0);
  assert.equal(fs.readFileSync(marker, "utf8"), "owned");
  console.log(JSON.stringify({ platform: process.platform, concurrentWriterRefused: true,
    crashRecovery: true, stableLockFile: true, symlinkRefused: true }));
} finally {
  clearTimeout(timer);
  if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
  await closed;
  fs.rmSync(root, { recursive: true, force: true });
}
