// Parser canary.
//
// `CONFIGURED` only proves an agent is installed and logged in. It says nothing
// about whether the bridge can still READ that agent's session files, and the
// session formats are internal to each vendor: a renamed field ships in a point
// release and every handoff quietly produces an empty delta while doctor stays
// green. `--deep` does not catch this either, because an agent answering a
// headless question proves nothing about our parsing of its transcript.
//
// So this sits between the two: no network, no auth, no subprocess, just the
// same local parse the handoff itself uses. Measured on this project's own
// transcripts (16.2MB Claude, 3.1MB Codex, 0.5MB Grok) it costs 98ms for all
// three, which is why doctor can afford to run it by default.
//
// Two rules it must never break, both learned the hard way in review:
//   - A fresh project has no linked session. That is NEUTRAL, never red.
//   - An empty session is readable. Zero messages is a fact, not a failure.
import fs from "node:fs";
import path from "node:path";

/**
 * Read a JSONL transcript and judge whether our parser still understands it.
 *
 * `isKnownRow` is the vendor-specific half: given a parsed row, does it look
 * like a record shape this adapter knows? Most rows in a healthy transcript are
 * unknown to us (system, reasoning, tool output) and that is normal, so unknown
 * rows are never held against the file. Only two things matter: did ANY row look
 * familiar, and did lines fail to parse as JSON at all.
 *
 * Returns {status, rows, known, malformed}, status being one of:
 *   readable  file parses and at least one row is a shape we know (or is empty)
 *   partial   parses, but some lines are not JSON; the parser read past them
 *   mismatch  rows exist and not one is recognisable — the vendor-drift signal
 *   missing   the path we were given is not there
 */
export function probeJsonl(filePath, isKnownRow) {
  // "missing" is reported with the file's own name. An agent can keep more than
  // one stream (Grok keeps two), and a message that just says "the transcript"
  // sends people to the wrong file.
  const gone = { status: "missing", rows: 0, known: 0, malformed: 0, detail: filePath ? path.basename(filePath) : null };
  if (!filePath) return gone;
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return gone;
  }

  let rows = 0;
  let known = 0;
  let malformed = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    rows++;
    try {
      if (isKnownRow(row)) known++;
    } catch {
      // A predicate that throws on an unexpected row is itself drift evidence,
      // but it is not this row's fault; count it as unrecognised and move on.
    }
  }

  // An empty file is a session that has not spoken yet, not a broken parser.
  if (rows === 0 && malformed === 0) return { status: "readable", rows, known, malformed };
  if (rows > 0 && known === 0) return { status: "mismatch", rows, known, malformed };
  if (malformed > 0) return { status: "partial", rows, known, malformed };
  return { status: "readable", rows, known, malformed };
}

/**
 * Combine the shape probe with a real parse through the adapter's own activity
 * path, so the canary exercises exactly what a handoff would run rather than a
 * lookalike. The message count is reported as information, never as the verdict:
 * zero messages is legitimate on an empty or fully-consumed session.
 */
export function probeWithActivity(adapter, ref, shape) {
  if (shape.status === "missing" || shape.status === "mismatch") return { ...shape, messages: null };
  try {
    const activity = adapter.activitySince(ref, null);
    return { ...shape, messages: activity.messages.length };
  } catch (err) {
    // The file looked familiar but the parser blew up walking it. That is drift
    // too, and a louder kind: report it rather than swallowing the exception.
    return { ...shape, status: "mismatch", messages: null, detail: err.message };
  }
}

/**
 * Does what an agent DECLARES it can record still match what it actually writes?
 *
 * `capabilities` is a claim, and claims rot in two directions. The existing
 * canaries only catch one of them: if a vendor renames a field we already read,
 * parsing breaks and something goes red. But if a vendor STARTS recording
 * something we declare as absent, nothing breaks at all. Grok could begin
 * storing command arguments tomorrow and this project would keep reporting that
 * it cannot, forever, without a single failing test. A canary that only watches
 * for loss is half a canary.
 *
 * The hard part is not the comparison, it is knowing when to stay quiet. A
 * session where no tool ever ran proves nothing about what the agent could have
 * recorded, and reporting that as a missing capability would be the same false
 * alarm as calling a fresh project a broken one. So an observation is only
 * reported when there was something to observe, and `observed: null` means the
 * session had nothing to say rather than that it said no.
 */
export function capabilityDrift(declared, observed) {
  const lost = [];
  const gained = [];
  for (const [field, claim] of Object.entries(declared ?? {})) {
    const seen = observed?.[field];
    if (seen === null || seen === undefined) continue; // nothing to learn from this session
    // An observation has to be expressed in the same words as the claim, or the
    // comparison is meaningless. The first run of this reported that Codex had
    // LOST its exit code, because the claim said "parsed", meaning read out of
    // prose, while the observer looked for a structured field and correctly
    // failed to find one. Both were right and the diff was still wrong.
    if (rank(seen) < rank(claim)) lost.push(field);
    // Worth catching in its own right: a vendor promoting prose to a real field
    // is a gain, and nothing else in this codebase would ever notice it.
    if (rank(seen) > rank(claim)) gained.push(field);
  }
  const status = lost.length ? "lost" : gained.length ? "gained" : "matches";
  return { status, lost, gained };
}

/** Absent, recoverable only by parsing, or recorded outright. */
function rank(value) {
  if (value === false || value === undefined || value === null) return 0;
  if (value === "parsed" || value === "partial" || value === "truncated") return 1;
  return 2;
}
