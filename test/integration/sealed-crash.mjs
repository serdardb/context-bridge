// Opt-in real-process interruption matrix; no provider, Git or user store access.
import "../lane-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publication } from "../../src/publication.mjs";
import { sealArtifact, openSealedArtifact } from "../../src/sealed-artifact.mjs";
import { exportArtifact } from "../../src/artifact.mjs";
import { ensureState, writeCheckpoint } from "../../src/state.mjs";

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === "--worker") {
  const [mode, input, output, key, index] = process.argv.slice(3);
  const operations = [];
  for (const [object, name] of [[fs, "writeFileSync"], [fs, "fsyncSync"], [publication, "renameExclusive"]]) {
    const original = object[name];
    object[name] = (...args) => {
      const result = original(...args);
      operations.push(name);
      if (operations.length === Number(index)) process.exit(79);
      return result;
    };
  }
  if (mode === "seal") sealArtifact(input, output);
  else openSealedArtifact(input, output, { keyFile: key });
  console.log(JSON.stringify(operations));
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sealed-crash-"));
  const previous = process.env.CONTEXT_BRIDGE_HOME;
  const previousMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = path.join(root, "runtime");
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    ensureState(project);
    writeCheckpoint(project, "main", "2026-09-18T00-00-00-000Z-claude-to-codex-full.md", "Synthetic interruption acceptance.");
    const source = path.join(root, "source.cbctx");
    exportArtifact(project, source);
    const expected = fs.readFileSync(source);
    const seed = sealArtifact(source, path.join(root, "seed"));
    const report = {};
    for (const mode of ["seal", "open"]) {
      let operations = null;
      for (let fault = 0; operations === null || fault <= operations.length; fault++) {
        const directory = path.join(root, `${mode}-${fault}`);
        fs.mkdirSync(directory);
        const output = path.join(directory, mode === "seal" ? "bundle" : "opened.cbctx");
        const input = mode === "seal" ? source : seed.sealedFile;
        const result = spawnSync(process.execPath, [self, "--worker", mode, input, output, seed.keyFile, String(fault)], {
          env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 15000,
        });
        assert.equal(result.status, fault === 0 ? 0 : 79, result.stderr || result.error?.message);
        if (fault === 0) operations = JSON.parse(result.stdout);
        if (mode === "seal") {
          const existed = fs.existsSync(output);
          if (!existed) sealArtifact(source, output);
          assert.deepEqual(fs.readdirSync(output).sort(), ["context.cbsealed", "key.bin"]);
          const keyFile = path.join(output, "key.bin");
          const key = fs.readFileSync(keyFile);
          const ciphertext = fs.readFileSync(path.join(output, "context.cbsealed"));
          const plaintext = path.join(directory, "verified.cbctx");
          openSealedArtifact(path.join(output, "context.cbsealed"), plaintext, { keyFile });
          assert.deepEqual(fs.readFileSync(plaintext), expected);
          assert.throws(() => sealArtifact(source, output), { code: "EEXIST" });
          assert.deepEqual(fs.readFileSync(keyFile), key);
          assert.deepEqual(fs.readFileSync(path.join(output, "context.cbsealed")), ciphertext);
        } else {
          if (!fs.existsSync(output)) openSealedArtifact(input, output, { keyFile: seed.keyFile });
          assert.deepEqual(fs.readFileSync(output), expected);
          assert.throws(() => openSealedArtifact(input, output, { keyFile: seed.keyFile }), { code: "EEXIST" });
        }
        if (process.platform !== "win32") {
          for (const name of fs.readdirSync(directory)) {
            const info = fs.lstatSync(path.join(directory, name));
            if (name.startsWith(".")) assert.equal(info.mode & 0o077, 0, "interrupted staging must remain private");
          }
        }
        assert.deepEqual(fs.readdirSync(project), []);
      }
      report[mode] = { operations, interruptedProcesses: operations.length };
    }
    console.log(JSON.stringify({ passed: true, platform: process.platform, arch: process.arch,
      node: process.version, report, scope: "actual process exits after observed write/flush/publication calls; not partial syscall writes, hostile parent swaps or physical power loss" }, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = previous;
    if (previousMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = previousMode;
  }
}
