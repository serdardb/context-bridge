import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

function versions() {
  return [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1]);
}

function releaseTitles() {
  const parts = changelog.split(/^## \[/m).slice(1);
  return parts.flatMap((part) => {
    const version = part.match(/^([^\]]+)\]/)?.[1];
    return [...part.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((match) => ({ version, title: match[1].trim() }));
  });
}

test("the current package version is the first changelog version", () => {
  assert.equal(versions()[0], pkg.version, "the newest changelog entry must match package.json");
});

test("a release title appears in only one changelog version", () => {
  const seen = new Map();
  for (const { version, title } of releaseTitles()) {
    const previous = seen.get(title);
    assert.equal(previous, undefined, `release title '${title}' is repeated in ${previous} and ${version}`);
    seen.set(title, version);
  }
});
