import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function changelogEvidenceEntries(changelog) {
  const headings = [...changelog.matchAll(/^## \[([^\]]+)\].*$/gm)];
  if (headings.length < 2) throw new Error("Two changelog versions are required to identify the release interval.");
  const body = changelog.slice(headings[0].index + headings[0][0].length, headings[1].index);
  const entries = [];
  let lines = [];
  const flush = () => {
    if (lines.length) {
      const text = lines.map((line) => line.trim()).join("\n").trim();
      entries.push({ text, sha256: createHash("sha256").update(text).digest("hex") });
      lines = [];
    }
  };
  for (const line of body.split("\n")) {
    if (/^### /u.test(line)) { flush(); continue; }
    if (/^- /u.test(line)) { flush(); lines.push(line); }
    else if (!line.trim()) continue;
    else if (/^\s+/.test(line) && lines.length) lines.push(line);
    else throw new Error("Release notes must use top-level bullet entries with indented continuations; unaccounted text was found.");
  }
  flush();
  if (!entries.length) throw new Error("The current release has no attributable entries.");
  return { version: headings[0][1], previousVersion: headings[1][1], entries };
}

/** Structural traceability only: a reviewer must still judge the claims. */
export function verifyChangelogProvenance(root) {
  const name = "changelog-provenance";
  try {
    const notes = changelogEvidenceEntries(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
    const evidence = JSON.parse(fs.readFileSync(path.join(root, "docs/release-evidence.json"), "utf8"));
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 });
    const baseTag = `v${notes.previousVersion}`;
    const base = git("rev-parse", "--verify", `${baseTag}^{commit}`).trim();
    git("merge-base", "--is-ancestor", base, "HEAD");
    const taggedPackage = JSON.parse(git("show", `${base}:package.json`));
    if (taggedPackage.version !== notes.previousVersion) throw new Error("Previous tag and its package version disagree.");
    if (evidence.version !== notes.version || evidence.baseTag !== baseTag || evidence.baseCommit !== base || !Array.isArray(evidence.entries)) {
      throw new Error("Release evidence must name the current version and exact previous release tag/commit.");
    }
    const changed = new Set(git("diff", "--name-only", "-z", `${base}..HEAD`).split("\0").filter(Boolean));
    const remaining = new Map(notes.entries.map((entry) => [entry.sha256, entry]));
    if (remaining.size !== notes.entries.length) throw new Error("Duplicate changelog entries need distinct, reviewed claims.");
    for (const entry of evidence.entries) {
      if (!remaining.has(entry.sha256) || typeof entry.rationale !== "string" || !entry.rationale.trim() ||
          !Array.isArray(entry.files) || entry.files.length === 0 || new Set(entry.files).size !== entry.files.length ||
          !entry.files.every((file) => typeof file === "string" && changed.has(file) &&
            !["CHANGELOG.md", "docs/release-evidence.json"].includes(file))) {
        throw new Error("Every entry needs a unique current hash, rationale and changed supporting files (not the notes or evidence file itself).");
      }
      remaining.delete(entry.sha256);
    }
    if (remaining.size) throw new Error(`${remaining.size} changelog entries have no supporting evidence.`);
    return { name, passed: true, detail: `${notes.entries.length} entries traced to ${baseTag} (${base})..HEAD; semantic review is still required.` };
  } catch (error) {
    return { name, passed: false, detail: `Release provenance unverified: ${error.code ?? error.message}` };
  }
}
