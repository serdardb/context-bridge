// Deterministic context-delta extraction. No LLM summarization calls in v0.1:
// conversation truth comes from native session files, work truth from git.
import { createHash } from "node:crypto";
import { tryExec, BridgeError, readTranscriptLines, transcriptRetentionBudget } from "./util.mjs";

// There is no message cap and no per-message length here, deliberately, and this
// comment is the guard against one coming back. Every number that used to live
// at the top of this file was chosen against nothing: 14 messages, 220
// characters, 8KB. None of them ever met the budget the delta was actually
// measured against, so a handoff carried a tenth of what it was allowed to while
// the room went unused. What decides now is the road's own limit, passed in by
// the caller, and whatever does not fit is left out whole and counted.

/** New marks attest parsed history; legacy ISO marks retain timestamp filtering. */
export function transcriptMark(file) {
  let rows = 0;
  const hash = createHash("sha256");
  try { for (const row of readJsonl(file, true)) { rows++; hash.update(JSON.stringify(row) + "\n"); } }
  catch (error) {
    // A linked session may not have published its first transcript yet. Only
    // confirmed absence is an empty baseline; unreadable evidence still fails.
    if (error.cause?.code !== "ENOENT") throw error;
    rows = 0;
  }
  return { rows, prefixHash: hash.digest("hex") };
}

export function markedTranscript(file, mark, readStatus = null) {
  const attested = Number.isSafeInteger(mark?.rows) && mark.rows >= 0 && typeof mark.prefixHash === "string";
  let sourceRewritten = false, expectedHash = null;
  if (attested) {
    const prefix = createHash("sha256"), all = createHash("sha256");
    let count = 0;
    for (const row of readJsonl(file, true)) {
      const encoded = JSON.stringify(row) + "\n";
      all.update(encoded);
      if (count++ < mark.rows) prefix.update(encoded);
    }
    sourceRewritten = count < mark.rows || prefix.digest("hex") !== mark.prefixHash;
    expectedHash = all.digest("hex");
  }
  const rows = { *entries() {
    const hash = createHash("sha256");
    let index = 0;
    for (const row of readJsonl(file, true, readStatus)) {
      if (expectedHash) hash.update(JSON.stringify(row) + "\n");
      yield [index++, row];
    }
    if (expectedHash && hash.digest("hex") !== expectedHash) throw new BridgeError("Source transcript changed between verification and extraction. Retry without advancing its mark.", { code: "BRIDGE_TRANSCRIPT_UNREADABLE" });
  } };
  if (readStatus) readStatus.sourceRewritten = sourceRewritten;
  const selected = (row, index) => attested
    ? sourceRewritten || index >= mark.rows
    : !mark || !row.timestamp || row.timestamp > mark;
  return { rows, selected, sourceRewritten };
}

/** Claude transcript records (user/assistant text) after the saved mark. */
export function claudeMessagesSince(transcriptPath, sinceIso, readStatus = null) {
  const out = [];
  const retain = transcriptRetentionBudget();
  const { rows, selected } = markedTranscript(transcriptPath, sinceIso, readStatus);
  for (const [index, r] of rows.entries()) {
    if (!r.timestamp || !selected(r, index)) continue;
    if (r.isSidechain) continue;
    if (r.type === "user") {
      const text = extractClaudeText(r.message?.content);
      if (text && !isBridgeProtocolNoise(text)) { retain(text); out.push({ role: "user", text, at: r.timestamp }); }
    } else if (r.type === "assistant") {
      const text = extractClaudeText(r.message?.content);
      if (text) { retain(text); out.push({ role: "assistant", text, at: r.timestamp }); }
    }
  }
  return out;
}

/** Codex rollout activity newer than sinceIso. */
export function codexActivitySince(rolloutPath, sinceIso) {
  const readStatus = { malformed: 0 };
  const messages = [];
  const retain = transcriptRetentionBudget();
  const patchedFiles = new Set();
  let turnsCompleted = 0;
  const { rows, selected, sourceRewritten } = markedTranscript(rolloutPath, sinceIso, readStatus);
  for (const [index, r] of rows.entries()) {
    if (!r.timestamp || !selected(r, index)) continue;
    const p = r.payload || {};
    if (r.type === "event_msg") retain(p.message ?? p.last_agent_message ?? p.changes ?? p.files ?? "");
    if (r.type === "event_msg") {
      if (p.type === "user_message" && p.message) {
        if (!isBridgeProtocolNoise(p.message)) messages.push({ role: "user", text: String(p.message), at: r.timestamp });
      } else if (p.type === "agent_message" && p.message) {
        messages.push({ role: "assistant", text: String(p.message), at: r.timestamp });
      } else if (p.type === "task_complete") {
        turnsCompleted++;
        if (p.last_agent_message) {
          const last = messages[messages.length - 1];
          if (!last || last.text !== String(p.last_agent_message)) {
            messages.push({ role: "assistant", text: String(p.last_agent_message), at: r.timestamp });
          }
        }
      } else if (p.type === "patch_apply_end") {
        for (const f of extractPatchFiles(p)) patchedFiles.add(f);
      }
    }
  }
  return { messages, patchedFiles: [...patchedFiles], turnsCompleted, sourceRewritten, sourceComplete: readStatus.malformed === 0 };
}

/** True when the rollout contains a task_complete event after sinceIso (idle signal). */
export function rolloutIdleAfter(rolloutPath, sinceIso) {
  try {
    for (const r of readJsonl(rolloutPath)) {
      if (r.timestamp > sinceIso && r.type === "event_msg" && r.payload?.type === "task_complete") return true;
    }
  } catch {}
  return false;
}

/** Git work truth for the project. */
export function gitDelta(projectDir, sinceSha) {
  const opts = { cwd: projectDir };
  const inRepo = tryExec("git", ["rev-parse", "--is-inside-work-tree"], opts) === "true";
  if (!inRepo) return { inRepo: false, lines: [] };
  const lines = [];
  const status = tryExec("git", ["status", "--porcelain"], opts);
  if (status) {
    for (const l of status.split("\n").slice(0, 20)) lines.push(`uncommitted: ${l.trim()}`);
  }
  if (sinceSha) {
    const log = tryExec("git", ["log", "--oneline", `${sinceSha}..HEAD`], opts);
    if (log) for (const l of log.split("\n").slice(0, 15)) lines.push(`commit: ${l.trim()}`);
    const stat = tryExec("git", ["diff", "--stat", `${sinceSha}..HEAD`], opts);
    if (stat) {
      const tail = stat.trim().split("\n").pop();
      if (tail) lines.push(`diff: ${tail.trim()}`);
    }
  }
  return { inRepo: true, lines };
}

export function currentGitSha(projectDir) {
  return tryExec("git", ["rev-parse", "HEAD"], { cwd: projectDir });
}

/**
 * Compose the bounded bridge delta.
 * sections: {fromAgent, summary, conversation: [{role,text}], decisions: [], work: [], next: []}
 */
export function composeDelta(sections, budget) {
  const plan = planDelta(sections, budget);
  const streams = normaliseSources(sections);
  const conversationBlock =
    plan.every((p) => p.candidates === 0)
      ? sections.warnings?.length ? "No readable conversation was extracted. See source limitations above." : "No conversation activity since last sync."
      : plan
          .map((p) => {
            const body = [omissionNote(p), ...p.kept.map((m) => messageBlock(m, p.label))].filter(Boolean).join("\n\n");
            // One source needs no attribution; several do, or a chain arrives as
            // an unattributed pile and the reader cannot tell who decided what.
            return streams.length > 1 ? `## From ${p.label}\n\n${body}` : body;
          })
          .filter((block) => block.trim())
          .join("\n\n");
  return shell(sections, streams, conversationBlock);
}

/**
 * How much of a delta the departing agent's own account may take.
 *
 * Provisional, and named so it does not claim otherwise. It is larger than the
 * 8KB cap a whole delta used to live under and far below the 128KB the operating
 * system allows, which is the entire argument for it so far. The real
 * distribution is being recorded by the deltas themselves, one file per handoff,
 * and this moves when there is a week of them to read. What it must never become
 * again is a number of bullet points: the skill used to ask for at most three
 * short sentences, and that instruction cost more than every byte cap in this
 * file put together.
 */
export const DEFAULT_SUMMARY_BYTES = 12 * 1024;

/**
 * Raised when an agent's summary is larger than the delta can carry.
 *
 * Loud, and never a silent trim. Cutting it here would take the first characters
 * and drop the reasoning, which is the defect this whole line of work exists to
 * remove; the agent that wrote it is the only thing that knows what it can
 * afford to lose. An expected error rather than a crash, so the agent reads a
 * sentence and not a stack trace.
 */
export class SummaryTooLarge extends BridgeError {
  constructor(bytes, budget) {
    super(
      `The summary is ${bytes} bytes and this handoff allows ${budget}. ` +
        "Shorten it yourself and run the same command again, once. " +
        "Nothing has been written, and the bridge will not cut it for you: " +
        "it would keep your opening and drop your reasoning."
    );
    this.name = "SummaryTooLarge";
    this.bytes = bytes;
    this.budget = budget;
  }
}

/**
 * How much of THIS delta the summary may take.
 *
 * Derived, never a constant. The first version of this checked a flat 12KB at
 * the door before the road was known, which is two budgets that cannot see each
 * other: a 5KB summary passed the door and produced a 5333-byte delta on a
 * 4096-byte hook road, so the claim that the summary was charged to the delta's
 * budget was false on exactly the narrow road where it mattered.
 *
 * So the room is the road minus everything in the delta that is not the summary
 * and cannot be trimmed, and `DEFAULT_SUMMARY_BYTES` is only a ceiling on top of
 * that. On a wide road the ceiling binds; on a narrow one the road does.
 */
export function summaryBudgetFor(sections, roadBudget) {
  const streams = normaliseSources(sections);
  const withoutSummary = Buffer.byteLength(shell({ ...sections, summary: "" }, streams, ""));
  return Math.max(0, Math.min(DEFAULT_SUMMARY_BYTES, roadBudget - withoutSummary));
}

/**
 * Check before anything is written.
 *
 * `handoff` writes the audit manifest and the full context checkpoint before it
 * composes the delta, so failing at composition time would leave those two files
 * behind for a handoff that never happened.
 */
export function checkSummaryFits(summary, budget = DEFAULT_SUMMARY_BYTES) {
  const bytes = Buffer.byteLength(String(summary ?? "").trim());
  if (bytes > budget) throw new SummaryTooLarge(bytes, budget);
  return bytes;
}

/**
 * The departing agent's account of the work, checked against its own budget.
 *
 * Absence is not failure. Recovery exists for an agent that could not speak: a
 * quota, a crash, a turn that never ended. Refusing to produce a handoff then
 * would mean the feature built for the moment you are stuck refuses to run when
 * you are stuck. So a missing summary produces a delta that says it is missing,
 * and the mechanical extract underneath stops being presented as a reading.
 */
function summaryBlock(summary, budget) {
  const text = String(summary ?? "").trim();
  if (!text) {
    return (
      "Summary\n\n" +
      "[No agent-written summary was available for this handoff. What follows is " +
      "extracted from the transcript, git and the audit manifest, and is a record " +
      "rather than a reading: nobody has said which parts of it matter.]"
    );
  }
  checkSummaryFits(text, budget);
  return `Summary\n\n${text}`;
}

/** Everything but the conversation, which is the part with a budget. */
function shell(sections, streams, conversationBlock) {
  const sec = (title, items, empty) =>
    `${title}\n${items.length ? items.map((i) => (i.startsWith("-") ? i : `- ${i}`)).join("\n") : `- ${empty}`}`;
  return [
    "[Bridge Context Update]",
    "",
    `While you were away, work continued in ${streams.map((st) => st.label).join(", ")}.`,
    "",
    summaryBlock(sections.summary, sections.summaryBudget ?? DEFAULT_SUMMARY_BYTES),
    ...(sections.warnings?.length ? ["", "Source limitations", ...sections.warnings.map(warning => `- ${warning}`)] : []),
    "",
    `Conversation\n\n${conversationBlock}`,
    "",
    sec("Decisions", sections.decisions ?? [], "No explicit decisions were recorded."),
    "",
    sec("Work", sections.work ?? [], "No file or git changes detected."),
    "",
    sec("Next", sections.next ?? [], "Nothing was flagged as unresolved."),
  ].join("\n");
}

/** One message as it appears in a delta and in its full context checkpoint. */
export function messageBlock(m, label) {
  return `### ${m.role === "user" ? "User" : label}${m.at ? ` — ${m.at}` : ""}\n\n${m.text}`;
}

const JOIN_BYTES = 2; // the "\n\n" between blocks, charged so the plan is honest

function messageCost(m, label) {
  return Buffer.byteLength(messageBlock(m, label)) + JOIN_BYTES;
}

/**
 * What this delta can carry, and what it therefore leaves behind.
 *
 * Whole messages or none. A message that does not fit is left out and counted,
 * never halved, because a halved message does not read as incomplete: it reads
 * as a short answer, and that is how a review that never answered its question
 * passed as one that had.
 *
 * Called by `composeDelta` and again by the caller that has to describe the same
 * delta in its own words. Same inputs, same result, so the description and the
 * thing described cannot drift apart.
 */
export function planDelta(sections, budget) {
  const streams = normaliseSources(sections);
  if (!Number.isFinite(budget)) {
    throw new TypeError("composeDelta needs the budget of the road it is travelling; there is no default.");
  }

  // Everything that is not conversation is charged first, including the worst
  // case of every omission note. The worst case is exact rather than guessed:
  // the longest a note can be is the one saying nothing fit at all, whatever the
  // plan turns out to be.
  const fixed =
    Buffer.byteLength(shell(sections, streams, "")) +
    streams.reduce(
      (n, st) =>
        n +
        Buffer.byteLength(omissionNote({ label: st.label, candidates: st.messages.length, kept: [], omitted: st.messages.length, newestTooLarge: true }) ?? "") +
        (streams.length > 1 ? Buffer.byteLength(`## From ${st.label}\n\n`) : 0),
      0
    );
  const shares = allocate(streams, Math.max(0, budget - fixed));

  return streams.map((st, i) => {
    const kept = fillNewestFirst(st, shares[i]);
    const newest = st.messages[st.messages.length - 1];
    return {
      label: st.label,
      candidates: st.messages.length,
      kept,
      omitted: st.messages.length - kept.length,
      // Three ways to come through with nothing, and they are not the same news.
      // The agent said nothing; or its newest message alone is unaffordable; or
      // the road was so narrow that the decisions and the git summary spent the
      // budget before the conversation was reached. Only the first is an idle
      // agent, and a reader who cannot tell them apart is being misled.
      noRoom: shares[i] <= 0 && st.messages.length > 0,
      newestTooLarge:
        kept.length === 0 && st.messages.length > 0 && shares[i] > 0 && messageCost(newest, st.label) > shares[i],
    };
  });
}

/**
 * Max-min fair shares of the room.
 *
 * A stream that needs less than an equal share releases the rest, and the
 * surplus flows to the ones that need more. Without this a chatty agent takes
 * the whole budget and the quiet one whose three messages actually mattered
 * arrives empty.
 */
function allocate(streams, room) {
  const need = streams.map((st) => st.messages.reduce((n, m) => n + messageCost(m, st.label), 0));
  const shares = new Array(streams.length).fill(0);
  let remaining = room;
  let left = streams.length;
  for (const i of streams.map((_, i) => i).sort((a, b) => need[a] - need[b])) {
    shares[i] = Math.min(need[i], Math.floor(remaining / left));
    remaining -= shares[i];
    left--;
  }
  return shares;
}

/**
 * Newest first, contiguous, stopping at the first message that does not fit.
 *
 * Contiguous rather than skipping over the oversized one: a gap in the middle of
 * a conversation is harder to read than a shorter tail, and a message larger
 * than the whole budget is 0.24% of the messages measured here. The output stays
 * in the order it happened; only the filling walks backwards.
 *
 * **This rule is biased against long messages and that is a known cost, chosen
 * rather than overlooked.** Measured across another project's paired deltas, the
 * messages it drops have a median length of 632 characters against 256 for the
 * ones it keeps: a long message costs more budget, so it is likelier to be the
 * one the walk stops at. Length is not importance, but the messages this project
 * most regretted losing were all long ones, so the bias runs the wrong way.
 *
 * Two alternatives were measured and neither earned its place. Keeping the head
 * of the span alongside the tail was proposed on the theory that decisions live
 * at the start; in the first third of a span, dropped and kept messages carry
 * decision language at 54% and 56%, which is the same, so the rule would not aim
 * at what it was built for. And the finding that dropped messages carry more
 * decision language at all does not survive a length control: hold length
 * constant and the gap mostly closes, because longer text matches any keyword
 * more often while also being likelier to be dropped.
 *
 * So this stays until there is an importance measure that is not a proxy. What
 * actually reduces the risk is the summary, which is instructed to carry the
 * reasoning that a long message would otherwise be the only home for. That makes
 * summary coverage across every agent the real mitigation, and this allocator a
 * fallback whose bias matters most exactly when no summary was written.
 */
function fillNewestFirst(st, share) {
  const kept = [];
  let used = 0;
  for (let i = st.messages.length - 1; i >= 0; i--) {
    const cost = messageCost(st.messages[i], st.label);
    if (used + cost > share) break;
    used += cost;
    kept.unshift(st.messages[i]);
  }
  return kept;
}

/** True when this delta is carrying less than it was given. */
export function deltaLostSomething(plan) {
  return plan.some((p) => p.omitted > 0);
}

/**
 * A delta plus whatever its caller appends, inside one budget and described by
 * one plan.
 *
 * This exists because of a bug that got as far as review. The caller was
 * planning against the road's whole budget and composing against the budget
 * minus its own trailing text, so the delta could drop a message while the
 * sentence underneath it said nothing had been left out. Two budgets meant two
 * deltas, one of which was never built and was the one being described.
 *
 * `trailing` is asked for both of its wordings ONCE, and the two strings it
 * returns are both measured and kept. The longer is reserved, and the one that
 * turns out to be right is appended verbatim from what was measured rather than
 * asked for a second time. So the budget cannot be broken by a `trailing` that
 * answers differently when asked twice: it is never asked twice. Reviewing this
 * raised exactly that worry, and a comment asking the next person to keep the
 * function pure is the kind of guard that has already failed three times here.
 */
export function composeForRoad(sections, budget, trailing) {
  const { effective, wordings } = budgetAfterTrailing(budget, trailing);
  const lost = deltaLostSomething(planDelta(sections, effective));
  return composeDelta(sections, effective) + wordings[lost];
}

/**
 * The part of the road left for the delta body after the caller's own footer.
 *
 * Exported so the caller that validates a summary before writing anything can
 * validate against the same reservation `composeForRoad` will later make. Without
 * this, a summary could pass the door and still force delivery to trim the delta
 * after the full-context pointer was appended.
 */
export function budgetAfterTrailing(budget, trailing) {
  const wordings = { true: trailing(true), false: trailing(false) };
  const effective = budget - Math.max(Buffer.byteLength(wordings.true), Buffer.byteLength(wordings.false));
  return { effective, wordings };
}

/**
 * The sentence a stream owes the reader, or nothing when it owes none.
 *
 * Silence here is a claim that nothing was left behind, so it has to be true.
 */
function omissionNote({ label, candidates, kept, omitted, newestTooLarge, noRoom }) {
  if (omitted <= 0) return null;
  if (kept.length === 0) {
    // Never let this land as "no conversation activity". An agent that said
    // nothing and an agent whose every word was too large to carry are opposite
    // situations, and the reader has to be able to tell them apart.
    const why = noRoom
      ? "this delta's budget was spent before the conversation was reached"
      : newestTooLarge
        ? "the newest alone is larger than this delta's budget"
        : "none of them fit";
    return `[None of ${label}'s ${candidates} new ${plural(candidates, "message")} could be carried: ${why}. All of them are whole in the full context checkpoint.]`;
  }
  return `[${omitted} earlier ${plural(omitted, "message")} from ${label} are not included in this delta preview, out of ${candidates} new ${plural(candidates, "message")}. They are whole in the full context checkpoint.]`;
}

function plural(n, word) {
  return n === 1 ? word : `${word}s`;
}

/** Accepts either the single-source shape or a labelled multi-source list. */
function normaliseSources({ fromAgent, conversation, sources }) {
  if (Array.isArray(sources) && sources.length) {
    return sources.map((st) => ({ label: st.label ?? cap(st.id ?? "agent"), messages: st.messages ?? [] }));
  }
  return [{ label: cap(fromAgent ?? "agent"), messages: conversation ?? [] }];
}

export function composeFullContext({ fromAgent, conversation, sources, decisions, work, next, summary, warnings = [] }) {
  const streams = normaliseSources({ fromAgent, conversation, sources });
  const list = (items, empty) => (items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`);
  // The summary belongs here as well. This file is what the delta points at when
  // the road was too narrow, and arriving to find the evidence without the
  // reading of it would be a worse record than the delta it replaces.
  const summaryText = String(summary ?? "").trim();
  const blocks = streams
    .filter((st) => st.messages.length)
    .map((st) => {
      const body = st.messages.map((m) => messageBlock(m, st.label)).join("\n\n");
      return streams.length > 1 ? `## From ${st.label}\n\n${body}` : body;
    });
  const who = streams.map((st) => st.label).join(", ");
  const values = [
    (summaryText || "_No agent-written summary was available for this handoff._") +
      (warnings.length ? `\n\nSource limitations\n${warnings.map(warning => `- ${warning}`).join("\n")}` : ""),
    blocks.length ? blocks.join("\n\n") : warnings.length ? "_No readable conversation was extracted._" : "_No conversation activity since last sync._",
    list(decisions, "No explicit decisions were recorded."),
    list(work, "No file or git changes detected."),
    list(next, "Nothing was flagged as unresolved."),
  ];
  return indexedContext(`# Bridge full context — from ${who}`, values);
}

function indexedContext(title, values) {
  const body = CONTEXT_SECTIONS.map((name, i) => `## ${name}\n\n${values[i]}\n\n`).join("");
  // Lengths are recorded before rendering: Markdown inside a message is data,
  // never a delimiter. The digest detects stale indexes, not authenticity.
  const index = { version: 1, units: "utf16", lengths: values.map((value) => value.length),
    sha256: createHash("sha256").update(body).digest("hex") };
  return `${title}\n${CONTEXT_INDEX}${JSON.stringify(index)} -->\n${body}`;
}

const CONTEXT_SECTIONS = ["Summary", "Conversation", "Decisions", "Work", "Next"];
const CONTEXT_INDEX = "<!-- bridge-section-index ";

/** Legacy checkpoints remain opaque; their free-form headings are ambiguous. */
export function readFullContextSections(text) {
  const firstEnd = text.indexOf("\n");
  const indexEnd = text.indexOf("\n", firstEnd + 1);
  const line = text.slice(firstEnd + 1, indexEnd < 0 ? undefined : indexEnd);
  if (!line.startsWith(CONTEXT_INDEX)) return null;
  const invalid = () => new Error("Invalid full context section index; refusing partial extraction.");
  if (indexEnd < 0 || !line.endsWith(" -->")) throw invalid();
  let index;
  try { index = JSON.parse(line.slice(CONTEXT_INDEX.length, -4)); } catch { throw invalid(); }
  if (index?.version !== 1 || index.units !== "utf16" || !Array.isArray(index.lengths) ||
      index.lengths.length !== CONTEXT_SECTIONS.length ||
      !index.lengths.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= text.length) ||
      typeof index.sha256 !== "string") throw invalid();
  let offset = indexEnd + 1;
  const start = offset;
  const sections = {};
  for (const [i, name] of CONTEXT_SECTIONS.entries()) {
    const heading = `## ${name}\n\n`;
    if (!text.startsWith(heading, offset)) throw invalid();
    offset += heading.length;
    sections[name.toLowerCase()] = text.slice(offset, offset + index.lengths[i]);
    offset += index.lengths[i];
    if (!text.startsWith("\n\n", offset)) throw invalid();
    offset += 2;
  }
  if (createHash("sha256").update(text.slice(start, offset)).digest("hex") !== index.sha256) throw invalid();
  return sections;
}

/** Redaction changes lengths: rebuild the index rather than exporting a stale one. */
export function transformFullContext(text, transform) {
  const sections = readFullContextSections(text);
  if (!sections) return transform(text);
  const firstEnd = text.indexOf("\n");
  const bodyStart = text.indexOf("\n", firstEnd + 1) + 1;
  const values = CONTEXT_SECTIONS.map((name) => sections[name.toLowerCase()]);
  const bodyLength = CONTEXT_SECTIONS.reduce((n, name, i) => n + `## ${name}\n\n${values[i]}\n\n`.length, 0);
  return indexedContext(transform(text.slice(0, firstEnd)), values.map(transform)) + transform(text.slice(bodyStart + bodyLength));
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function* readJsonl(p, required = false, readStatus = null) {
  try {
    for (const line of readTranscriptLines(p)) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); }
      catch { if (readStatus) readStatus.malformed++; continue; }
      yield row;
    }
  } catch (cause) {
    if (cause.code === "BRIDGE_TRANSCRIPT_TOO_LARGE") throw cause;
    if (required) throw new BridgeError("The source transcript could not be read. Check permissions and storage availability before retrying.", {
      code: "BRIDGE_TRANSCRIPT_UNREADABLE", cause,
    });
    return;
  }
}

function extractClaudeText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
  }
  return null;
}

function extractPatchFiles(payload) {
  const files = [];
  const changes = payload.changes || payload.files || null;
  if (changes && typeof changes === "object") {
    for (const k of Object.keys(changes)) files.push(k);
  } else if (payload.path) {
    files.push(String(payload.path));
  }
  return files;
}

export function isBridgeProtocolNoise(text) {
  const t = String(text);
  return (
    t.trim() === "[Request interrupted by user]" ||
    // The invocation itself, and only that. `$bridge codex` is the user working
    // the bridge; "$bridge is returning an empty delta" is the user telling you
    // something, and a filter that eats it loses a real message with no trace,
    // because filtering happens before anything is counted.
    /^\$bridge(\s+[\w:-]+)?\s*$/.test(t.trim()) ||
    t.startsWith("<command-name>") ||
    t.startsWith("<local-command") ||
    t.includes("<command-message>") ||
    t.startsWith("Caveat:") ||
    t.startsWith("Base directory for this skill:") ||
    t.includes(SKILL_SENTINEL) ||
    (t.includes("Follow these steps exactly:") && t.includes("bridge handoff <target>")) ||
    t.startsWith("[Bridge Context Update]")
  );
}

/**
 * A sentence copied out of the handoff skill, and the reason there is a test
 * reading that file to check it is still in there.
 *
 * The skill's own instructions were arriving as conversation and taking 73% of a
 * real delta, sent to the agent that already has them. Recognising them means
 * matching their words, and matching words written in another file is how this
 * project has now shipped the same class of bug four times. The difference here
 * is that the copy is named, and a test fails the moment the original moves,
 * rather than the noise quietly coming back. Phase 4 rewrites that skill, so
 * this is not a hypothetical.
 */
export const SKILL_SENTINEL = "hand this session off to another coding agent via context-bridge";

/**
 * What Codex actually did, as opposed to what it said it did.
 *
 * This walks the same rollout rows `codexActivitySince` already visits, so it
 * opens no new file and adds no parser: the tool rows were being stepped over
 * and discarded. That was the argument that decided this design, once it was
 * checked rather than assumed.
 *
 * Codex pairs a call to its output through `call_id`, which both rows carry, so
 * pairing survives reordering. The exit code and the wall time are recovered
 * from the output string, because that is where Codex writes them, and the
 * adapter declares them as `parsed` for exactly that reason: they work today and
 * they are the first thing to break when somebody rewords a sentence.
 */
export function codexAuditSince(rolloutPath, sinceIso) {
  const calls = new Map();
  const retain = transcriptRetentionBudget();
  const included = new Set();
  const order = [];
  const filesChanged = new Set();
  let dropped = 0;
  const readStatus = { malformed: 0 };

  const { rows, selected } = markedTranscript(rolloutPath, sinceIso, readStatus);
  for (const [index, r] of rows.entries()) {
    if (!r.timestamp) continue;
    const fresh = selected(r, index);
    const p = r.payload || {};
    // Codex issues a call two ways: function_call (exec_command) carries its args
    // as a JSON string in `arguments`, while custom_tool_call (apply_patch) carries
    // them in `input`. Handling only the first recorded the patch's OUTPUT but
    // never the call, so apply_patch never appeared as a command at all. Found in
    // review, and hidden until then by a test that prepended a synthetic call.
    if ((p.type === "function_call" || p.type === "custom_tool_call") && p.call_id) {
      retain([p.call_id, p.arguments ?? p.input, p.name, r.timestamp]);
      calls.set(p.call_id, { tool: p.name ?? null, args: argsOf(p.arguments ?? p.input), at: r.timestamp, ok: null, exitCode: null, durationMs: null });
      order.push(p.call_id);
      if (fresh) included.add(p.call_id);
    } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && calls.has(p.call_id)) {
      Object.assign(calls.get(p.call_id), readOutcome(p.output));
      if (fresh) included.add(p.call_id);
    } else if (fresh && r.type === "event_msg" && p.type === "patch_apply_end") {
      for (const f of extractPatchFiles(p)) filesChanged.add(f);
    }
  }

  const commands = order.filter(id => included.has(id)).map((id) => calls.get(id)).filter(Boolean);
  return {
    commands,
    filesChanged: [...filesChanged],
    filesRead: [], // Codex runs everything through exec_command; see its capabilities
    sourceComplete: readStatus.malformed === 0,
    // Never a silent cap. A manifest that quietly stops at 200 reads as a
    // complete account of a session that was in fact longer.
    dropped,
  };
}

/** Arguments arrive as a JSON string; keep the text when it is not parseable. */
function argsOf(raw) {
  if (typeof raw !== "string") return raw ?? null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.cmd ?? parsed?.command ?? parsed;
  } catch {
    return raw;
  }
}

/** The two facts Codex writes as prose rather than as fields. */
function readOutcome(output) {
  const text = String(output ?? "");
  // Codex writes the exit code two ways across rollout variants, measured on this
  // machine: "Process exited with code N" in exec output and "Exit code: N" in
  // custom tool output. Missing the second under-reported 22 real failures.
  const code = text.match(/Process exited with code (-?\d+)/) || text.match(/Exit code:\s*(-?\d+)/);
  const wall = text.match(/Wall time:\s*([\d.]+)\s*seconds?/);
  const exitCode = code ? Number(code[1]) : null;
  return {
    exitCode,
    ok: exitCode === null ? null : exitCode === 0,
    durationMs: wall ? Math.round(Number(wall[1]) * 1000) : null,
  };
}
