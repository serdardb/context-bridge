import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { writeManifest } from "../src/audit.mjs";
import { projectIdentity } from "../src/storage.mjs";
import { exportArtifact, importArtifact, verifyArtifact } from "../src/artifact.mjs";
import { composeFullContext, readFullContextSections } from "../src/delta.mjs";
import { ensureState, writeCheckpoint, mutateState, loadState, checkpointsDir, safeCheckpointPath, statePath } from "../src/state.mjs";

function project() { return fs.mkdtempSync(path.join(os.tmpdir(), "bridge-artifact-project-")); }

test("export preserves indexed multi-source sections with embedded Markdown and redaction", () => {
  const source = project();
  const target = project();
  try {
    const summary = "Summary with a quoted heading\n## Conversation\nnot the transcript";
    const message = "Turkish: gerek\u00e7e \ud83d\udd0e\n## Decisions\n```md\n## Next\n```\npassword=private-value";
    const full = composeFullContext({ fromAgent: "claude", summary,
      sources: [{ label: "Claude", messages: [{ role: "user", text: message }] },
        { label: "Codex", messages: [{ role: "assistant", text: "second stream" }] }],
      decisions: ["actual decision\n## Summary\nstill a decision"], work: [], next: ["actual next"] });
    const suffix = "\nClosing words\n## Decisions\nnot the recorded decisions\n";
    ensureState(source);
    const rel = writeCheckpoint(source, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", full + suffix);
    const output = path.join(source, "context.cbctx");
    exportArtifact(source, output);
    const artifact = verifyArtifact(output);
    assert.equal(artifact.summary, summary);
    assert.equal(artifact.decisions, "- actual decision\n## Summary\nstill a decision");
    assert.equal(artifact.next, "- actual next");
    assert.match(artifact.conversation, /## From Claude/);
    assert.match(artifact.conversation, /## From Codex/);
    assert.ok(artifact.conversation.includes(message.replace("private-value", "<redacted>")));
    assert.ok(artifact.context.endsWith(suffix));
    const exportedSections = readFullContextSections(artifact.context);
    assert.equal(exportedSections.conversation, artifact.conversation);
    assert.equal(exportedSections.summary, artifact.summary);
    assert.equal(artifact.source.sectionFormat, "indexed-v1");
    assert.equal(fs.readFileSync(safeCheckpointPath(source, rel), "utf8"), full + suffix);
    const cli = path.resolve("bin/bridge.mjs");
    const roundtrip = path.join(target, "roundtrip.cbctx");
    for (const [cwd, args] of [[source, ["artifact", "export", output]],
      [target, ["artifact", "import", output, "--apply"]],
      [target, ["artifact", "export", roundtrip]]]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd, env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 15000,
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
    }
    const imported = verifyArtifact(roundtrip);
    for (const key of ["context", "summary", "conversation", "decisions", "next"]) {
      assert.equal(imported[key], artifact[key], `roundtrip preserves ${key}`);
    }
    const before = fs.readFileSync(output);
    fs.writeFileSync(safeCheckpointPath(source, rel), full.replace("actual next", "changed next"));
    assert.throws(() => exportArtifact(source, output), /Invalid full context section index/);
    assert.deepEqual(fs.readFileSync(output), before);
  } finally {
    for (const dir of [source, target]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy free-form checkpoints export whole without guessing structured fields", () => {
  const source = project();
  try {
    ensureState(source);
    const context = "# Bridge full context\n\n## Summary\nlegacy text\n## Conversation\n## From Claude\noriginal evidence";
    writeCheckpoint(source, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", context);
    const output = path.join(source, "context.cbctx");
    exportArtifact(source, output);
    const artifact = verifyArtifact(output);
    assert.equal(artifact.context, context);
    assert.equal(artifact.source.sectionFormat, "opaque");
    for (const key of ["summary", "conversation", "decisions", "next"]) assert.equal(artifact[key], "");
  } finally { fs.rmSync(source, { recursive: true, force: true }); }
});

test("export preserves an existing staging file and cleans only its own failed write", () => {
  const source = project();
  const write = fs.writeFileSync;
  try {
    const output = path.join(source, "context.cbctx");
    const temp = `${output}.tmp-${process.pid}`;
    fs.writeFileSync(output, "previous export");
    fs.writeFileSync(temp, "another operation owns this");
    assert.throws(() => exportArtifact(source, output), { code: "EEXIST" });
    assert.equal(fs.readFileSync(temp, "utf8"), "another operation owns this");
    assert.equal(fs.readFileSync(output, "utf8"), "previous export");
    fs.unlinkSync(temp);
    fs.writeFileSync = (file, ...args) => {
      if (typeof file === "number") {
        fs.writeSync(file, "partial export");
        throw Object.assign(new Error("injected full disk"), { code: "ENOSPC" });
      }
      return write(file, ...args);
    };
    assert.throws(() => exportArtifact(source, output), { code: "ENOSPC" });
    assert.equal(fs.existsSync(temp), false);
    assert.equal(fs.readFileSync(output, "utf8"), "previous export");
    fs.writeFileSync = write;
    exportArtifact(source, output);
    assert.equal(verifyArtifact(output).kind, "context-bridge-context");
    assert.equal(fs.existsSync(temp), false);
  } finally {
    fs.writeFileSync = write;
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("an old import lock is not stolen when owner liveness is unknown", () => {
  const source = project(), target = project(), home = project();
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  const kill = process.kill;
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    ensureState(source);
    ensureState(target);
    writeCheckpoint(source, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", "lock test evidence");
    const artifact = path.join(source, "context.cbctx");
    exportArtifact(source, artifact);
    const identity = projectIdentity(target);
    const key = crypto.createHash("sha256").update(JSON.stringify({ lane: "main", project: identity.id })).digest("hex");
    const dir = path.join(home, "imports");
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, `${key}.lock`);
    const before = fs.readFileSync(statePath(target));
    for (const code of ["EPERM", "EACCES", "EINVAL", null]) {
      const content = code ? `${process.pid}\n` : "invalid owner\n";
      fs.writeFileSync(lock, content);
      fs.utimesSync(lock, new Date(0), new Date(0));
      let checked = false;
      process.kill = () => {
        checked = true;
        const error = new Error("injected liveness failure");
        error.code = code;
        throw error;
      };
      assert.throws(() => importArtifact(artifact, { projectDir: target, apply: true }), /refusing.*(lock|removal)/);
      assert.equal(checked, Boolean(code));
      assert.equal(fs.readFileSync(lock, "utf8"), content);
      assert.deepEqual(fs.readFileSync(statePath(target)), before);
      assert.deepEqual(fs.readdirSync(checkpointsDir(target)), []);
      assert.deepEqual(fs.readdirSync(dir), [`${key}.lock`]);
    }
  } finally {
    process.kill = kill;
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    for (const dir of [source, target, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an import PID stamping failure closes its descriptor and removes only its own marker", () => {
  const source = project(), target = project(), home = project();
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  const open = fs.openSync, write = fs.writeSync;
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  let fd;
  try {
    ensureState(source); ensureState(target);
    writeCheckpoint(source, "main", "2026-09-17T00-00-00-000Z-claude-to-codex-full.md", "stamp failure evidence");
    const file = path.join(source, "context.cbctx");
    exportArtifact(source, file);
    fs.openSync = (candidate, ...args) => {
      const result = open(candidate, ...args);
      if (typeof candidate === "string" && path.dirname(candidate) === path.join(home, "imports") && candidate.endsWith(".lock")) fd = result;
      return result;
    };
    fs.writeSync = (candidate, ...args) => {
      if (fd !== undefined && candidate === fd) throw Object.assign(new Error("injected import stamp failure"), { code: "ENOSPC" });
      return write(candidate, ...args);
    };
    const before = fs.readFileSync(statePath(target));
    assert.throws(() => importArtifact(file, { projectDir: target, apply: true }), /injected import stamp failure/);
    assert.notEqual(fd, undefined);
    assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
    assert.deepEqual(fs.readdirSync(path.join(home, "imports")), []);
    assert.deepEqual(fs.readFileSync(statePath(target)), before);
    fs.openSync = open; fs.writeSync = write;
    assert.equal(importArtifact(file, { projectDir: target, apply: true }).applied, true, "retry must acquire both guards");
  } finally {
    fs.openSync = open; fs.writeSync = write;
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    for (const dir of [source, target, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export pairs context and audit by handoff, never by independent latest files", () => {
  const source = project();
  try {
    ensureState(source);
    const older = "2026-09-15T00-00-00-000Z-claude-to-codex";
    const selected = "2026-09-16T00-00-00-000Z-claude-to-codex";
    const newer = "2026-09-17T00-00-00-000Z-codex-to-claude";
    writeManifest(source, "main", older, { evidence: "older audit" });
    writeCheckpoint(source, "main", `${selected}-full.md`, "selected context");
    writeManifest(source, "main", newer, { evidence: "newer orphan audit" });
    const output = path.join(source, "context.cbctx");
    exportArtifact(source, output);
    assert.equal(verifyArtifact(output).audit, null);
    const auditRel = writeManifest(source, "main", selected, { evidence: "paired audit" });
    exportArtifact(source, output);
    assert.equal(verifyArtifact(output).context, "selected context");
    assert.deepEqual(verifyArtifact(output).audit, { evidence: "paired audit" });
    const before = fs.readFileSync(output);
    const auditFile = safeCheckpointPath(source, auditRel);
    for (const invalid of ["{", "null", "[]"]) {
      fs.writeFileSync(auditFile, invalid);
      assert.throws(() => exportArtifact(source, output));
      assert.deepEqual(fs.readFileSync(output), before);
    }
    fs.unlinkSync(auditFile);
    fs.symlinkSync(output, auditFile);
    assert.throws(() => exportArtifact(source, output), /symlinked audit checkpoint/);
    assert.deepEqual(fs.readFileSync(output), before);
    fs.unlinkSync(auditFile);
    fs.writeFileSync(auditFile, JSON.stringify({ evidence: "paired audit" }));
    const open = fs.openSync;
    let disappeared = false;
    fs.openSync = (file, ...args) => {
      if (file === auditFile && !disappeared) {
        disappeared = true;
        fs.unlinkSync(auditFile);
      }
      return open(file, ...args);
    };
    try {
      assert.throws(() => exportArtifact(source, output), /evidence that changed during reading/);
      assert.equal(disappeared, true);
      assert.deepEqual(fs.readFileSync(output), before, "an audit lost during read must not replace an existing export with incomplete evidence");
    } finally { fs.openSync = open; }
  } finally { fs.rmSync(source, { recursive: true, force: true }); }
});

test("checkpoint-stage import crashes recover verified orphans but preserve modified files", () => {
  for (const [suffix, mode] of [["-full.md", "complete"], ["-claude-to-claude.md", "complete"],
    ["-full.md", "modified"], ["-full.md", "partial"], ["-claude-to-claude.md", "unlink-failure"]]) {
    const source = project(), target = project(), home = project();
    const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
    process.env.CONTEXT_BRIDGE_HOME = home;
    delete process.env.CONTEXT_BRIDGE_STORAGE;
    try {
      ensureState(source);
      ensureState(target);
      writeCheckpoint(source, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", "orphan recovery evidence");
      const artifact = path.join(source, "context.cbctx");
      exportArtifact(source, artifact);
      const before = fs.readFileSync(statePath(target), "utf8");
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import fs from 'node:fs';
        import { importArtifact } from ${JSON.stringify(new URL("../src/artifact.mjs", import.meta.url).href)};
        import { publication } from ${JSON.stringify(new URL("../src/publication.mjs", import.meta.url).href)};
        const publish = publication.renameExclusive;
        publication.renameExclusive = function(temp, file) {
          publish(temp, file);
          if (file.endsWith(${JSON.stringify(suffix)})) {
            // Retain the legacy partial-file recovery case even though new
            // publication no longer exposes a partially written destination.
            if (${JSON.stringify(mode)} === 'partial') fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 5));
            process.exit(79);
          }
        };
        importArtifact(${JSON.stringify(artifact)}, { projectDir: ${JSON.stringify(target)}, apply: true });
      `], { encoding: "utf8", env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "" } });
      assert.equal(child.status, 79, child.stderr);
      assert.equal(fs.readFileSync(statePath(target), "utf8"), before);
      const dir = checkpointsDir(target);
      const orphanNames = fs.readdirSync(dir);
      assert.equal(orphanNames.length, suffix === "-full.md" ? 1 : 2);
      if (mode === "modified") fs.writeFileSync(path.join(dir, orphanNames[0]), "user modification must survive");
      for (const name of fs.readdirSync(path.join(home, "imports"))) {
        if (name.endsWith(".lock")) fs.utimesSync(path.join(home, "imports", name), new Date(0), new Date(0));
      }
      if (mode === "unlink-failure") {
        const unlink = fs.unlinkSync;
        let checkpointUnlinks = 0;
        fs.unlinkSync = (file) => {
          if (path.dirname(file) === dir && ++checkpointUnlinks === 2) {
            const error = new Error("injected checkpoint unlink failure");
            error.code = "EACCES";
            throw error;
          }
          return unlink(file);
        };
        try {
          assert.throws(() => importArtifact(artifact, { projectDir: target, apply: true }), /injected checkpoint unlink failure/);
        } finally { fs.unlinkSync = unlink; }
        assert.equal(checkpointUnlinks, 2);
        assert.equal(fs.readdirSync(dir).length, 1);
        assert.equal(fs.readFileSync(statePath(target), "utf8"), before);
        assert.ok(fs.readdirSync(path.join(home, "imports")).some((name) => name.endsWith(".pending.json")));
      }
      if (mode === "modified" || mode === "partial") {
        assert.throws(() => importArtifact(artifact, { projectDir: target, apply: true }), /checkpoint changed/);
        assert.equal(fs.readFileSync(path.join(dir, orphanNames[0]), "utf8"), mode === "modified" ? "user modification must survive" : "orpha");
        assert.equal(fs.readFileSync(statePath(target), "utf8"), before);
        assert.ok(fs.readdirSync(path.join(home, "imports")).some((name) => name.endsWith(".pending.json")));
      } else {
        assert.equal(importArtifact(artifact, { projectDir: target, apply: true }).applied, true);
        for (const name of orphanNames) assert.equal(fs.existsSync(path.join(dir, name)), false);
        assert.equal(fs.readdirSync(dir).length, 2);
        assert.deepEqual(fs.readdirSync(path.join(home, "imports")), []);
      }
    } finally {
      if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
      if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
      for (const dir of [source, target, home]) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

for (const failure of ["exit", "throw", ...(process.platform === "win32" ? [] : ["directory-sync"])]) test(`${failure} after seed commit preserves evidence and cannot apply a consumed artifact twice`, () => {
  const source = project();
  const target = project();
  const home = project();
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    ensureState(source);
    ensureState(target);
    writeCheckpoint(source, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", "portable evidence");
    const file = path.join(source, "context.cbctx");
    exportArtifact(source, file);
    const hash = verifyArtifact(file).integrity.payload;
    const stateFile = statePath(target);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';
      import { importArtifact } from ${JSON.stringify(new URL("../src/artifact.mjs", import.meta.url).href)};
      const rename = fs.renameSync;
      const sync = fs.fsyncSync;
      let triggered = false, statePublished = false;
      fs.fsyncSync = function(fd) {
        if (${JSON.stringify(failure)} === 'directory-sync' && statePublished && !triggered && fs.fstatSync(fd).isDirectory()) {
          triggered = true;
          throw Object.assign(new Error('INJECTED_DIRECTORY_SYNC_FAILURE'), {code:'EIO'});
        }
        return sync.call(fs,fd);
      };
      fs.renameSync = function(from, to) {
        rename.call(fs, from, to);
        if (to === ${JSON.stringify(stateFile)} && !triggered) {
          statePublished = true;
          if (${JSON.stringify(failure)} === 'directory-sync') return;
          triggered = true;
          if (${JSON.stringify(failure)} === 'exit') process.exit(79);
          throw new Error('INJECTED_AFTER_STATE_PUBLICATION');
        }
      };
      try { importArtifact(${JSON.stringify(file)}, { projectDir: ${JSON.stringify(target)}, apply: true }); }
      catch (error) {
        if (!error.message.includes('INJECTED_AFTER_STATE_PUBLICATION') && error.code !== 'BRIDGE_PUBLICATION_UNCERTAIN') throw error;
        process.exit(78);
      }
    `], { env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "" }, encoding: "utf8" });
    assert.equal(child.status, failure === "exit" ? 79 : 78, child.stderr);
    const committed = loadState(target);
    assert.ok(committed.pendingInjection, "an error after publication must not undo the committed seed");
    assert.equal(committed.pendingInjection.artifactHash, hash);
    assert.equal(committed.lanes.main.artifactImports[hash].deltaRel, committed.pendingInjection.deltaFile);
    for (const rel of [committed.lanes.main.artifactImports[hash].fullRel, committed.pendingInjection.deltaFile]) {
      assert.equal(fs.readFileSync(safeCheckpointPath(target, rel), "utf8"), "portable evidence");
    }
    // Simulate the independent consumer before the importer ever resumes.
    mutateState(target, "main", (s) => { s.pendingInjection = null; });
    for (const name of fs.readdirSync(path.join(home, "imports"))) {
      if (name.endsWith(".lock")) fs.utimesSync(path.join(home, "imports", name), new Date(0), new Date(0));
    }
    const before = fs.readFileSync(stateFile, "utf8");
    const files = fs.readdirSync(checkpointsDir(target));
    const repeated = importArtifact(file, { projectDir: target, apply: true });
    assert.equal(repeated.alreadyApplied, true);
    assert.equal(loadState(target).pendingInjection, null);
    assert.equal(fs.readFileSync(stateFile, "utf8"), before);
    assert.deepEqual(fs.readdirSync(checkpointsDir(target)), files);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    for (const dir of [source, target, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact export refuses linked checkpoints instead of exporting outside files", () => {
  const source = project();
  const outside = project();
  try {
    ensureState(source);
    const evidence = path.join(outside, "private.md");
    fs.writeFileSync(evidence, "private external evidence");
    fs.symlinkSync(evidence, path.join(checkpointsDir(source), "2026-09-16T00-00-00-000Z-claude-to-codex-full.md"));
    const destination = path.join(source, "export.cbctx");
    assert.throws(() => exportArtifact(source, destination), /symlinked full context/);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.readFileSync(evidence, "utf8"), "private external evidence");
    const checkpoint = path.join(checkpointsDir(source), "2026-09-16T00-00-00-000Z-claude-to-codex-full.md");
    fs.unlinkSync(checkpoint);
    fs.linkSync(evidence, checkpoint);
    assert.throws(() => exportArtifact(source, destination), /unsafe.*full context/i);
    assert.equal(fs.existsSync(destination), false, "hardlinked private data must not become a portable artifact");
    assert.equal(fs.readFileSync(evidence, "utf8"), "private external evidence");
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("artifact audit redaction preserves structure and does not modify local evidence", () => {
  const source = project();
  ensureState(source);
  const stem = "2026-09-16T00-00-00-000Z-claude-to-codex";
  writeCheckpoint(source, "main", `${stem}-full.md`, "briefing");
  const original = { agents: { claude: { commands: [{ command: "run token=command-secret", ok: true, exitCode: 0 }], credentials: { access_token: "structured-secret" } } } };
  const rel = writeManifest(source, "main", stem, original);
  const file = path.join(source, "context.cbctx");
  exportArtifact(source, file);
  const artifact = verifyArtifact(file);
  assert.equal(artifact.audit.agents.claude.commands[0].command, "run token=<redacted>");
  assert.equal(artifact.audit.agents.claude.commands[0].exitCode, 0);
  assert.equal(artifact.audit.agents.claude.credentials.access_token, "<redacted>");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /command-secret|structured-secret/);
  assert.deepEqual(JSON.parse(fs.readFileSync(safeCheckpointPath(source, rel), "utf8")), original);
});

test("a correctly hashed malformed artifact is rejected before target initialization", () => {
  const source = project();
  const target = project();
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-schema-"));
  process.env.CONTEXT_BRIDGE_HOME = runtimeHome;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    ensureState(source);
    writeCheckpoint(source, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", "briefing");
    const file = path.join(source, "context.cbctx");
    exportArtifact(source, file);
    const valid = verifyArtifact(file);
    const registryBefore = fs.readFileSync(path.join(runtimeHome, "projects.json"), "utf8");
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    for (const patch of [{ context: 42 }, { summary: null }, { lane: "../escape" }, { project: [] },
      { source: { ...valid.source, bridgeVersion: 5 } }, { source: { ...valid.source, stateVersion: "0.12.4" } },
      { source: { nativeSessionsIncluded: true, portableContextOnly: true } }]) {
      const { integrity, ...payload } = { ...valid, ...patch };
      const hash = crypto.createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
      fs.writeFileSync(file, JSON.stringify({ ...payload, integrity: { algorithm: "sha256", payload: hash } }));
      assert.throws(() => importArtifact(file, { projectDir: target, apply: true }), /Invalid context artifact schema/);
      assert.equal(fs.readFileSync(path.join(runtimeHome, "projects.json"), "utf8"), registryBefore);
      assert.equal(loadState(target), null);
      assert.deepEqual(fs.readdirSync(target), []);
      assert.equal(fs.existsSync(path.join(runtimeHome, "imports")), false);
    }
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
  }
});

test("artifact export redacts sensitive values and verifies its hash", () => {
  const dir = project();
  ensureState(dir);
  writeCheckpoint(dir, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", composeFullContext({
    fromAgent: "claude", summary: "useful summary", decisions: ["Use global storage."],
    next: ["Verify migration."], work: [], conversation: [{ role: "user", text:
      "useful context\ntoken=secret-value\nBearer abc123\n/Users/serdar/private.log" }],
  }));
  const file = path.join(os.tmpdir(), `context-${process.pid}.cbctx`);
  const result = exportArtifact(dir, file);
  const artifact = verifyArtifact(file);
  assert.equal(result.hash, artifact.integrity.payload);
  assert.equal(artifact.source.bridgeVersion, JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.equal(artifact.source.stateVersion, loadState(dir).version);
  assert.doesNotMatch(artifact.context, /secret-value|Bearer abc123|\/Users\/serdar\/private\.log/);
  assert.match(artifact.context, /useful context/);
  assert.equal(artifact.summary, "useful summary");
  assert.match(artifact.decisions, /Use global storage/);
  assert.match(artifact.next, /Verify migration/);
  fs.rmSync(file, { force: true });
});

test("artifact import verifies before applying and is idempotent", () => {
  const source = project();
  const target = project();
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-artifact-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  try {
    ensureState(source);
    writeCheckpoint(source, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", "portable briefing");
    const file = path.join(os.tmpdir(), `context-import-${process.pid}.cbctx`);
    exportArtifact(source, file);
    const first = importArtifact(file, { projectDir: target, apply: true });
    const second = importArtifact(file, { projectDir: target, apply: true });
    assert.equal(first.applied, true);
    assert.equal(second.alreadyApplied, true);
    fs.rmSync(file, { force: true });
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
  }
});

test("the same artifact can be applied once per target project and lane", () => {
  const source = project();
  const firstTarget = project();
  const secondTarget = project();
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-artifact-target-home-"));
  process.env.CONTEXT_BRIDGE_HOME = home;
  try {
    ensureState(source);
    writeCheckpoint(source, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", "shared portable briefing");
    const file = path.join(os.tmpdir(), `context-targets-${process.pid}.cbctx`);
    exportArtifact(source, file);
    assert.equal(importArtifact(file, { projectDir: firstTarget, apply: true }).applied, true);
    assert.equal(importArtifact(file, { projectDir: secondTarget, apply: true }).applied, true);
    fs.rmSync(file, { force: true });
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
  }
});

test("tampered artifact is rejected before import", () => {
  const dir = project();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-artifact-tamper-home-"));
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  process.env.CONTEXT_BRIDGE_HOME = home;
  try {
    ensureState(dir);
    writeCheckpoint(dir, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", "integrity matters");
    const file = path.join(os.tmpdir(), `context-tamper-${process.pid}.cbctx`);
    exportArtifact(dir, file);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.context = "tampered";
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.throws(() => importArtifact(file), /integrity check failed/);
    fs.rmSync(file, { force: true });
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
  }
});

test("artifact import preserves an already requested outgoing handoff", () => {
  const source = project();
  const target = project();
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  process.env.CONTEXT_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-import-pending-"));
  try {
    ensureState(source);
    ensureState(target);
    writeCheckpoint(source, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", "briefing");
    const file = path.join(source, "context.cbctx");
    exportArtifact(source, file);
    mutateState(target, "main", (state) => { state.pendingHandoff = { target: "codex", ready: true }; });
    const before = fs.readFileSync(statePath(target), "utf8");
    assert.throws(() => importArtifact(file, { projectDir: target, apply: true }), /already has a pending handoff/);
    assert.equal(fs.readFileSync(statePath(target), "utf8"), before);
    assert.deepEqual(fs.readdirSync(checkpointsDir(target)), []);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
  }
});

test("different artifacts racing for one production lane leave exactly one intact seed", async () => {
  const source = project();
  const target = project();
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-import-race-"));
  process.env.CONTEXT_BRIDGE_HOME = runtimeHome;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    ensureState(source);
    ensureState(target);
    const files = [path.join(source, "a.cbctx"), path.join(source, "b.cbctx")];
    for (let i = 0; i < files.length; i++) {
      writeCheckpoint(source, "main", `2026-09-16T00-00-0${i}-000Z-claude-to-codex-full.md`, `briefing ${i}`);
      exportArtifact(source, files[i]);
    }
    const moduleUrl = new URL("../src/artifact.mjs", import.meta.url).href;
    const children = files.map((file) => {
      const script = `
        import { importArtifact } from ${JSON.stringify(moduleUrl)};
        process.send('ready');
        process.once('message', () => {
          try {
            importArtifact(${JSON.stringify(file)}, {projectDir: ${JSON.stringify(target)}, apply: true});
            process.exit(0);
          } catch (error) { console.error(error.message); process.exit(1); }
        });`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; });
      const ready = new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
      const done = new Promise((resolve, reject) => { child.once("close", (code) => resolve({ code, stderr })); child.once("error", reject); });
      return { child, ready, done };
    });
    await Promise.all(children.map((item) => item.ready));
    for (const item of children) item.child.send("start");
    const results = await Promise.all(children.map((item) => item.done));
    assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
    assert.match(results.find((result) => result.code === 1).stderr, /already has a pending handoff/);
    const pending = loadState(target).pendingInjection;
    const accepted = files.map((file) => verifyArtifact(file)).find((artifact) => artifact.integrity.payload === pending.artifactHash);
    assert.ok(accepted);
    assert.equal(fs.readFileSync(safeCheckpointPath(target, pending.deltaFile), "utf8"), accepted.context);
    assert.equal(fs.readdirSync(checkpointsDir(target)).length, 2);
    assert.equal(fs.readdirSync(path.join(runtimeHome, "imports")).length, 0, "new receipts commit with state, not in a second file");
    assert.deepEqual(Object.keys(loadState(target).lanes.main.artifactImports), [pending.artifactHash]);
    assert.equal(fs.existsSync(path.join(target, ".bridge")), false);
  } finally {
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE;
    else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
  }
});

test("a handoff arriving after the import snapshot is preserved under the state lock", () => {
  const source = project();
  const target = project();
  const oldHome = process.env.CONTEXT_BRIDGE_HOME;
  const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-import-stale-"));
  process.env.CONTEXT_BRIDGE_HOME = runtimeHome;
  const exists = fs.existsSync;
  let injected = false;
  let savedState;
  try {
    ensureState(source);
    ensureState(target);
    writeCheckpoint(source, "main", "2026-09-16T00-00-00-000Z-claude-to-codex-full.md", "briefing");
    const file = path.join(source, "context.cbctx");
    exportArtifact(source, file);
    // Receipt lookup follows the initial state read. Inject a competing writer
    // at that boundary so only the check under the state lock can catch it.
    fs.existsSync = (candidate) => {
      if (!injected && typeof candidate === "string" && path.dirname(candidate) === path.join(runtimeHome, "imports") && candidate.endsWith(".json") && !candidate.endsWith(".pending.json")) {
        injected = true;
        mutateState(target, "main", (state) => { state.pendingHandoff = { target: "codex", ready: true }; });
        savedState = fs.readFileSync(statePath(target), "utf8");
      }
      return exists(candidate);
    };
    assert.throws(() => importArtifact(file, { projectDir: target, apply: true }), /already has a pending handoff/);
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(statePath(target), "utf8"), savedState);
    assert.deepEqual(fs.readdirSync(checkpointsDir(target)), []);
  } finally {
    fs.existsSync = exists;
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME;
    else process.env.CONTEXT_BRIDGE_HOME = oldHome;
  }
});
