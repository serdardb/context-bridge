import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { changelogEvidenceEntries, verifyChangelogProvenance } from "../src/release-provenance.mjs";

test("release entries fail closed on unaccounted prose instead of ignoring it", () => {
  const notes = "## [2.0.0]\n### Added\n- A feature.\n  Its reason.\n\n## [1.0.0]\n- Earlier.\n";
  const parsed = changelogEvidenceEntries(notes);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].text, "- A feature.\nIts reason.");
  assert.throws(() => changelogEvidenceEntries(notes.replace("### Added", "An untracked claim.")), /unaccounted text/);
  assert.throws(() => changelogEvidenceEntries("## [2.0.0]\nNo previous release."), /Two changelog/);
});

test("release provenance binds every current entry to real changed files and the previous tag commit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-provenance-"));
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  try {
    git("init", "--quiet");
    write("package.json", { name: "fixture", version: "1.0.0" });
    write("src/changed.mjs", "old implementation\n");
    write("src/unchanged.mjs", "historical feature\n");
    write("CHANGELOG.md", "## [1.0.0]\n- Historical feature.\n");
    git("add", "."); git("commit", "--quiet", "-m", "fixture base"); git("tag", "v1.0.0");
    const base = git("rev-parse", "HEAD");
    const notes = "## [2.0.0]\n### Fixed\n- A changed implementation.\n  Its current reason.\n\n## [1.0.0]\n- Historical feature.\n";
    write("package.json", { name: "fixture", version: "2.0.0" });
    write("src/changed.mjs", "new implementation\n");
    write("CHANGELOG.md", notes);
    git("add", "."); git("commit", "--quiet", "-m", "fixture next");
    // A tag on HEAD must not turn the comparison into an empty diff.
    git("tag", "v2.0.0");
    const entry = { sha256: changelogEvidenceEntries(notes).entries[0].sha256,
      files: ["src/changed.mjs"], rationale: "The implementation now provides the described behavior." };
    const evidence = { version: "2.0.0", baseTag: "v1.0.0", baseCommit: base, entries: [entry] };
    assert.equal(verifyChangelogProvenance(root).passed, false, "missing evidence must fail");
    write("docs/release-evidence.json", evidence);
    assert.equal(verifyChangelogProvenance(root).passed, true);
    for (const patch of [{ entries: [] }, { baseCommit: git("rev-parse", "HEAD") }, { baseTag: "v2.0.0" },
      { entries: [entry, entry] }, { entries: [{ ...entry, files: ["src/unchanged.mjs"] }] },
      { entries: [{ ...entry, files: ["CHANGELOG.md"] }] },
      { entries: [{ ...entry, rationale: "" }] }, { entries: [{ ...entry, sha256: "obsolete hash" }] }]) {
      write("docs/release-evidence.json", { ...evidence, ...patch });
      assert.equal(verifyChangelogProvenance(root).passed, false, JSON.stringify(patch));
    }
    write("docs/release-evidence.json", evidence);
    write("CHANGELOG.md", notes.replace("A changed implementation.", "A reworded historical feature."));
    assert.equal(verifyChangelogProvenance(root).passed, false, "rewording must require a new attribution");
    write("CHANGELOG.md", notes);
    git("tag", "-f", "v1.0.0", "HEAD");
    assert.equal(verifyChangelogProvenance(root).passed, false, "moving the base tag invalidates evidence");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
