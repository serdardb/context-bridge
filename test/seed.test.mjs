import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { seedLane, prepareSeed, writeSeed, bindSeed, unbindSeed, composeSeed, sectionBody, seedBinding } from "../src/seed.mjs";
import { fullContextFor } from "../src/delivery.mjs";
import { loadState, statePath, bridgeDir, emptyLane, STATE_VERSION } from "../src/state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(ROOT, "bin", "bridge.mjs");

const FULL = [
  "# Context",
  "## Summary",
  "did the thing",
  "## Conversation",
  "a long chat that must not cross into the seed",
  "## Decisions",
  "- use mutateProject",
  "- reject bad names",
  "## Work",
  "- uncommitted: M src/x.mjs",
  "## Next",
  "- finish the seed",
].join("\n");

test("sectionBody extracts a section and treats the empty placeholder as nothing", () => {
  assert.equal(sectionBody(FULL, "Decisions"), "- use mutateProject\n- reject bad names");
  assert.equal(sectionBody(FULL, "Next"), "- finish the seed");
  assert.equal(sectionBody(FULL, "Nope"), "", "an absent section is empty");
  assert.equal(sectionBody("## Decisions\n\nNo explicit decisions were recorded.", "Decisions"), "", "the placeholder is not copied forward");
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
  fs.mkdirSync(path.join(project, ".bridge", "checkpoints"), { recursive: true });
  // main is the source lane (flat checkpoints); it has a full-context checkpoint.
  fs.writeFileSync(path.join(project, ".bridge", "checkpoints", "2026-08-04T00-00-00-000Z-claude-to-codex-full.md"), FULL);
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

  const doc = fs.readFileSync(path.join(project, rep.deltaRel), "utf8");
  assert.match(doc, /- use mutateProject/, "decisions crossed into the seed");
  assert.match(doc, /- finish the seed/, "next crossed");
  assert.doesNotMatch(doc, /a long chat that must not cross/, "the conversation did NOT cross");

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
  fs.mkdirSync(bridgeDir(project), { recursive: true });
  fs.writeFileSync(
    statePath(project),
    JSON.stringify({ version: STATE_VERSION, project, activeLane: "main", lanes: { main: emptyLane() }, launcher: null, updatedAt: null }, null, 2)
  );
  const run = (...a) => spawnSync(process.execPath, [BRIDGE, "lane", ...a], { cwd: project, encoding: "utf8" });

  assert.equal(run("new", "x", "--seed").status, 1, "--seed with no source is an error");
  assert.equal(run("new", "x", "--seed", "ghost").status, 1, "a missing source is an error");
  assert.equal(run("new", "x", "--seed", "x").status, 1, "a lane cannot seed from itself");
  assert.equal(loadState(project).lanes.x, undefined, "and no half-made lane is left behind");

  const ok = run("new", "feature", "--seed", "main");
  assert.equal(ok.status, 0, "seeding from an existing lane works");
  assert.ok(loadState(project).lanes.feature.pendingInjection?.seed, "feature carries an unbound seed");

  fs.rmSync(project, { recursive: true });
});

// A source project with a full-context checkpoint in main's flat checkpoints, plus
// an empty target lane ready to receive a seed.
function seededProject() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-seedfix-")));
  fs.mkdirSync(path.join(project, ".bridge", "checkpoints"), { recursive: true });
  fs.writeFileSync(path.join(project, ".bridge", "checkpoints", "2026-08-04T00-00-00-000Z-claude-to-codex-full.md"), FULL);
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
  fs.mkdirSync(bridgeDir(project), { recursive: true });
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

test("writeSeed writes the seed as both a delta and a full companion, so an oversized one can be trimmed", () => {
  const project = seededProject();
  const prepared = prepareSeed(project, "main");
  const deltaRel = writeSeed(project, "target", prepared);
  const fullRel = deltaRel.replace(/\.md$/, "-full.md");

  assert.ok(fs.existsSync(path.join(project, fullRel)), "the full companion was written beside the delta");
  assert.equal(fullContextFor(project, deltaRel), fullRel, "delivery can point a road-trimmed seed at the full one");

  fs.rmSync(project, { recursive: true });
});

test("lane new --seed rolls the lane back if the seed write fails", () => {
  const project = seededProject();
  // Sabotage: make .bridge/lanes/x a FILE so writeCheckpoint's mkdir fails after the
  // lane is created in state.
  fs.mkdirSync(path.join(project, ".bridge", "lanes"), { recursive: true });
  fs.writeFileSync(path.join(project, ".bridge", "lanes", "x"), "not a directory");

  const res = spawnSync(process.execPath, [BRIDGE, "lane", "new", "x", "--seed", "main"], { cwd: project, encoding: "utf8" });
  assert.equal(res.status, 1, "the seed write failed");
  assert.match(res.stdout, /rolled back/);
  assert.equal(loadState(project).lanes.x, undefined, "no half-made lane survives in state");
  assert.equal(loadState(project).activeLane, "main", "the active lane was moved off the rolled-back one");

  fs.rmSync(project, { recursive: true });
});

const SEED_MODULE = fileURLToPath(new URL("../src/seed.mjs", import.meta.url));

test("bindSeed under real concurrency gives the seed to exactly one racer", async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-seedrace-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
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
      let out = "";
      const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "ignore"] });
      c.stdout.on("data", (d) => (out += d));
      c.on("exit", () => resolve(out.trim() === "true"));
    });

  const winners = (await Promise.all(agents.map(race))).filter(Boolean).length;
  assert.equal(winners, 1, "exactly one racer bound the seed, the rest lost");

  const inj = loadState(project).lanes.target.pendingInjection;
  assert.equal(inj.seed, undefined, "the seed is now bound, not left unbound");
  assert.ok(agents.includes(inj.agent), "and bound to one of the racers");
});

test("unbindSeed hands a seed back after a failed launch, so another agent can take it", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-unbind-")));
  fs.mkdirSync(bridgeDir(project), { recursive: true });
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
