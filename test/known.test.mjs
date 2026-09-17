import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handoff } from "../src/handoff.mjs";
import { appendFinalWords } from "../src/launcher.mjs";
import { recoverPreparations } from "../src/preparation.mjs";
import { defaultState, saveState, loadState, knownMark, commitKnown, ensureState, bridgeDir, statePath, mutateState, mutateProject, safeCheckpointPath, checkpointsDir } from "../src/state.mjs";

const BRIDGE_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "bridge.mjs");

const GROK_ID = "019f8000-aaaa-7bbb-8ccc-ddddeeee0001";

test("real clean --all cannot delete a handoff paused before its state commit", async () => {
  const { project } = fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-clean-during-handoff-"));
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  let child, done;
  try {
    ensureState(project);
    const before = fs.readFileSync(statePath(project));
    const release = path.join(home, "resume-writer");
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';
      import { handoff } from ${JSON.stringify(new URL("../src/handoff.mjs", import.meta.url).href)};
      const link = fs.linkSync;
      fs.linkSync = (temp, file) => {
        link(temp, file);
        if (file.endsWith('-full.md')) {
          process.send('prepared');
          const deadline = Date.now() + 30000;
          while (!fs.existsSync(${JSON.stringify(release)})) {
            if (Date.now() > deadline) throw new Error('test writer release timed out');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
      };
      handoff(${JSON.stringify(project)}, 'codex', {from: 'grok', summary: 'Complete live preparation', checkTarget: () => {}});
      process.disconnect();
    `], { env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    done = new Promise((resolve) => child.once("close", (code) => resolve(code)));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("writer did not reach preparation")), 15000);
      child.once("message", () => { clearTimeout(timer); resolve(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr || "writer exited before preparation")); });
    });
    const dir = path.join(bridgeDir(project), "checkpoints");
    const prepared = new Map(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name))]));
    const clean = spawnSync(process.execPath, [BRIDGE_BIN, "clean", "--all"], {
      cwd: project, encoding: "utf8", env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "", PATH: "" },
    });
    assert.equal(clean.status, 0, clean.stderr);
    assert.deepEqual(fs.readFileSync(statePath(project)), before);
    for (const [name, content] of prepared) assert.deepEqual(fs.readFileSync(path.join(dir, name)), content);
    fs.writeFileSync(release, "continue");
    assert.equal(await done, 0, stderr);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 3);
    assert.match(fs.readFileSync(path.join(dir, files.find((n) => n.endsWith("-full.md"))), "utf8"), /Complete live preparation/);
    assert.equal(loadState(project).pendingInjection.agent, "codex");
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (done) await done;
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("real handoff process exits recover unchanged evidence and preserve committed or modified groups", () => {
  for (const stage of ["audit", "full", "delta", "state", "modified", "retry"]) {
    const { project } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-handoff-exit-"));
    const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
    process.env.CONTEXT_BRIDGE_HOME = home;
    delete process.env.CONTEXT_BRIDGE_STORAGE;
    try {
      ensureState(project);
      handoff(project, "codex", { from: "grok", summary: "Previously waiting handoff", checkTarget: () => {} });
      const stateFile = statePath(project);
      const before = fs.readFileSync(stateFile);
      const dir = path.join(bridgeDir(project), "checkpoints");
      const previous = new Map(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name))]));
      const suffix = stage === "audit" ? "-audit.json" : ["full", "modified", "retry"].includes(stage) ? "-full.md" : "-grok-to-codex.md";
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import fs from 'node:fs';
        import { handoff } from ${JSON.stringify(new URL("../src/handoff.mjs", import.meta.url).href)};
        const link = fs.linkSync, rename = fs.renameSync;
        fs.linkSync = (temp, file) => {
          link(temp, file);
          if (${JSON.stringify(stage)} !== 'state' && file.endsWith(${JSON.stringify(suffix)})) {
            fs.unlinkSync(temp); process.exit(79);
          }
        };
        fs.renameSync = (from, to) => {
          rename(from, to);
          if (${JSON.stringify(stage)} === 'state' && to === ${JSON.stringify(stateFile)}) process.exit(79);
        };
        handoff(${JSON.stringify(project)}, 'codex', {from: 'grok', summary: 'Interrupted replacement', checkTarget: () => {}});
      `], { encoding: "utf8", env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "" } });
      assert.equal(child.status, 79, child.stderr);
      const journals = fs.readdirSync(dir).filter((name) => name.startsWith(".handoff-"));
      assert.equal(journals.length, 1);
      const afterExit = fs.readFileSync(stateFile);
      if (stage !== "state") assert.deepEqual(afterExit, before);
      if (stage === "retry") {
        handoff(project, "codex", { from: "grok", summary: "Successful retry", checkTarget: () => {} });
        const remaining = fs.readdirSync(dir);
        assert.equal(remaining.length, 3, "real handoff must recover the abandoned preparation before replacing pending work");
        assert.equal(remaining.some((name) => name.startsWith(".handoff-")), false);
        const delta = path.join(dir, path.basename(loadState(project).pendingInjection.deltaFile));
        assert.match(fs.readFileSync(delta, "utf8"), /Successful retry/);
        continue;
      }
      if (stage === "modified") {
        const file = fs.readdirSync(dir).find((name) => name.endsWith("-full.md") && !previous.has(name));
        fs.appendFileSync(path.join(dir, file), "\nuser modification");
        assert.throws(() => recoverPreparations(project, "main"), /evidence changed/);
        assert.equal(fs.existsSync(path.join(dir, journals[0])), true);
        assert.match(fs.readFileSync(path.join(dir, file), "utf8"), /user modification$/);
      } else {
        recoverPreparations(project, "main");
        assert.equal(fs.existsSync(path.join(dir, journals[0])), false);
        assert.equal(fs.readdirSync(dir).length, stage === "state" ? 6 : 3);
        if (stage === "state") {
          const pending = loadState(project).pendingInjection;
          assert.ok(fs.existsSync(path.join(dir, path.basename(pending.deltaFile))));
        }
      }
      assert.deepEqual(fs.readFileSync(stateFile), afterExit, "recovery must not rewrite native session state");
      for (const [name, bytes] of previous) assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes);
    } finally {
      if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
      if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("handoff refuses a stale lane snapshot without overwriting a concurrent writer", () => {
  for (const change of ["update", "remove", "other-lane"]) {
    const { project } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-handoff-race-"));
    const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
    process.env.CONTEXT_BRIDGE_HOME = home;
    delete process.env.CONTEXT_BRIDGE_STORAGE;
    try {
      ensureState(project);
      let concurrentState;
      const run = () => handoff(project, "codex", {
        from: "grok", summary: "Do not overwrite a newer state", checkTarget: () => {
          if (change === "update") {
            mutateState(project, "main", (s) => { s.agents.grok.idle = true; });
          } else {
            mutateProject(project, (s) => {
              s.lanes.other = structuredClone(s.lanes.main);
              s.lanes.other.title = "Independent work";
              if (change === "remove") { delete s.lanes.main; s.activeLane = "other"; }
            });
          }
          concurrentState = fs.readFileSync(statePath(project));
        },
      });
      if (change === "other-lane") {
        run();
        const after = loadState(project);
        assert.equal(after.lanes.other.title, "Independent work");
        assert.equal(after.lanes.main.pendingInjection.agent, "codex");
      } else {
        assert.throws(run, /lane changed while preparing|lane was removed while preparing/);
        assert.deepEqual(fs.readFileSync(statePath(project)), concurrentState);
      }
    } finally {
      if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
      if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("a replacement with the same timestamp preserves the pending handoff byte for byte", () => {
  const { project } = fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-replace-collision-"));
  const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
  const RealDate = globalThis.Date;
  process.env.CONTEXT_BRIDGE_HOME = home;
  delete process.env.CONTEXT_BRIDGE_STORAGE;
  try {
    ensureState(project);
    const instant = RealDate.now();
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [instant])); }
      static now() { return instant; }
    };
    handoff(project, "codex", { from: "grok", summary: "Original content", checkTarget: () => {} });
    const stateFile = statePath(project);
    const beforeState = fs.readFileSync(stateFile);
    const dir = path.join(bridgeDir(project), "checkpoints");
    const snapshot = () => fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name))]);
    const beforeFiles = snapshot();
    assert.equal(beforeFiles.length, 3);
    assert.throws(() => handoff(project, "codex", {
      from: "grok", summary: "Different content must not overwrite the original", checkTarget: () => {},
    }), /timestamp is already pending/);
    assert.deepEqual(fs.readFileSync(stateFile), beforeState);
    assert.deepEqual(snapshot(), beforeFiles);
  } finally {
    globalThis.Date = RealDate;
    if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
    if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("failed replacement writes never delete the previous pending handoff", () => {
  for (const stage of ["full", "delta", "state"]) {
    const { project } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-replace-fault-"));
    const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
    const link = fs.linkSync, rename = fs.renameSync;
    process.env.CONTEXT_BRIDGE_HOME = home;
    delete process.env.CONTEXT_BRIDGE_STORAGE;
    try {
      ensureState(project);
      handoff(project, "codex", { from: "grok", summary: "Original waiting handoff", checkTarget: () => {} });
      const store = bridgeDir(project);
      const stateFile = statePath(project);
      const originalState = fs.readFileSync(stateFile);
      const dir = path.join(store, "checkpoints");
      const originalFiles = new Map(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name))]));
      assert.equal(originalFiles.size, 3);
      let injected = false;
      const fail = () => { injected = true; throw Object.assign(new Error(`injected ${stage} write failure`), { code: "ENOSPC" }); };
      fs.linkSync = (from, file) => {
        if (typeof file === "string" && path.dirname(file) === dir &&
          (stage === "full" && file.endsWith("-full.md") || stage === "delta" && file.endsWith(".md") && !file.endsWith("-full.md"))) fail();
        return link(from, file);
      };
      fs.renameSync = (from, to) => {
        if (stage === "state" && to === stateFile) fail();
        return rename(from, to);
      };
      assert.throws(() => handoff(project, "codex", { from: "grok", summary: "Replacement must not destroy pending work", checkTarget: () => {} }), /injected/);
      assert.equal(injected, true);
      assert.deepEqual(fs.readFileSync(stateFile), originalState);
      assert.deepEqual(fs.readdirSync(dir).sort(), [...originalFiles.keys()].sort(),
        `${stage} failure left evidence from the rejected replacement`);
      for (const [name, bytes] of originalFiles) {
        assert.equal(fs.existsSync(path.join(dir, name)), true, `${stage} failure deleted ${name}`);
        assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes);
      }
    } finally {
      fs.linkSync = link;
      fs.renameSync = rename;
      if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
      if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("preparation cleanup preserves changed evidence and an already committed handoff", () => {
  for (const stage of ["changed", "committed"]) {
    const { project } = fixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cleanup-guard-"));
    const oldHome = process.env.CONTEXT_BRIDGE_HOME, oldMode = process.env.CONTEXT_BRIDGE_STORAGE;
    const rename = fs.renameSync;
    process.env.CONTEXT_BRIDGE_HOME = home;
    delete process.env.CONTEXT_BRIDGE_STORAGE;
    try {
      ensureState(project);
      const file = statePath(project);
      const dir = path.join(bridgeDir(project), "checkpoints");
      let injected = false;
      fs.renameSync = (from, to) => {
        if (to !== file) return rename(from, to);
        injected = true;
        if (stage === "committed") rename(from, to);
        else {
          const full = fs.readdirSync(dir).find((name) => name.endsWith("-full.md"));
          fs.appendFileSync(path.join(dir, full), "\nexternal update");
        }
        throw new Error("injected completion failure");
      };
      assert.throws(() => handoff(project, "codex", {
        from: "grok", summary: "Preserve evidence that may belong to another writer", checkTarget: () => {},
      }), (error) => {
        assert.match(error.message, /injected completion failure/);
        if (stage === "changed") assert.match(error.message, /cleanup could not be verified/);
        return true;
      });
      assert.equal(injected, true);
      assert.equal(fs.readdirSync(dir).length, stage === "changed" ? 4 : 3,
        "unsafe cleanup retains evidence and its recovery journal");
      const after = loadState(project);
      if (stage === "committed") assert.equal(after.pendingInjection.agent, "codex");
      else {
        assert.equal(after.pendingInjection, null);
        const full = fs.readdirSync(dir).find((name) => name.endsWith("-full.md"));
        assert.match(fs.readFileSync(path.join(dir, full), "utf8"), /external update$/);
      }
    } finally {
      fs.renameSync = rename;
      if (oldHome === undefined) delete process.env.CONTEXT_BRIDGE_HOME; else process.env.CONTEXT_BRIDGE_HOME = oldHome;
      if (oldMode === undefined) delete process.env.CONTEXT_BRIDGE_STORAGE; else process.env.CONTEXT_BRIDGE_STORAGE = oldMode;
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("a chain carries what the target missed from EVERY agent, labelled by source", async () => {
  // Claude talks to Grok, Grok works, then Grok hands to Codex. Codex has seen
  // neither, so it must receive both streams, not just Grok's.
  const { project } = fixture();
  const s = loadState(project);
  // Claude spoke, then handed to Grok: Grok knows Claude up to that point.
  s.knownBy = { grok: { claude: "2026-07-20T10:00:00.000Z" } };
  s.activeAgent = "grok";
  saveState(project, s);

  const out = handoff(project, "codex", { from: "grok", checkTarget: () => {} });
  assert.match(out, /including catch-up from Claude Code/);

  const after = loadState(project);
  const delta = fs.readFileSync(safeCheckpointPath(project, after.pendingInjection.deltaFile), "utf8");
  assert.match(delta, /From Claude Code/, "Claude's side must be attributed");
  assert.match(delta, /From Grok/, "Grok's side must be attributed");
  assert.match(delta, /claude decided the architecture/, "what Claude said reaches Codex through Grok");
  assert.match(delta, /grok found the bug/);
});

test("handoff dry-run previews the route without changing state or checkpoints", async () => {
  const { project } = fixture();
  const before = fs.readFileSync(statePath(project), "utf8");
  const checkpoints = checkpointsDir(project);
  const beforeFiles = fs.existsSync(checkpoints) ? fs.readdirSync(checkpoints).sort() : null;
  const out = handoff(project, "codex", { from: "grok", decisions: "inspect", next: "continue", dryRun: true, checkTarget: () => {} });
  assert.match(out, /Dry run: would prepare Grok→Codex/);
  assert.match(out, /No state, checkpoint, pending marker/);
  assert.match(out, /\.md/);
  assert.match(out, /audit/);
  assert.equal(fs.readFileSync(statePath(project), "utf8"), before);
  assert.equal(fs.existsSync(checkpoints), beforeFiles !== null);
  if (beforeFiles) assert.deepEqual(fs.readdirSync(checkpoints).sort(), beforeFiles);
  assert.equal(loadState(project).pendingInjection, null);
});

test("the CLI dry-run flag reaches the read-only handoff path", () => {
  const { project } = fixture();
  const res = spawnSync(process.execPath, [BRIDGE_BIN, "handoff", "codex", "--from", "grok", "--dry-run"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Dry run: would prepare Grok→Codex/);
  assert.doesNotMatch(res.stdout, /Handoff is ready/);
  assert.equal(loadState(project).pendingInjection, null);
});

test("CLI dry-run upgrades legacy state only in memory and leaves storage unregistered", () => {
  const { project } = fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-preview-home-"));
  try {
    const state = loadState(project);
    const file = path.join(project, ".bridge", "state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacy = { ...state.lanes.main, version: 4, project, updatedAt: state.updatedAt };
    fs.writeFileSync(file, JSON.stringify(legacy));
    const before = fs.readFileSync(file);
    const entries = fs.readdirSync(path.dirname(file)).sort();
    const res = spawnSync(process.execPath, [BRIDGE_BIN, "handoff", "codex", "--from", "grok", "--dry-run"], {
      cwd: project, encoding: "utf8",
      env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_HOME: home, PATH: "" },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Dry run: would prepare/);
    assert.deepEqual(fs.readFileSync(file), before, "preview must not persist a schema migration");
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), entries, "preview must not create a migration backup");
    assert.deepEqual(fs.readdirSync(home), [], "preview must not register or migrate legacy storage");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("read-only CLI commands do not persist old-schema upgrades or initialize global storage", () => {
  const { project } = fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-readonly-home-"));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-readonly-export-"));
  try {
    const state = loadState(project);
    const file = path.join(project, ".bridge", "state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state.lanes.main, version: 4, project, updatedAt: state.updatedAt }));
    const snapshot = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => [entry.name, entry.isDirectory() ? snapshot(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), "base64")]);
    const before = snapshot(project);
    for (const args of [["status", "--json"], ["inspect", "--lane", "main"], ["lane"],
      ["clean", "--dry-run", "--lane", "main"], ["search", "architecture", "--json"],
      ["artifact", "export", path.join(output, "context.cbctx")], ["doctor", "--json"]]) {
      const res = spawnSync(process.execPath, [BRIDGE_BIN, ...args], {
        cwd: project, encoding: "utf8", timeout: 30000,
        env: { ...process.env, CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_HOME: home, PATH: "" },
      });
      assert.equal(res.error, undefined, `${args.join(" ")}: ${res.error}`);
      if (args[0] !== "doctor") assert.equal(res.status, 0, res.stderr + res.stdout);
      else assert.ok(JSON.parse(res.stdout).bridge, "doctor must finish diagnostics even without installed binaries");
      assert.deepEqual(snapshot(project), before, `${args.join(" ")} must leave project files untouched`);
      assert.deepEqual(fs.readdirSync(home), [], `${args.join(" ")} must not initialize the registry`);
    }
  } finally {
    for (const dir of [project, home, output]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("what a target already received is not sent to it twice", async () => {
  const { project } = fixture();
  const s = loadState(project);
  s.activeAgent = "grok";
  saveState(project, s);

  handoff(project, "codex", { from: "grok", checkTarget: () => {} });
  // The delta is delivered: the matrix records what it carried.
  const mid = loadState(project);
  commitKnown(mid, mid.pendingInjection);
  mid.pendingInjection = null;
  saveState(project, mid);

  assert.ok(knownMark(mid, "codex", "claude"), "Claude's stream is marked as packed for Codex");
  assert.ok(knownMark(mid, "codex", "grok"), "Grok's stream is marked as packed for Codex");

  const out = handoff(project, "codex", { from: "grok", checkTarget: () => {} });
  const delta = fs.readFileSync(safeCheckpointPath(project, loadState(project).pendingInjection.deltaFile), "utf8");
  assert.doesNotMatch(delta, /claude decided the architecture/, "already-delivered material is not resent");
  assert.doesNotMatch(out, /catch-up/);
});

test("closing words move the packed mark, so they are delivered once and only once", async () => {
  const { project, grokChat } = fixture();
  const s = loadState(project);
  s.activeAgent = "grok";
  saveState(project, s);

  handoff(project, "codex", { from: "grok", checkTarget: () => {} });
  // The turn ends after the handoff, exactly as it does in real use.
  fs.appendFileSync(grokChat, JSON.stringify({ type: "assistant", content: "grok's closing verdict" }) + "\n");
  appendFinalWords(project, loadState(project), "grok");

  const withClosing = loadState(project);
  const delta = fs.readFileSync(safeCheckpointPath(project, withClosing.pendingInjection.deltaFile), "utf8");
  assert.match(delta, /grok's closing verdict/);

  // Deliver, then hand off again: the closing verdict must not come back.
  commitKnown(withClosing, withClosing.pendingInjection);
  withClosing.pendingInjection = null;
  saveState(project, withClosing);
  handoff(project, "codex", { from: "grok", checkTarget: () => {} });
  const second = fs.readFileSync(safeCheckpointPath(project, loadState(project).pendingInjection.deltaFile), "utf8");
  assert.doesNotMatch(second, /grok's closing verdict/, "the matrix moved with the closing words");
});

test("the official import seeds the matrix, so the return does not hand Claude its own words", async () => {
  const { project } = fixture();
  const s = loadState(project);
  s.agents.codex = { id: null, transcriptPath: null, mark: null, idle: false };
  s.activeAgent = "claude";
  saveState(project, s);

  handoff(project, "codex", {
    from: "claude",
    checkTarget: () => {},
    transfer: () => ({ threadId: "imported-thread" }),
  });
  const after = loadState(project);
  assert.ok(knownMark(after, "codex", "claude"), "the imported conversation counts as already seen");
});

/** A project where Claude and Grok have both spoken and Codex has heard nothing. */
function fixture() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-known-")));
  const grokHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-known-grok-")));
  const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-known-codex-")));
  process.env.GROK_HOME = grokHome;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_THREAD_ID;

  const claudeTranscript = path.join(project, "claude.jsonl");
  fs.writeFileSync(
    claudeTranscript,
    [
      { timestamp: "2026-07-20T09:00:00.000Z", type: "user", message: { content: "start the work" } },
      {
        timestamp: "2026-07-20T09:00:01.000Z",
        type: "assistant",
        message: { content: [{ type: "text", text: "claude decided the architecture" }] },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n"
  );

  const grokDir = path.join(grokHome, "sessions", encodeURIComponent(project), GROK_ID);
  fs.mkdirSync(grokDir, { recursive: true });
  fs.writeFileSync(
    path.join(grokDir, "summary.json"),
    JSON.stringify({ info: { id: GROK_ID, cwd: project }, updated_at: "2026-07-20T11:00:00.000Z" })
  );
  const grokChat = path.join(grokDir, "chat_history.jsonl");
  fs.writeFileSync(grokChat, JSON.stringify({ type: "assistant", content: "grok found the bug" }) + "\n");
  fs.writeFileSync(
    path.join(grokDir, "events.jsonl"),
    JSON.stringify({ ts: "2026-07-20T11:00:00.000Z", type: "turn_ended", outcome: "completed" }) + "\n"
  );

  const s = defaultState(project);
  s.agents.claude = { id: "claude-1", transcriptPath: claudeTranscript, mark: null, idle: false };
  s.agents.grok = { id: GROK_ID, transcriptPath: grokChat, mark: null, idle: false };
  s.agents.codex = { id: "codex-1", transcriptPath: path.join(project, "codex.jsonl"), mark: null, idle: false };
  fs.writeFileSync(path.join(project, "codex.jsonl"), "");
  saveState(project, s);
  return { project, grokChat, claudeTranscript };
}

test("a launcher that cannot read the state file says so instead of waiting forever", async () => {
  // Real incident: a launcher started before STATE_VERSION 4 kept polling a v4
  // file, loadState threw on every tick, the catch swallowed it, and a pending
  // handoff simply never fired. Silence was indistinguishable from "nothing to do".
  const { statePath } = await import("../src/state.mjs");
  const { project } = fixture();
  fs.writeFileSync(statePath(project), JSON.stringify({ version: 99, agents: {} }));

  const res = spawnSync(process.execPath, [BRIDGE_BIN, "status"], { cwd: project, encoding: "utf8" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /newer than this bridge understands/);
});

// Flagged by Antigravity and confirmed by Codex. The official Claude→Codex import
// used to return the moment it had seeded the thread, before the loop that
// gathers every other agent ever ran. On a project where Grok or Antigravity had
// also been working, that is often the FIRST switch anyone makes, and their work
// simply never arrived. The import answers for exactly one source; it was being
// treated as if it answered for all of them.
test("the official import still carries what the other agents did", () => {
  const { project } = fixture();
  const s = loadState(project);
  s.agents.codex = { id: null, transcriptPath: null, mark: null, idle: false }; // Codex is fresh
  s.activeAgent = "claude";
  saveState(project, s);

  handoff(project, "codex", {
    from: "claude",
    checkTarget: () => {},
    transfer: () => ({ threadId: "imported-thread" }),
  });

  const after = loadState(project);
  const delta = fs.readFileSync(safeCheckpointPath(project, after.pendingInjection.deltaFile), "utf8");
  assert.match(delta, /grok found the bug/, "Grok's work never reached Codex, which is the whole flag");
  // Recorded as carried, but not yet as known: knownBy is committed on delivery,
  // because the departing agent's closing words are still to come.
  assert.ok(after.pendingInjection.sources.grok, "or the next switch would resend it from the beginning");
});

// The same early return dropped the notes the agent wrote while handing off,
// which is a quieter loss than the missing history and arguably a worse one: the
// decisions are the part a human typed on purpose.
test("the official import still carries the decisions written with it", () => {
  const { project } = fixture();
  const s = loadState(project);
  s.agents.codex = { id: null, transcriptPath: null, mark: null, idle: false };
  s.activeAgent = "claude";
  saveState(project, s);

  handoff(project, "codex", {
    from: "claude",
    checkTarget: () => {},
    transfer: () => ({ threadId: "imported-thread" }),
    decisions: "we chose the adapter contract over per-agent branching",
    next: "review the leak fix",
  });

  const after = loadState(project);
  const delta = fs.readFileSync(safeCheckpointPath(project, after.pendingInjection.deltaFile), "utf8");
  assert.match(delta, /adapter contract over per-agent branching/);
  assert.match(delta, /review the leak fix/);
});

// Claude's own conversation is what the import copied, so it must NOT also ride
// in the delta: that would hand Codex the same history twice on its first read.
test("what the import already delivered is not sent a second time", () => {
  const { project } = fixture();
  const s = loadState(project);
  s.agents.codex = { id: null, transcriptPath: null, mark: null, idle: false };
  s.activeAgent = "claude";
  saveState(project, s);

  handoff(project, "codex", {
    from: "claude",
    checkTarget: () => {},
    transfer: () => ({ threadId: "imported-thread" }),
  });

  const after = loadState(project);
  const delta = fs.readFileSync(safeCheckpointPath(project, after.pendingInjection.deltaFile), "utf8");
  assert.doesNotMatch(delta, /claude decided the architecture/, "the import carried this already");
});
