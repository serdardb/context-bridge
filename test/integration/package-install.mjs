import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
const npm = process.env.npm_execpath;
assert.ok(npm && path.isAbsolute(npm), "run through npm run test:package");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-clean-package-"));
const run = (args, cwd, timeout = 180000) => {
  const result = spawnSync(process.execPath, args, {
    cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
  });
  assert.equal(result.status, 0, result.error?.message || `${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  const [pack] = JSON.parse(run([npm, "pack", "--ignore-scripts", "--json", "--pack-destination", temporary], root));
  assert.equal(path.basename(pack.filename), pack.filename);
  assert.ok(pack.files.length > 0);
  for (const file of pack.files) {
    assert.doesNotMatch(file.path, /^(?:test|notes|\.bridge)(?:\/|$)/);
  }
  const prefix = path.join(temporary, "installation");
  run([npm, "install", "--prefix", prefix, "--ignore-scripts", "--omit=dev",
    "--engine-strict", "--no-audit", "--no-fund", path.join(temporary, pack.filename)], temporary);
  const installed = path.join(prefix, "node_modules", "@serdardb", "context-bridge");
  const acceptance = run([path.join(root, "test", "integration", "installed-package.mjs"), installed], temporary, 120000);
  process.stdout.write(acceptance);
  console.log(JSON.stringify({ cleanInstall: true, engineStrict: true, files: pack.entryCount,
    integrity: pack.integrity, node: process.version, platform: process.platform }));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
