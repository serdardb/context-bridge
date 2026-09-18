import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { releaseChecks, verifyReleaseCI } from "../src/release.mjs";
import { prepareReleaseEvidence, verifyReleaseEvidence, releaseEvidencePath, RELEASE_GATES } from "../src/release-evidence.mjs";
import { verifyReport } from "../src/doctor.mjs";
import { AGENT_IDS } from "../src/agents/index.mjs";

test("release verification requires every supported agent, not just those installed", () => {
  const agents = Object.fromEntries(AGENT_IDS.map((id) => [id, { version: "fixture", smoke: { ok: true } }]));
  const routes = Object.fromEntries(AGENT_IDS.flatMap((from) => AGENT_IDS.filter((to) => to !== from)
    .map((to) => [`${from}->${to}`, { configured: true }])));
  const bridge = { locking: { ok: true } };
  assert.equal(verifyReport({ agents, routes, bridge }, { all: true }).ok, true);
  for (const id of AGENT_IDS) {
    const missing = { ...agents, [id]: {} };
    assert.equal(verifyReport({ agents: missing, routes, bridge }).ok, true);
    const report = verifyReport({ agents: missing, routes, bridge }, { all: true });
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((message) => message.startsWith(`${id} is required`)));
  }
});

test("the actual npm prepublish script refuses missing acceptance without rerunning live gates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-publish-gates-"));
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
  const expected = ["release-check --evidence --json"];
  try {
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "bin/bridge.mjs"), `import fs from "node:fs";
const step = process.argv.slice(2).join(" ");
fs.appendFileSync("gates.log", step + "\\n");
if (step === process.env.FAIL_GATE) process.exitCode = 1;
`);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bridge-publish-gates", version: "1.0.0",
      scripts: { test: "node bin/bridge.mjs test", check: "node bin/bridge.mjs check", eval: "node bin/bridge.mjs eval",
        prepublishOnly: pkg.scripts.prepublishOnly } }));
    for (const failure of [...expected, "none"]) {
      fs.rmSync(path.join(root, "gates.log"), { force: true });
      const result = spawnSync("npm", ["run", "prepublishOnly"], {
        cwd: root, env: { ...process.env, FAIL_GATE: failure }, encoding: "utf8", timeout: 30000,
      });
      assert.equal(result.status, failure === "none" ? 0 : 1, result.stderr);
      const ran = fs.readFileSync(path.join(root, "gates.log"), "utf8").trim().split("\n");
      assert.deepEqual(ran, failure === "none" ? expected : expected.slice(0, expected.indexOf(failure) + 1));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("release evidence binds actual package bytes and commit, expires and rejects failed preparation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-release-receipt-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const executed = [];
  const execute = (_root, [name]) => { executed.push(name); };
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bridge-receipt-fixture", version: "1.0.0", files: ["index.js", "payload.bin"] }));
    fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "payload.bin\n");
    fs.writeFileSync(path.join(root, "payload.bin"), "first build");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Release Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    assert.throws(() => verifyReleaseEvidence(root), /No readable release acceptance/);
    const prepared = prepareReleaseEvidence(root, { execute });
    assert.deepEqual(executed, RELEASE_GATES.map(([name]) => name));
    assert.equal(verifyReleaseEvidence(root).binding.packageSha256, prepared.binding.packageSha256);
    const file = releaseEvidencePath(root), original = fs.readFileSync(file);
    const linkedReceipt = file + ".linked";
    fs.linkSync(file, linkedReceipt);
    try {
      assert.throws(() => verifyReleaseEvidence(root), { code: "BRIDGE_RELEASE_EVIDENCE" },
        "a shared receipt leaf must not authorize publication");
    } finally { fs.unlinkSync(linkedReceipt); }
    for (const change of [
      (r) => { r.gates.pop(); },
      (r) => { r.startedAt = new Date(Date.now() - 25 * 3600000).toISOString(); },
      (r) => { r.binding.commit = "different"; },
    ]) {
      const receipt = JSON.parse(original); change(receipt);
      fs.writeFileSync(file, JSON.stringify(receipt));
      assert.throws(() => verifyReleaseEvidence(root), { code: "BRIDGE_RELEASE_EVIDENCE" });
    }
    fs.writeFileSync(file, original);
    fs.writeFileSync(path.join(root, "payload.bin"), "different ignored build");
    assert.throws(() => verifyReleaseEvidence(root), /different commit, package or toolchain/);
    fs.writeFileSync(path.join(root, "payload.bin"), "first build");
    fs.appendFileSync(path.join(root, "index.js"), "// dirty\n");
    assert.throws(() => verifyReleaseEvidence(root), /clean working tree/);
    fs.writeFileSync(path.join(root, "index.js"), "export const value = 1;\n");
    executed.length = 0;
    assert.throws(() => prepareReleaseEvidence(root, { execute: (_root, [name]) => {
      executed.push(name); if (name === "agents") throw new Error("offline");
    } }), /failed at agents/);
    assert.deepEqual(executed, RELEASE_GATES.slice(0, 7).map(([name]) => name));
    assert.equal(fs.existsSync(file), false, "a failed recheck invalidates previous success");
    assert.throws(() => prepareReleaseEvidence(root, { execute: () => {
      fs.writeFileSync(path.join(root, "payload.bin"), "changed during checks");
    } }), /changed during release preparation/);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("future releases pass metadata gates without historical wording and mismatches fail", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-future-release-"));
  const write = (name, contents) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  };
  const metadata = (version) => {
    write("package.json", { name: "bridge-release-fixture", version, files: ["src", "bin", "plugin", "codex", "docs", ".claude-plugin"] });
    write("plugin/.claude-plugin/plugin.json", { name: "bridge", version });
    write(".claude-plugin/marketplace.json", { metadata: { version } });
    write("CHANGELOG.md", `# Changes\n\n## [${version}]\n\nA genuinely new feature.\n\n## [1.0.0]\n\nOld functionality.\n`);
  };
  const gate = (report, name) => report.checks.find((item) => item.name === name).passed;
  try {
    for (const name of ["bin/bridge.mjs", "src/cli.mjs", "src/storage.mjs", "plugin/hooks/hooks.json", "codex/SKILL.md", "docs/ARCHITECTURE.md"]) write(name, "fixture\n");
    for (const version of ["1.1.0", "2.0.0"]) {
      metadata(version);
      const report = releaseChecks(root);
      assert.equal(gate(report, "manifest-versions"), true);
      assert.equal(gate(report, "changelog-first-version"), true);
      assert.equal(gate(report, "package-files"), true, "fixture passes actual npm pack inspection");
      assert.equal(gate(report, "changelog-provenance"), false, "fixture has no attribution evidence");
      assert.equal(report.passed, false, "metadata alone is never release approval");
    }
    write("CHANGELOG.md", "## [2.1.0]\nWrong newest entry.\n\n## [2.0.0]\nCurrent package is only the second entry.\n");
    assert.equal(gate(releaseChecks(root), "changelog-first-version"), false);
    metadata("2.0.0");
    write("plugin/.claude-plugin/plugin.json", { version: "1.1.0" });
    assert.equal(gate(releaseChecks(root), "manifest-versions"), false);
    metadata("2.0.0");
    write(".claude-plugin/marketplace.json", { metadata: { version: "1.1.0" } });
    assert.equal(gate(releaseChecks(root), "manifest-versions"), false);
    metadata("2.0.0");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    pkg.files.push("notes");
    write("package.json", pkg);
    write("notes/private-review.md", "local-only review fixture");
    const leaked = releaseChecks(root);
    assert.equal(gate(leaked, "package-private-files"), false);
    assert.match(leaked.checks.find((item) => item.name === "package-private-files").detail, /notes\/private-review\.md/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("CI verification requires the latest exact-HEAD run and successful nonempty jobs", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const runs = [
    { databaseId: 1, attempt: 1, headSha: head, createdAt: "2026-09-15T00:00:00Z" },
    { databaseId: 2, attempt: 2, headSha: head, createdAt: "2026-09-16T00:00:00Z" },
  ];
  const good = { databaseId: 2, attempt: 2, headSha: head, status: "completed", conclusion: "success",
    jobs: [{ status: "completed", conclusion: "success" }], url: "https://example.invalid/run/2" };
  for (const [overrides, expected] of [[{}, true], [{ headSha: "old-commit" }, false],
    [{ attempt: 1 }, false], [{ status: "in_progress" }, false], [{ conclusion: "failure" }, false],
    [{ jobs: [] }, false], [{ jobs: [{ status: "completed", conclusion: "skipped" }] }, false]]) {
    const calls = [];
    const result = verifyReleaseCI(root, { run: (command, args, options) => {
      calls.push(args);
      assert.equal(command, "gh");
      assert.equal(options.timeout, 30000);
      assert.equal(options.killSignal, "SIGKILL");
      return JSON.stringify(args[1] === "list" ? runs : { ...good, ...overrides });
    } });
    assert.equal(result.passed, expected);
    assert.ok(calls[0].includes(head));
    assert.deepEqual(calls[1].slice(0, 5), ["run", "view", "2", "--attempt", "2"]);
  }
  assert.equal(verifyReleaseCI(root, { run: () => "[]" }).passed, false);
  assert.equal(verifyReleaseCI(root, { run: () => { throw new Error("no authentication"); } }).passed, false);
});

test("release check reports all release gates", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const report = releaseChecks(root);
  assert.equal(report.checks.find((item) => item.name === "manifest-versions").passed, true);
  assert.equal(report.checks.find((item) => item.name === "changelog-first-version").passed, true);
  assert.ok(report.checks.some((item) => item.name === "working-tree"));
  assert.ok(report.checks.some((item) => item.name === "previous-tag"));
  assert.ok(report.checks.some((item) => item.name === "changelog-provenance"));
  assert.equal(report.checks.find((item) => item.name === "ci-head").passed, false, "a workflow file is not CI evidence");
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const calls = [];
    cp.execFileSync = (command, args, options) => {
      calls.push({ command, timeout: options.timeout, killSignal: options.killSignal });
      throw Object.assign(new Error('synthetic command timeout'), { code: 'ETIMEDOUT' });
    };
    syncBuiltinESMExports();
    const { releaseChecks } = await import(${JSON.stringify(new URL("../src/release.mjs", import.meta.url).href)});
    console.log(JSON.stringify({ calls, report: releaseChecks(${JSON.stringify(root)}) }));
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(probe.status, 0, probe.stderr);
  const timedOut = JSON.parse(probe.stdout);
  assert.ok(timedOut.calls.some(call => call.command === "npm"));
  assert.ok(timedOut.calls.some(call => call.command === "git"));
  for (const call of timedOut.calls) {
    assert.equal(call.timeout, call.command === "npm" ? 120000 : 30000);
    assert.equal(call.killSignal, "SIGKILL");
  }
  for (const name of ["previous-tag", "working-tree", "package-files", "package-private-files", "changelog-provenance"]) {
    assert.equal(timedOut.report.checks.find(item => item.name === name).passed, false, name);
  }
});
