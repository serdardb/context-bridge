// The audit manifest: what an agent actually did, kept beside the delta rather
// than inside it.
//
// The delta is what the next agent reads, and it stays small, because the whole
// reason this project exists is that context is expensive. The manifest is the
// opposite: it lives on local disk, costs nothing to keep, and is opened only
// when somebody needs to know why a step failed. One line in the delta says it
// exists; nothing else about it is spent on tokens.
//
// It records only what happened. What an agent could NEVER record is declared
// once in its adapter's `capabilities`, not repeated here, because an empty
// command list means one thing for Claude, which records commands, and quite
// another for Grok, which records that a command ran but never its text. Without
// that separation the same empty array carries three different meanings and a
// reader cannot tell them apart — which is exactly how Codex discovery stayed
// dead for weeks, a failed parse being indistinguishable from an empty result.
import fs from "node:fs";
import path from "node:path";
import { adapterFor } from "./agents/index.mjs";
import { checkpointsDir } from "./state.mjs";

export const MANIFEST_VERSION = 1;

/** How many successful commands per agent are worth showing before it is a wall. */
const SHOWN_PER_AGENT = 15;

/**
 * Build the manifest for one handoff, from every agent the target has not caught
 * up with, in the same shape the delta is gathered.
 */
export function buildManifest(projectDir, { source, target, sources = {} }, marks = {}) {
  const agents = {};
  for (const [id, ref] of Object.entries(sources)) {
    const adapter = adapterFor(id);
    if (!adapter?.auditSince || !ref) continue;
    let audit;
    try {
      audit = adapter.auditSince(ref, marks[id] ?? null);
    } catch {
      // A reader that throws must not take the handoff down with it. The delta
      // is the product; the manifest is a convenience beside it.
      continue;
    }
    if (!audit) continue;
    agents[id] = {
      commands: audit.commands ?? [],
      // Scoped to this project, like everything else the bridge records. An
      // agent's session file spans every directory it has ever worked in, and a
      // first run of this listed edits to two unrelated repositories: true, and
      // none of this project's business.
      filesRead: withinProject(projectDir, audit.filesRead),
      filesChanged: withinProject(projectDir, audit.filesChanged),
      // Kept in the shape though nothing caps extraction any more: the manifest
      // is local and free, so it holds every command. The render is what bounds
      // what a person sees, and it never hides a failure to do it.
      dropped: audit.dropped ?? 0,
      capabilities: adapter.capabilities ?? null,
    };
  }
  return { manifestVersion: MANIFEST_VERSION, source, target, agents };
}

/**
 * Paths inside this project, relative to it, and nothing else.
 *
 * Kept relative because an audit that spells out a home directory is unreadable
 * and travels badly, and absolute paths are the one part of this that says more
 * about the machine than about the work.
 */
function withinProject(projectDir, paths) {
  const root = path.resolve(projectDir);
  const out = [];
  for (const p of paths ?? []) {
    if (typeof p !== "string" || !p) continue;
    const abs = path.resolve(root, p);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    out.push(path.relative(root, abs));
  }
  return [...new Set(out)];
}

/** Write it beside its delta, sharing the stem so the pair is obvious on disk. */
export function writeManifest(projectDir, stem, manifest) {
  const rel = path.join(".bridge", "checkpoints", `${stem}-audit.json`);
  fs.mkdirSync(checkpointsDir(projectDir), { recursive: true });
  fs.writeFileSync(path.join(projectDir, rel), JSON.stringify(manifest, null, 2));
  return rel;
}

/** The newest manifest in this project, which is what `bridge inspect` defaults to. */
export function latestManifest(projectDir) {
  let names;
  try {
    names = fs.readdirSync(checkpointsDir(projectDir)).filter((n) => n.endsWith("-audit.json"));
  } catch {
    return null;
  }
  if (!names.length) return null;
  const newest = names.sort().at(-1);
  const rel = path.join(".bridge", "checkpoints", newest);
  try {
    return { rel, manifest: JSON.parse(fs.readFileSync(path.join(projectDir, rel), "utf8")) };
  } catch {
    return null;
  }
}

/**
 * Render it for a human, failures first.
 *
 * Ordering by usefulness rather than by completeness is deliberate. A session
 * here produced 967 commands of which 6 failed, and the six are the entire
 * reason anybody opens this file. Listing them in the order they ran would bury
 * the answer under everything that worked.
 */
export function renderManifest(manifest) {
  const lines = [];
  lines.push(`audit  ${manifest.source} → ${manifest.target}`);
  for (const [id, a] of Object.entries(manifest.agents ?? {})) {
    const failed = a.commands.filter((c) => c.ok === false);
    const unknown = a.commands.filter((c) => c.ok === null);
    lines.push("");
    lines.push(`${id}  ${a.commands.length} commands, ${failed.length} failed, ${a.filesChanged.length} files changed`);
    if (a.dropped) lines.push(`  (${a.dropped} further commands not recorded: the manifest caps what it keeps)`);

    for (const c of failed) {
      lines.push(`  FAILED  ${describe(c)}`);
    }
    // Only worth saying when it is not the whole list, otherwise it is noise.
    if (unknown.length && unknown.length !== a.commands.length) {
      lines.push(`  ${unknown.length} commands with no recorded outcome`);
    }
    // Failures first, but not failures only. A session where nothing failed
    // would otherwise render as a row of counts, and "what did the last agent
    // actually do" is a fair question even when the answer is "it all worked".
    const rest = a.commands.filter((c) => c.ok !== false).slice(0, SHOWN_PER_AGENT);
    for (const c of rest) lines.push(`  ran      ${describe(c)}`);
    const hidden = a.commands.filter((c) => c.ok !== false).length - rest.length;
    if (hidden > 0) lines.push(`  ran      … and ${hidden} more`);
    for (const f of a.filesChanged.slice(0, 20)) lines.push(`  changed  ${f}`);
    if (a.filesChanged.length > 20) lines.push(`  changed  … and ${a.filesChanged.length - 20} more`);

    // The limits that explain an empty column, so nobody reads absence as zero.
    const c = a.capabilities ?? {};
    const blind = [];
    if (c.commandArgs === false) blind.push("does not record command text");
    if (c.filesRead === false) blind.push("has no file-read tool to observe");
    else if (c.filesRead === "partial") blind.push("records only some file reads");
    if (c.exitCode === false) blind.push("reports no exit code");
    if (blind.length) lines.push(`  note     ${id} ${blind.join("; ")}`);
  }
  return lines.join("\n");
}

function describe(c) {
  const what = c.args ? oneLine(c.args) : c.tool ? `${c.tool} (arguments not recorded)` : "unknown command";
  const bits = [];
  if (c.exitCode !== null && c.exitCode !== undefined) bits.push(`exit ${c.exitCode}`);
  if (c.durationMs !== null && c.durationMs !== undefined) bits.push(`${c.durationMs}ms`);
  return bits.length ? `${what}  [${bits.join(", ")}]` : what;
}

function oneLine(args) {
  const text = String(typeof args === "string" ? args : JSON.stringify(args));
  const lines = text.split("\n");
  // A heredoc cut at its first newline reads as a broken command rather than a
  // long one, so say how much was left instead of pretending there was no more.
  const first = lines[0].length > 100 ? `${lines[0].slice(0, 100)}…` : lines[0];
  return lines.length > 1 ? `${first}  (+${lines.length - 1} more lines)` : first;
}
