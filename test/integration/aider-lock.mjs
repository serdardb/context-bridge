// Opt-in native Python process acceptance; no Aider installation is required.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const python = process.argv[2];
assert.ok(python && path.isAbsolute(python), "supply an absolute trusted Python interpreter");
const packageRoot = process.argv[3] || fileURLToPath(new URL("../../", import.meta.url));
assert.ok(path.isAbsolute(packageRoot), "package root must be absolute");
const lockingUrl = pathToFileURL(path.join(packageRoot, "src/locking.mjs")).href;
const { withKernelLockSync } = await import(lockingUrl);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-aider-lock-"));
const lock = path.join(root, "session.lock");
const marker = path.join(root, "writer-started");
const module = path.join(packageRoot, "src/agents/aider_lock.py");
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
const nodeLock = () => spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { withKernelLockSync } from ${JSON.stringify(lockingUrl)};
  withKernelLockSync(${JSON.stringify(lock)}, () => {});
`], { encoding: "utf8", timeout: 5000,
  env: { ...process.env, CONTEXT_BRIDGE_LOCK_TIMEOUT_MS: "150" } });
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
  const nodeBlocked = nodeLock();
  assert.equal(nodeBlocked.status, 1, 'Node recovery must respect the Python writer lock');
  assert.match(nodeBlocked.stderr, /BRIDGE_LOCK_TIMEOUT/);
  holder.kill("SIGKILL");
  await closed;
  const nodeRecovered = nodeLock();
  assert.equal(nodeRecovered.status, 0, nodeRecovered.stderr);
  const recovered = spawnSync(python, args(marker), { encoding: "utf8", timeout: 5000 });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.readFileSync(marker, "utf8"), "owned");
  fs.unlinkSync(marker);
  withKernelLockSync(lock, () => {
    const pythonBlocked = spawnSync(python, args(marker), { encoding: "utf8", timeout: 5000 });
    assert.notEqual(pythonBlocked.status, 0);
    assert.match(pythonBlocked.stderr, /already has a writer/);
    assert.equal(fs.existsSync(marker), false, "Python must respect a Node-owned lock");
  });
  const afterNode = spawnSync(python, args(marker), { encoding: "utf8", timeout: 5000 });
  assert.equal(afterNode.status, 0, afterNode.stderr);
  assert.equal(fs.statSync(lock).ino, inode, "recovery must not replace the stable lock inode");
  const link = path.join(root, "linked.lock");
  fs.symlinkSync(marker, link);
  const unsafe = spawnSync(python, args(marker, link), { encoding: "utf8", timeout: 5000 });
  assert.notEqual(unsafe.status, 0);
  assert.equal(fs.readFileSync(marker, "utf8"), "owned");
  const driver = path.join(packageRoot, "src/agents/aider_driver.py");
  const evidence = spawnSync(python, ["-I", "-B", "-c", `
import importlib.util,json,os,sys
from pathlib import Path
from types import SimpleNamespace
s=importlib.util.spec_from_file_location('driver',sys.argv[1])
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=Path(sys.argv[2]);events=root/'events.jsonl'
m.watch_parent=lambda: None
args=SimpleNamespace(session_dir=str(root),reservation=str(root/'removed-operation.json'),session_id='session',project_id='project')
try:
    m.run(args)
    raise AssertionError('a late child must refuse a recovered reservation')
except FileNotFoundError as error:
    assert error.filename == args.reservation
events.write_text(json.dumps(dict(type='session',version=1,sessionId='session',projectId='project'))+'\\n')
(root/'chat.md').write_text('')
record=m.Evidence(root,'session','project')
record.append(0,False,[])
outside=root/'external-evidence';outside.write_bytes(b'private unchanged')
original=os.open
def swapped(file,flags,*args,**kwargs):
    if Path(file)==events and flags & os.O_APPEND:
        events.unlink();os.link(outside,events)
    return original(file,flags,*args,**kwargs)
os.open=swapped
refused=False
try: record.append(0,False,[])
except RuntimeError: refused=True
assert refused,'replaced append descriptor must be refused'
assert outside.read_bytes()==b'private unchanged','external file was modified'
`, driver, root], { encoding: "utf8", timeout: 5000 });
  assert.equal(evidence.status, 0, evidence.stderr || evidence.error?.message);
  console.log(JSON.stringify({ platform: process.platform, concurrentWriterRefused: true,
    crossLanguageExclusion: true, nodeBlocksPython: true, lateChildRefused: true,
    crashRecovery: true, stableLockFile: true, symlinkRefused: true, evidenceSwapRefused: true }));
} finally {
  clearTimeout(timer);
  if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
  await closed;
  fs.rmSync(root, { recursive: true, force: true });
}
