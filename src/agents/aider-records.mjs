import fs from "node:fs";
import { createHash } from "node:crypto";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const invalid = () => new Error("Aider history changed or is unreadable; refusing to skip or invent context.");
const decode = (bytes) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

/** Aider's Markdown is evidence, not an unambiguous role-delimited protocol. */
function readStableBytes(file) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw invalid();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw invalid();
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes.length !== opened.size) throw invalid();
    return bytes;
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw invalid();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function readAiderHistory(file, { allowEmpty = false } = {}) {
  const bytes = readStableBytes(file);
  if (allowEmpty && bytes.length === 0) return { text: "", bytes };
  let text;
  try { text = decode(bytes); } catch { throw invalid(); }
  if (!/^\uFEFF?\s*# aider chat started at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\r?\n|$)/.test(text)) throw invalid();
  return { text, bytes };
}

export function aiderHistoryMark(history) {
  return { version: 1, bytes: history.bytes.length, sha256: digest(history.bytes) };
}

/** Verify the entire observed prefix before selecting new bytes. File size
 * alone would silently accept /clear, overwrite, replacement or truncation. */
export function aiderHistorySince(history, mark = null) {
  if (mark === null) return history.text;
  if (!mark || mark.version !== 1 || !Number.isSafeInteger(mark.bytes) || mark.bytes < 0 ||
      mark.bytes > history.bytes.length || typeof mark.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(mark.sha256) || digest(history.bytes.subarray(0, mark.bytes)) !== mark.sha256) throw invalid();
  try { return decode(history.bytes.subarray(mark.bytes)); }
  catch { throw invalid(); }
}

/** Bridge-owned completion evidence, separate from ambiguous native Markdown.
 * A newline commits a record; an interrupted final append cannot acknowledge.
 * Every record binds to a verified prefix of this exact native history. */
export function readAiderEvidence(file, history, { sessionId, projectId }) {
  const bytes = readStableBytes(file);
  const boundary = bytes.lastIndexOf(10) + 1;
  const committed = bytes.subarray(0, boundary);
  let rows;
  try { rows = decode(committed).trimEnd().split("\n").map((line) => JSON.parse(line)); }
  catch { throw invalid(); }
  const header = rows.shift();
  if (!sessionId || !projectId || header?.type !== "session" || header.version !== 1 ||
      header.sessionId !== sessionId || header.projectId !== projectId) throw invalid();
  let previousBytes = 0;
  for (const [index, row] of rows.entries()) {
    if (row?.type !== "turn" || row.sequence !== index + 1 ||
        typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at)) ||
        typeof row.completed !== "boolean" || typeof row.failed !== "boolean" ||
        !Number.isSafeInteger(row.responses) || row.responses < 0 ||
        row.completed !== (row.responses > 0 && !row.failed) ||
        !Array.isArray(row.messages) || row.messages.some((message) =>
          !message || !["user", "assistant"].includes(message.role) || typeof message.text !== "string") ||
        !row.history || row.history.bytes < previousBytes) throw invalid();
    aiderHistorySince(history, row.history);
    if (row.responses > row.messages.filter((message) => message.role === "assistant" && message.text.length > 0).length) throw invalid();
    previousBytes = row.history.bytes;
  }
  return { header, rows, bytes: committed, incompleteTail: boundary !== bytes.length };
}

export function aiderEvidenceMark(evidence) {
  return { version: 1, sessionId: evidence.header.sessionId, projectId: evidence.header.projectId,
    count: evidence.rows.length, bytes: evidence.bytes.length, sha256: digest(evidence.bytes) };
}

export function aiderDeliverySince(evidence, mark) {
  // An unobserved baseline must never turn historical success into receipt.
  if (!mark || mark.sessionId !== evidence.header.sessionId || mark.projectId !== evidence.header.projectId ||
      !Number.isSafeInteger(mark.count) || mark.count < 0 || mark.count > evidence.rows.length) throw invalid();
  aiderHistorySince(evidence, mark);
  let prefix;
  try { prefix = decode(evidence.bytes.subarray(0, mark.bytes)).trimEnd().split("\n").map(JSON.parse); }
  catch { throw invalid(); }
  if (prefix.length !== mark.count + 1 || evidence.bytes[mark.bytes - 1] !== 10) throw invalid();
  return !evidence.incompleteTail && evidence.rows.slice(mark.count).some((row) => row.completed);
}

export function aiderMark(history, evidence) {
  return { version: 1, history: aiderHistoryMark(history), evidence: aiderEvidenceMark(evidence) };
}

export function aiderActivity(history, evidence, mark = null) {
  if (mark !== null && (mark.version !== 1 || !mark.history || !mark.evidence)) throw invalid();
  if (mark) aiderHistorySince(history, mark.history);
  const baseline = mark?.evidence ?? aiderEvidenceMark({ ...evidence, rows: [],
    bytes: evidence.bytes.subarray(0, evidence.bytes.indexOf(10) + 1) });
  const deliveryObserved = aiderDeliverySince(evidence, baseline);
  const rows = evidence.rows.slice(baseline.count);
  const messages = rows.flatMap((row) => row.messages.map((message) => ({
    ...message, at: row.at,
    text: message.role === "assistant" && row.failed
      ? `[Aider response from an unsuccessful turn]\n${message.text}` : message.text,
  })));
  // Keep bytes not covered by an observation available to the adapter. Never
  // infer roles or successful delivery from that native Markdown remainder.
  let covered = evidence.rows.at(-1)?.history ?? { version: 1, bytes: 0, sha256: digest(Buffer.alloc(0)) };
  if (mark && mark.history.bytes > covered.bytes) covered = mark.history;
  const unobservedText = aiderHistorySince(history, covered);
  return { messages, patchedFiles: [], turnsCompleted: rows.filter((row) => row.completed).length,
    deliveryObserved, unobservedText, sourceComplete: !evidence.incompleteTail && !unobservedText };
}
