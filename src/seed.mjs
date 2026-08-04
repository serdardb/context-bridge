// Seeding a new lane from another. A seed carries STARTER CONTEXT — the decisions,
// the open questions, the current git state, and the files the source lane had
// touched or read — and NOTHING that ties the new lane to the old one: no
// conversation, no session ids, no watermarks, no knownBy. Text may cross; identity
// and progress may not. It is copied, not referenced, so `lane rm` on the source
// cannot dangle it. A seed says plainly that it is a briefing, not a transcript,
// because a seed that read as a complete account of the work would be the very
// failure this project keeps removing from itself.
import fs from "node:fs";
import path from "node:path";
import {
  loadState,
  laneOf,
  readableCheckpointsDir,
  writeCheckpoint,
  mutateState,
  CHECKPOINT_KINDS,
} from "./state.mjs";
import { gitDelta } from "./delta.mjs";
import { latestManifest } from "./audit.mjs";
import { nowIso } from "./util.mjs";
import { AGENT_IDS } from "./agents/index.mjs";

const stamp = () => nowIso().replace(/[:.]/g, "-");

/** Newest full-context checkpoint text in a lane, or null. Read through the gate. */
function newestFullContext(projectDir, lane) {
  const dir = readableCheckpointsDir(projectDir, lane);
  if (!dir) return null;
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(CHECKPOINT_KINDS.fullContext));
  } catch {
    return null;
  }
  if (!names.length) return null;
  try {
    return fs.readFileSync(path.join(dir, names.sort().at(-1)), "utf8");
  } catch {
    return null;
  }
}

/**
 * The body under `## <name>` up to the next `## ` heading, trimmed. Decisions and
 * Next are not stored as data anywhere — they live only as text the departing agent
 * wrote into the full-context checkpoint — so a seed reads them back from our own
 * known layout. Returns "" when the section is absent or was the empty placeholder.
 */
export function sectionBody(text, name) {
  if (!text) return "";
  const head = new RegExp(`^## ${name}\\s*$`, "m").exec(text);
  if (!head) return "";
  const after = text.slice(head.index + head[0].length);
  const nextHead = /^## /m.exec(after);
  const body = (nextHead ? after.slice(0, nextHead.index) : after).trim();
  // The composers write a placeholder line when a section is empty; a seed should
  // treat that as nothing rather than copy the placeholder forward.
  if (/^_?No .*recorded\.?_?$/i.test(body) || /^_?Nothing was flagged.*_?$/i.test(body)) return "";
  return body;
}

/** The source lane's touched and read files, deduped across its agents. */
function sourceFiles(projectDir, lane) {
  const found = latestManifest(projectDir, lane);
  const changed = new Set();
  const read = new Set();
  for (const a of Object.values(found?.manifest?.agents ?? {})) {
    for (const f of a.filesChanged ?? []) changed.add(f);
    for (const f of a.filesRead ?? []) read.add(f);
  }
  return { changed: [...changed], read: [...read] };
}

function bullets(items, empty) {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : `_${empty}_`;
}

/** Compose the seed document. Its header is the honest part: no transcript. */
export function composeSeed(sourceLane, { decisions, next, gitLines, files }) {
  return [
    `# Seeded from lane "${sourceLane}"`,
    "",
    "Starter context for a new, separate line of work. No conversation, no sessions,",
    "and no sync history were carried over. Only the decisions, the open questions,",
    `the current git state, and the files lane "${sourceLane}" had touched crossed.`,
    "Treat it as a briefing, not a transcript.",
    "",
    "## Decisions carried over",
    "",
    decisions || "_No explicit decisions were recorded in the source lane._",
    "",
    "## Next",
    "",
    next || "_Nothing was flagged as unresolved in the source lane._",
    "",
    "## Git work (current)",
    "",
    bullets(gitLines, "No file or git changes detected."),
    "",
    "## Files the source lane touched",
    "",
    bullets(files.changed, "None recorded."),
    "",
    "## Files the source lane read",
    "",
    bullets(files.read, "None recorded."),
    "",
  ].join("\n");
}

/**
 * Seed `newLane` from `sourceLane`: compose the starter doc, write it into the new
 * lane, and leave an UNBOUND seed pending injection that the launcher binds to
 * whichever agent opens the lane first. The lane must already exist (the CLI creates
 * it). Returns a small report for the CLI to print. Nothing that identifies a
 * session crosses: the injection carries no watermarks and no agent.
 */
/**
 * Gather and compose the seed WITHOUT touching the target lane. Read-only against
 * the source, so the CLI can call it BEFORE it creates the new lane: a seed that
 * cannot be built leaves no half-made lane behind. Returns { doc, stem, report }.
 */
export function prepareSeed(projectDir, sourceLane) {
  const s = loadState(projectDir);
  const src = laneOf(s, sourceLane);
  const git = gitDelta(projectDir, src?.git?.sha ?? null);
  const fullText = newestFullContext(projectDir, sourceLane);
  const decisions = sectionBody(fullText, "Decisions");
  const next = sectionBody(fullText, "Next");
  const files = sourceFiles(projectDir, sourceLane);
  const doc = composeSeed(sourceLane, { decisions, next, gitLines: git.lines, files });

  // The checkpoint name must be a real handoff stem (agent-to-agent) so retention
  // and the clean pending-guard recognise it. The delivery agent is bound later, so
  // the stem only names the source's agent for provenance; it is not who receives it.
  const stemAgent = src?.activeAgent && AGENT_IDS.includes(src.activeAgent) ? src.activeAgent : "claude";
  const stem = `${stamp()}-${stemAgent}-to-${stemAgent}`;
  return {
    doc,
    stem,
    report: {
      decisions: Boolean(decisions),
      next: Boolean(next),
      touched: files.changed.length,
      read: files.read.length,
      gitLines: git.lines.length,
    },
  };
}

/**
 * Write a prepared seed into `newLane` and mark it for delivery. The same document
 * is written as BOTH the delta and its full-context companion, so delivery's road
 * fit can trim the delta to a hook's 8KB or a prompt's 128KB and still point at the
 * whole thing — an oversized seed loses nothing. Sets an UNBOUND seed injection the
 * launcher binds to whichever agent opens the lane first. Returns the delta's path.
 */
export function writeSeed(projectDir, newLane, prepared) {
  writeCheckpoint(projectDir, newLane, `${prepared.stem}${CHECKPOINT_KINDS.fullContext}`, prepared.doc);
  const deltaRel = writeCheckpoint(projectDir, newLane, `${prepared.stem}${CHECKPOINT_KINDS.delta}`, prepared.doc);
  const now = nowIso();
  mutateState(projectDir, newLane, (disk) => {
    disk.pendingInjection = {
      seed: true, // unbound: the launcher binds it to the first agent that opens the lane
      agent: null,
      via: null,
      id: null, // seeds the first session on this lane; no session is resumed
      deltaFile: deltaRel,
      createdAt: now,
    };
  });
  return deltaRel;
}

/** Prepare + write in one call. Used by tests and any non-rollback caller. */
export function seedLane(projectDir, newLane, sourceLane) {
  const prepared = prepareSeed(projectDir, sourceLane);
  const deltaRel = writeSeed(projectDir, newLane, prepared);
  return { deltaRel, ...prepared.report };
}

/**
 * The fields to bind an unbound seed injection to the agent opening the lane. Pure,
 * so the binding decision is testable without spawning an agent. Returns null when
 * `inj` is not an unbound seed.
 */
export function seedBinding(inj, agent, hookEligible) {
  if (!inj?.seed || inj.agent != null) return null;
  return { agent, via: hookEligible ? "hook" : "prompt" };
}

/**
 * Bind an unbound seed on `lane` to `agent`, under the state lock, and report
 * whether THIS caller won it. Two launchers can open one seeded lane at once; the
 * lock serialises them and the re-check inside it means exactly one binds. The loser
 * gets false and opens the lane with no seed of its own, rather than delivering a
 * seed now owned by another agent.
 */
export function bindSeed(projectDir, lane, agent, hookEligible) {
  let won = false;
  mutateState(projectDir, lane, (disk) => {
    const bind = seedBinding(disk.pendingInjection, agent, hookEligible);
    if (bind && !disk.agents?.[agent]?.id) {
      disk.pendingInjection.agent = bind.agent;
      disk.pendingInjection.via = bind.via;
      delete disk.pendingInjection.seed;
      won = true;
    }
  });
  return won;
}

/**
 * Revert a seed this launcher bound but never actually opened — the agent failed to
 * spawn at all (a bad binary, ENOENT). Without this the seed would stay locked to a
 * process that never ran, and no other agent could become the first opener. Only
 * reverts the exact still-undelivered binding (a delivered seed clears the pending
 * marker), so an agent that DID start and merely has not answered keeps it for retry.
 */
export function unbindSeed(projectDir, lane, agent) {
  mutateState(projectDir, lane, (disk) => {
    const inj = disk.pendingInjection;
    if (inj && !inj.seed && inj.agent === agent && inj.id == null && inj.deltaFile) {
      inj.seed = true;
      inj.agent = null;
      inj.via = null;
    }
  });
}
