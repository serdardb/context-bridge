import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseDocument } from "yaml";

for (const relative of ["../codex/SKILL.md", "../plugin/skills/bridge/SKILL.md"]) {
  test(`${relative} has loadable YAML metadata rather than parser-specific loose text`, () => {
    const content = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
    const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    assert.ok(header, "skill must have a complete frontmatter block");
    const document = parseDocument(header[1], { uniqueKeys: true });
    assert.deepEqual(document.errors, [], "strict YAML readers must be able to load the skill");
    const metadata = document.toJS();
    assert.equal(metadata.name, "bridge");
    assert.equal(typeof metadata.description, "string");
    assert.ok(metadata.description.trim());
  });
}
