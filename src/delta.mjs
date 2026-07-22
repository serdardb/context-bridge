// Deterministic context-delta extraction. No LLM summarization calls in v0.1:
// conversation truth comes from native session files, work truth from git.
import fs from "node:fs";
import { tryExec } from "./util.mjs";

// There is no message cap and no per-message length here, deliberately, and this
// comment is the guard against one coming back. Every number that used to live
// at the top of this file was chosen against nothing: 14 messages, 220
// characters, 8KB. None of them ever met the budget the delta was actually
// measured against, so a handoff carried a tenth of what it was allowed to while
// the room went unused. What decides now is the road's own limit, passed in by
// the caller, and whatever does not fit is left out whole and counted.

/** Claude transcript records (user/assistant text) newer than sinceIso. */
export function claudeMessagesSince(transcriptPath, sinceIso) {
  const out = [];
  for (const r of readJsonl(transcriptPath)) {
    if (!r.timestamp || (sinceIso && r.timestamp <= sinceIso)) continue;
    if (r.isSidechain) continue;
    if (r.type === "user") {
      const text = extractClaudeText(r.message?.content);
      if (text && !isBridgeProtocolNoise(text)) out.push({ role: "user", text, at: r.timestamp });
    } else if (r.type === "assistant") {
      const text = extractClaudeText(r.message?.content);
      if (text) out.push({ role: "assistant", text, at: r.timestamp });
    }
  }
  return out;
}

/** Codex rollout activity newer than sinceIso. */
export function codexActivitySince(rolloutPath, sinceIso) {
  const messages = [];
  const patchedFiles = new Set();
  let turnsCompleted = 0;
  for (const r of readJsonl(rolloutPath)) {
    if (!r.timestamp || (sinceIso && r.timestamp <= sinceIso)) continue;
    const p = r.payload || {};
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
  return { messages, patchedFiles: [...patchedFiles], turnsCompleted };
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
 * Compose the bounded 4-section bridge delta.
 * sections: {fromAgent, conversation: [{role,text}], decisions: [], work: [], next: []}
 */
export function composeDelta(sections, budget) {
  const plan = planDelta(sections, budget);
  const streams = normaliseSources(sections);
  const conversationBlock =
    plan.every((p) => p.candidates === 0)
      ? "No conversation activity since last sync."
      : plan
          .map((p) => {
            const body = [...p.kept.map((m) => messageBlock(m, p.label)), omissionNote(p)].filter(Boolean).join("\n\n");
            // One source needs no attribution; several do, or a chain arrives as
            // an unattributed pile and the reader cannot tell who decided what.
            return streams.length > 1 ? `## From ${p.label}\n\n${body}` : body;
          })
          .filter((block) => block.trim())
          .join("\n\n");
  return shell(sections, streams, conversationBlock);
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
  const wordings = { true: trailing(true), false: trailing(false) };
  const effective = budget - Math.max(Buffer.byteLength(wordings.true), Buffer.byteLength(wordings.false));
  const lost = deltaLostSomething(planDelta(sections, effective));
  return composeDelta(sections, effective) + wordings[lost];
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
  return `[${omitted} earlier ${plural(omitted, "message")} from ${label} did not fit above, out of ${candidates} new ${plural(candidates, "message")}. They are whole in the full context checkpoint.]`;
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

export function composeFullContext({ fromAgent, conversation, sources, decisions, work, next }) {
  const streams = normaliseSources({ fromAgent, conversation, sources });
  const list = (items, empty) => (items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`);
  const blocks = streams
    .filter((st) => st.messages.length)
    .map((st) => {
      const body = st.messages.map((m) => messageBlock(m, st.label)).join("\n\n");
      return streams.length > 1 ? `## From ${st.label}\n\n${body}` : body;
    });
  const who = streams.map((st) => st.label).join(", ");
  return [
    `# Bridge full context — from ${who}`,
    "",
    "The same handoff with no budget over it. Nothing here is left out.",
    "",
    "## Conversation",
    "",
    blocks.length ? blocks.join("\n\n") : "_No conversation activity since last sync._",
    "",
    "## Decisions",
    "",
    list(decisions, "No explicit decisions were recorded."),
    "",
    "## Work",
    "",
    list(work, "No file or git changes detected."),
    "",
    "## Next",
    "",
    list(next, "Nothing was flagged as unresolved."),
    "",
  ].join("\n");
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function* readJsonl(p) {
  let content;
  try {
    content = fs.readFileSync(p, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {}
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
  const order = [];
  const filesChanged = new Set();
  let dropped = 0;

  for (const r of readJsonl(rolloutPath)) {
    if (!r.timestamp || (sinceIso && r.timestamp <= sinceIso)) continue;
    const p = r.payload || {};
    // Codex issues a call two ways: function_call (exec_command) carries its args
    // as a JSON string in `arguments`, while custom_tool_call (apply_patch) carries
    // them in `input`. Handling only the first recorded the patch's OUTPUT but
    // never the call, so apply_patch never appeared as a command at all. Found in
    // review, and hidden until then by a test that prepended a synthetic call.
    if ((p.type === "function_call" || p.type === "custom_tool_call") && p.call_id) {
      calls.set(p.call_id, { tool: p.name ?? null, args: argsOf(p.arguments ?? p.input), at: r.timestamp, ok: null, exitCode: null, durationMs: null });
      order.push(p.call_id);
    } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && calls.has(p.call_id)) {
      Object.assign(calls.get(p.call_id), readOutcome(p.output));
    } else if (r.type === "event_msg" && p.type === "patch_apply_end") {
      for (const f of extractPatchFiles(p)) filesChanged.add(f);
    }
  }

  const commands = order.map((id) => calls.get(id)).filter(Boolean);
  return {
    commands,
    filesChanged: [...filesChanged],
    filesRead: [], // Codex runs everything through exec_command; see its capabilities
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
