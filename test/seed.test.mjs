import test from "node:test";
import { ensureRuntimeStore } from "../src/storage.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { seedLane, prepareSeed, writeSeed, bindSeed, unbindSeed, composeSeed, sectionBody, seedBinding } from "../src/seed.mjs";
import { fullContextFor } from "../src/delivery.mjs";
import { composeFullContext } from "../src/delta.mjs";
import { loadState, statePath, bridgeDir, checkpointsDir, safeCheckpointPath, emptyLane, STATE_VERSION } from "../src/state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(ROOT, "bin", "bridge.mjs");

const FULL = composeFullContext({ fromAgent: "claude", summary: "did the thing",
  conversation: [{ role: "assistant", at: "2026-08-04T00:00:00.000Z",
    text: "a long chat that must not cross into the seed\n## Decisions\nCONVERSATION_NOT_A_DECISION\n## Next\nCONVERSATION_NOT_A_NEXT_STEP" }],
  decisions: ["use mutateProject", "reject bad names"], work: ["uncommitted: M src/x.mjs"], next: ["finish the seed"],
});

test("sectionBody extracts a section and treats the empty placeholder as nothing", () => {
  assert.equal(sectionBody(FULL, "Decisions"), "- use mutateProject\n- reject bad names");
  assert.equal(sectionBody(FULL, "Next"), "- finish the seed");
  assert.equal(sectionBody(FULL, "Nope"), "", "an absent section is empty");
  assert.equal(sectionBody(composeFullContext({ decisions: [], next: [], work: [] }), "Decisions"), "", "the placeholder is not copied forward");
  assert.throws(() => sectionBody("## Decisions\nlegacy ambiguous content", "Decisions"), /index/i);
  assert.throws(() => sectionBody(FULL.replace("reject bad names", "reject bad dates"), "Decisions"), /index/i);
});

test("composeSeed carries decisions, next, git and files but never the conversation", () => {
  const doc = composeSeed("main", {
    decisions: "- a\n- b",
    next: "- c",
    gitLines: ["uncommitted: M src/x.mjs"],
    files: { changed: ["src/x.mjs"], read: ["src/y.mjs"] },
  });
  assert.match(doc, /Seeded from lane "main"/);
  assert.match(doc, /- a\n- b/, "decisions cross");
  assert.match(doc, /- c/, "next crosses");
  assert.match(doc, /uncommitted: M src\/x\.mjs/, "git work crosses");
  assert.match(doc, /src\/x\.mjs/, "touched files cross");
  assert.doesNotMatch(doc, /## Conversation/, "no conversation section");
  assert.match(doc, /briefing, not a transcript/, "it says plainly it is not a transcript");
});

test("seedLane writes a seed doc without the conversation and leaves an unbound seed injection", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-seed-")));
  ensureRuntimeStore(project);
  fs.mkdirSync(checkpointsDir(project), { recursive: true });
  // main is the source lane (flat checkpoints); it has a full-context checkpoint.
  fs.writeFileSync(path.join(checkpointsDir(project), "2026-08-04T00-00-00-000Z-claude-to-codex-full.md"), FULL);
  const main = emptyLane();
  main.activeAgent = "claude";
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "target", lanes: { main, target: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );

  const rep = seedLane(project, "target", "main");
  assert.equal(rep.decisions, true);
  assert.equal(rep.next, true);

  const s = loadState(project);
  const inj = s.lanes.target.pendingInjection;
  assert.equal(inj.seed, true, "the injection is an unbound seed");
  assert.equal(inj.agent, null, "no agent is bound yet");
  assert.equal(inj.id, null, "it seeds the first session, resuming nothing");
  assert.equal(inj.deltaFile, rep.deltaRel);

  const doc = fs.readFileSync(safeCheckpointPath(project, rep.deltaRel), "utf8");
  assert.match(doc, /- use mutateProject/, "decisions crossed into the seed");
  assert.match(doc, /- finish the seed/, "next crossed");
  assert.doesNotMatch(doc, /a long chat that must not cross/, "the conversation did NOT cross");
  assert.doesNotMatch(doc, /CONVERSATION_NOT_A_/, "conversation headings are never seed fields");

  fs.rmSync(project, { recursive: true });
});

test("seedBinding binds an unbound seed to the opening agent and ignores everything else", () => {
  assert.deepEqual(seedBinding({ seed: true, agent: null }, "codex", true), { agent: "codex", via: "hook" });
  assert.deepEqual(seedBinding({ seed: true, agent: null }, "grok", false), { agent: "grok", via: "prompt" });
  assert.equal(seedBinding({ seed: true, agent: "codex" }, "claude", true), null, "an already-bound seed is left alone");
  assert.equal(seedBinding({ agent: null }, "claude", true), null, "a normal injection is not a seed");
  assert.equal(seedBinding(null, "claude", true), null);
});

test("bridge lane new --seed validates the source before creating anything", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-seedcli-")));
  ensureRuntimeStore(project);
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );
  const run = (...a) => spawnSync(process.execPath, [BRIDGE, "lane", ...a], { cwd: project, encoding: "utf8" });

  assert.equal(run("new", "x", "--seed").status, 1, "--seed with no source is an error");
  assert.equal(run("new", "x", "--seed", "ghost").status, 1, "a missing source is an error");
  assert.equal(run("new", "x", "--seed", "x").status, 1, "a lane cannot seed from itself");
  assert.equal(loadState(project).lanes.x, undefined, "and no half-made lane is left behind");

  const before = fs.readFileSync(statePath(project));
  fs.mkdirSync(checkpointsDir(project), { recursive: true });
  const secret = path.join(project, "private-context.txt");
  fs.writeFileSync(secret, "## Decisions\nPRIVATE_OUTSIDE_EVIDENCE\n");
  const full = path.join(checkpointsDir(project), "2026-09-17T00-00-00-000Z-claude-to-codex-full.md");
  const audit = path.join(checkpointsDir(project), "2026-09-17T00-00-00-000Z-claude-to-codex-audit.json");
  for (const mode of ["symlink", "hardlink", "directory", "invalid-audit", "legacy-headings", "invalid-index", "link-during-read", "rewrite-during-read"]) {
    if (mode === "symlink") fs.symlinkSync(secret, full);
    else if (mode === "hardlink") fs.linkSync(secret, full);
    else if (mode === "directory") fs.mkdirSync(full);
    else if (mode === "legacy-headings") fs.writeFileSync(full, "## Conversation\n## Decisions\nPRIVATE_OUTSIDE_EVIDENCE\n");
    else if (mode === "invalid-index") fs.writeFileSync(full, FULL.replace("reject bad names", "reject bad dates"));
    else { fs.writeFileSync(full, FULL); if (mode === "invalid-audit") fs.writeFileSync(audit, "{broken"); }
    fs.utimesSync(full, new Date("2020-01-01"), new Date("2020-01-01"));
    const linked = path.join(project, "concurrent-link");
    const refused = mode.endsWith("during-read") ? spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';
      const file = ${JSON.stringify(full)}, stat = fs.statSync(file), read = fs.readFileSync;
      let changed = false;
      fs.readFileSync = (fd, ...args) => {
        const bytes = read(fd, ...args);
        if (!changed && typeof fd === 'number' && fs.fstatSync(fd).ino === stat.ino) {
          changed = true;
          if (${JSON.stringify(mode)} === 'link-during-read') fs.linkSync(file, ${JSON.stringify(linked)});
          else { fs.writeFileSync(file, Buffer.alloc(stat.size, 120)); fs.utimesSync(file, stat.atime, stat.mtime); }
        }
        return bytes;
      };
      process.argv = [process.execPath, ${JSON.stringify(BRIDGE)}, 'lane', 'new', 'x', '--seed', 'main'];
      await import(${JSON.stringify(new URL("../bin/bridge.mjs", import.meta.url).href)});
    `], { cwd: project, encoding: "utf8" }) : run("new", "x", "--seed", "main");
    assert.equal(refused.status, 1, `${mode} must not become starter context`);
    assert.doesNotMatch(refused.stdout + refused.stderr, /PRIVATE_OUTSIDE_EVIDENCE/);
    assert.deepEqual(fs.readFileSync(statePath(project)), before);
    assert.equal(fs.existsSync(path.join(bridgeDir(project), "lanes", "x")), false);
    fs.rmSync(full, { recursive: mode === "directory" });
    fs.rmSync(audit, { force: true });
    fs.rmSync(linked, { force: true });
  }

  fs.writeFileSync(full, FULL);
  const ok = run("new", "feature", "--seed", "main");
  assert.equal(ok.status, 0, "seeding from an existing lane works");
  assert.ok(loadState(project).lanes.feature.pendingInjection?.seed, "feature carries an unbound seed");
  const deliveredSeed = fs.readFileSync(safeCheckpointPath(project, loadState(project).lanes.feature.pendingInjection.deltaFile), "utf8");
  assert.match(deliveredSeed, /use mutateProject/);
  assert.doesNotMatch(deliveredSeed, /CONVERSATION_NOT_A_/);

  fs.rmSync(project, { recursive: true });
});

// A source project with a full-context checkpoint in main's flat checkpoints, plus
// an empty target lane ready to receive a seed.
function seededProject() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-seedfix-")));
  ensureRuntimeStore(project);
  fs.mkdirSync(checkpointsDir(project), { recursive: true });
  fs.writeFileSync(path.join(checkpointsDir(project), "2026-08-04T00-00-00-000Z-claude-to-codex-full.md"), FULL);
  const main = emptyLane();
  main.activeAgent = "claude";
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "target", lanes: { main, target: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );
  return project;
}

test("bindSeed gives the seed to the first opener and refuses a second racer", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-bind-")));
  ensureRuntimeStore(project);
  const target = emptyLane();
  target.pendingInjection = { seed: true, agent: null, via: null, id: null, deltaFile: ".bridge/lanes/target/checkpoints/x.md", createdAt: "x" };
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "target", lanes: { target }, launcher: null, updatedAt: null }, null, 2)
  );

  assert.equal(bindSeed(project, "target", "codex", true), true, "the first opener wins the seed");
  const s1 = loadState(project);
  assert.equal(s1.lanes.target.pendingInjection.agent, "codex");
  assert.equal(s1.lanes.target.pendingInjection.via, "hook");
  assert.equal(s1.lanes.target.pendingInjection.seed, undefined, "it is no longer unbound");

  assert.equal(bindSeed(project, "target", "claude", true), false, "the second opener does not steal it");
  assert.equal(loadState(project).lanes.target.pendingInjection.agent, "codex", "the seed stayed with the first opener");

  fs.rmSync(project, { recursive: true });
});

test("writeSeed writes the seed as both a delta and a full-context checkpoint, so an oversized one can be trimmed", () => {
  const project = seededProject();
  const prepared = prepareSeed(project, "main");
  const stopped = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { publication } from ${JSON.stringify(new URL("../src/publication.mjs", import.meta.url).href)};
    import { writeSeed } from ${JSON.stringify(new URL("../src/seed.mjs", import.meta.url).href)};
    const publish = publication.renameExclusive;
    publication.renameExclusive = (from, to) => {
      publish(from, to);
      if (to.endsWith('-full.md')) process.exit(79);
    };
    writeSeed(${JSON.stringify(project)}, 'target', ${JSON.stringify(prepared)});
  `], { env: process.env, encoding: "utf8", timeout: 10000 });
  assert.equal(stopped.status, 79, stopped.stderr);
  assert.equal(loadState(project).lanes.target.pendingInjection, null);
  const deltaRel = writeSeed(project, "target", prepared);
  const fullRel = deltaRel.replace(/\.md$/, "-full.md");

  assert.ok(fs.existsSync(safeCheckpointPath(project, fullRel)), "the full-context checkpoint was written beside the delta");
  assert.equal(path.resolve(project, fullContextFor(project, deltaRel)), safeCheckpointPath(project, fullRel), "delivery can point a road-trimmed seed at the full one");

  const before = fs.readFileSync(statePath(project));
  const dir = path.dirname(safeCheckpointPath(project, deltaRel));
  const files = fs.readdirSync(dir).sort();
  assert.throws(() => writeSeed(project, "target", { ...prepared, stem: prepared.stem.replace(/Z-/, "Z-retry-") }),
    /pending|occupied|empty/, "preparing a seed does not authorize replacing a later pending delivery");
  assert.deepEqual(fs.readFileSync(statePath(project)), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), files);

  fs.rmSync(project, { recursive: true });
});

test("lane new --seed rolls the lane back if the seed write fails", () => {
  const project = seededProject();
  // Sabotage: make .bridge/lanes/x a FILE so writeCheckpoint's mkdir fails after the
  // lane is created in state.
  fs.mkdirSync(path.join(bridgeDir(project), "lanes"), { recursive: true });
  fs.writeFileSync(path.join(bridgeDir(project), "lanes", "x"), "not a directory");

  const res = spawnSync(process.execPath, [BRIDGE, "lane", "new", "x", "--seed", "main"], { cwd: project, encoding: "utf8" });
  assert.equal(res.status, 1, "the seed write failed");
  assert.match(res.stdout, /rolled back/);
  assert.equal(loadState(project).lanes.x, undefined, "no half-made lane survives in state");
  assert.equal(loadState(project).activeLane, "main", "the active lane was moved off the rolled-back one");
  assert.equal(fs.readFileSync(path.join(bridgeDir(project), "lanes", "x"), "utf8"), "not a directory", "rollback must not delete files it did not create");

  const refused = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import { main } from ${JSON.stringify(new URL("../src/cli.mjs", import.meta.url).href)};
    const rename = fs.renameSync;
    let writes = 0;
    fs.renameSync = (from, to) => {
      if (to === ${JSON.stringify(statePath(project))} && ++writes === 2) {
        throw Object.assign(new Error('rollback state write denied'), {code: 'EACCES'});
      }
      return rename(from, to);
    };
    await main(['lane', 'new', 'x', '--seed', 'main']);
  `], { cwd: project, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /automatic rollback could not be completed/);
  assert.ok(loadState(project).lanes.x, "failed state rollback leaves the record available for recovery");
  assert.equal(fs.readFileSync(path.join(bridgeDir(project), "lanes", "x"), "utf8"), "not a directory");

  fs.rmSync(project, { recursive: true });
});

const SEED_MODULE = fileURLToPath(new URL("../src/seed.mjs", import.meta.url));

test("bindSeed under real concurrency gives the seed to exactly one racer", async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-seedrace-")));
  ensureRuntimeStore(project);
  const target = emptyLane();
  target.pendingInjection = { seed: true, agent: null, via: null, id: null, deltaFile: ".bridge/lanes/target/checkpoints/x.md", createdAt: "x" };
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "target", lanes: { target }, launcher: null, updatedAt: null }, null, 2)
  );

  // Five agents open the one seeded lane at the same instant, each in its own
  // process. The state lock must let exactly one bind the seed; the rest lose.
  const agents = ["claude", "codex", "grok", "antigravity", "opencode"];
  const race = (agent) =>
    new Promise((resolve) => {
      const code = `import(${JSON.stringify(SEED_MODULE)}).then(({ bindSeed }) => { process.stdout.write(String(bindSeed(${JSON.stringify(project)}, "target", ${JSON.stringify(agent)}, true))); });`;
      let out = "", stderr = "";
      const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (stderr += d));
      c.on("close", (status) => resolve({ status, stderr, output: out.trim() }));
    });

  const results = await Promise.all(agents.map(race));
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(["true", "false"].includes(result.output), "every racer returns a binding result");
  }
  const winners = results.filter((result) => result.output === "true").length;
  assert.equal(winners, 1, "exactly one racer bound the seed, the rest lost");

  const inj = loadState(project).lanes.target.pendingInjection;
  assert.equal(inj.seed, undefined, "the seed is now bound, not left unbound");
  assert.ok(agents.includes(inj.agent), "and bound to one of the racers");
});

test("unbindSeed hands a seed back after a failed launch, so another agent can take it", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-unbind-")));
  ensureRuntimeStore(project);
  const target = emptyLane();
  target.pendingInjection = { seed: true, agent: null, via: null, id: null, deltaFile: ".bridge/lanes/target/checkpoints/x.md", createdAt: "x" };
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "target", lanes: { target }, launcher: null, updatedAt: null }, null, 2)
  );

  assert.equal(bindSeed(project, "target", "claude", true), true, "claude wins the seed first");
  // claude never actually started (bad binary): hand the seed back.
  unbindSeed(project, "target", "claude");
  const back = loadState(project).lanes.target.pendingInjection;
  assert.equal(back.seed, true, "the seed is unbound again");
  assert.equal(back.agent, null, "no agent holds it now");

  // A different agent can now become the first successful opener.
  assert.equal(bindSeed(project, "target", "codex", true), true, "another agent takes the recovered seed");
  assert.equal(loadState(project).lanes.target.pendingInjection.agent, "codex");

  // unbindSeed only reverts ITS OWN still-bound seed: unbinding for the wrong agent is a no-op.
  unbindSeed(project, "target", "claude");
  assert.equal(loadState(project).lanes.target.pendingInjection.agent, "codex", "a mismatched unbind leaves the binding alone");

  fs.rmSync(project, { recursive: true });
});
