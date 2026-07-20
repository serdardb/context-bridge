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
