import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const pkg = readJson("package.json");
const plugin = readJson("plugin/.claude-plugin/plugin.json");
const marketplace = readJson(".claude-plugin/marketplace.json");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

test("all published manifests use the package version", () => {
  assert.equal(plugin.version, pkg.version, "the Claude plugin manifest must match package.json");
  assert.equal(marketplace.metadata.version, pkg.version, "the marketplace manifest must match package.json");
});

test("the current package version is the first changelog version", () => {
  const first = changelog.match(/^## \[([^\]]+)\]/m)?.[1];
  assert.equal(first, pkg.version, "the newest changelog entry must match package.json");
});
