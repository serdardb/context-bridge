import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parsePackResult } from "../../src/npm-pack.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const npm = process.env.npm_execpath;
const globalInstall = process.env.BRIDGE_TEST_GLOBAL_INSTALL === "1";
const scope = globalInstall ? ["--global"] : [];
assert.ok(npm && path.isAbsolute(npm), "run through npm run test:package");
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-clean-package-")));
const run = (args, cwd, timeout = 180000) => {
  const env = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" };
  delete env.CONTEXT_BRIDGE_MCP_MODULE;
  const result = spawnSync(process.execPath, args, {
    cwd, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env,
  });
  assert.equal(result.status, 0, result.error?.message || `${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  const pack = parsePackResult(run([npm, "pack", "--ignore-scripts", "--json", "--pack-destination", temporary], root),
    "@serdardb/context-bridge");
  assert.equal(path.basename(pack.filename), pack.filename);
  assert.ok(pack.files.length > 0);
  for (const file of pack.files) {
    assert.doesNotMatch(file.path, /^(?:test|notes|\.bridge)(?:\/|$)/);
  }
  const prefix = path.join(temporary, "installation");
  run([npm, "install", ...scope, "--prefix", prefix, "--ignore-scripts", "--omit=dev",
    "--engine-strict", "--no-audit", "--no-fund", path.join(temporary, pack.filename)], temporary);
  const modules = path.join(prefix, ...(globalInstall && process.platform !== "win32" ? ["lib"] : []), "node_modules");
  const installed = path.join(modules, "@serdardb", "context-bridge");
  const footprint = () => {
    let bytes = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) {
          bytes += fs.statSync(file).size;
        }
      }
    };
    walk(modules);
    const packages = run([npm, "ls", ...scope, "--prefix", prefix, "--omit=dev", "--all", "--parseable"], prefix)
      .trim().split("\n").filter((line) => path.resolve(line).startsWith(modules + path.sep));
    return { regularFileBytes: bytes, installedPackages: new Set(packages).size };
  };
  const coreFootprint = footprint();
  process.stdout.write(run([path.join(root, "test", "integration", "installed-package.mjs"), installed, "--core-only"], temporary, 120000));
  const companion = parsePackResult(run([npm, "pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
    path.join(root, "packages", "mcp")), "@serdardb/context-bridge-mcp");
  assert.equal(path.basename(companion.filename), companion.filename);
  for (const file of companion.files) assert.ok(["index.mjs", "verify-release.mjs", "README.md", "LICENSE", "package.json"].includes(file.path), file.path);
  run([npm, "install", ...scope, "--prefix", prefix, "--ignore-scripts", "--omit=dev",
    "--engine-strict", "--no-audit", "--no-fund", path.join(temporary, companion.filename)], temporary);
  const combinedFootprint = footprint();
  // npm does not support auditing global installations. The local mode audits
  // the fresh consumer graph; the global mode verifies sibling resolution.
  if (!globalInstall) {
    const audit = JSON.parse(run([npm, "audit", "--omit=dev", "--json"], prefix));
    assert.equal(audit.metadata.vulnerabilities.total, 0, "audit the actual installed companion dependency graph");
  }
  const acceptance = run([path.join(root, "test", "integration", "installed-package.mjs"), installed], temporary, 120000);
  process.stdout.write(acceptance);
  if (process.env.BRIDGE_ACCEPTANCE_PYTHON) {
    process.stdout.write(run([path.join(root, "test", "integration", "aider-lock.mjs"),
      process.env.BRIDGE_ACCEPTANCE_PYTHON, installed], temporary, 30000));
  }
  console.log(JSON.stringify({ cleanInstall: true, engineStrict: true, files: pack.entryCount,
    integrity: pack.integrity, companionIntegrity: companion.integrity, coreFootprint, combinedFootprint,
    globalInstall, node: process.version, platform: process.platform }));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
