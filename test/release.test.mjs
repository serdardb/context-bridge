import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

function section(version) {
  const part = changelog.split(/^## \[/m).find((entry) => entry.startsWith(`${version}]`));
  assert.ok(part, `CHANGELOG.md must contain a section for ${version}`);
  return part;
}

test("the current package version is the first changelog version", () => {
  assert.match(changelog, new RegExp(`^## \\[${pkg.version.replaceAll(".", "\\.")}\\]`, "m"));
});

test("release notes do not reannounce the old whole-message release as current", () => {
  const current = section(pkg.version);
  assert.match(current, /Corrected the 0\.12\.3 release notes/);
  for (const phrase of [
    "Agent-written handoff summaries",
    "Whole-message context and durable evidence",
    "Lanes and recovery hardening",
    "Codex hook delivery is reachable and budgeted",
  ]) {
    assert.doesNotMatch(current, new RegExp(phrase));
  }
});
