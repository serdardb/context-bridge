// Which road a delta takes to reach its target.
//
// There are two, and exactly one is used per handoff. A hook can put context
// straight into the agent's own conversation, proven live for Codex; a prompt
// carries it as the opening message of a resumed session, which works everywhere
// but shapes the session around the delivery.
//
// The awkward part is that the road has to be chosen before the agent starts.
// Nothing can be injected into a session already running, and whether a hook
// will fire cannot be known: Codex requires the user to trust hooks once with
// `/hooks`, that trust can be withdrawn at any time, and neither state is
// readable from outside. So the choice is a judgement, and the design answers
// that by making the aftermath honest rather than pretending the judgement is
// certain: the launcher checks afterwards whether the delta was actually taken,
// and says so plainly when it was not.
import fs from "node:fs";
import path from "node:path";
import { CHECKPOINT_KINDS, CONSUMED_SUFFIX } from "./state.mjs";
import { adapterFor } from "./agents/index.mjs";

/**
 * How much of a delta may ride inside a hook's model-visible output.
 *
 * Codex caps that output around 2,500 model-visible tokens and degrades
 * gracefully past it, writing the full text to a file and showing the model a
 * preview with the path. That cap was measured when hook delivery was first
 * proven live, with an 8KB bounded delta recorded as right at the edge. Token to
 * byte conversion is content-dependent, so this is a measured operating point,
 * not proof that every 8KB body is under the cap. The full context checkpoint is
 * still named alongside any trim, so the agent always has a way to read the rest.
 */
export const HOOK_DELTA_BYTES = 8 * 1024;

/**
 * How much of a delta may ride as a command-line prompt.
 *
 * The operating system decides this one, not us. `ARG_MAX` is 1MB on macOS and
 * covers arguments and environment together, and a first switch used to pack the
 * whole conversation: on a 1569-message session that produced a 1.0MB delta,
 * measured, and `spawn` refused it outright with E2BIG. The agent never started,
 * so the failure arrived as a launch error rather than as anything about context.
 *
 * 128KB is far below the limit even with a large environment, and far above the
 * bounded delta an ordinary switch produces. Whatever does not fit stays in the
 * full context checkpoint, whose path travels with the text.
 */
export const PROMPT_DELTA_BYTES = 128 * 1024;

/** Roughly a month. A stamp older than this says nothing about today. */
const HOOK_SEEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Would a hook plausibly deliver to this agent right now?
 *
 * Two conditions, and neither is proof. The hooks have to still be installed,
 * which is readable, and one has to have actually run here recently, which is
 * the only evidence that trust was ever granted. Trust can be revoked without
 * telling anyone, so this is eligibility, never a guarantee, and every caller
 * has to be built for it being wrong.
 */
export function hookDeliveryEligible(agent, slot, now = Date.now()) {
  const adapter = adapterFor(agent);
  if (!adapter?.installedHooks) return false;
  const { missing } = adapter.installedHooks();
  if (missing.length) return false;

  const seen = slot?.hookSeen ? Date.parse(slot.hookSeen) : NaN;
  if (!Number.isFinite(seen)) return false;
  return now - seen <= HOOK_SEEN_MAX_AGE_MS;
}

/**
 * The delta as a hook should present it: bounded, and never the last word.
 * Whatever is trimmed stays readable in the full context checkpoint, whose path travels
 * with the text so the agent can open it instead of guessing what it missed.
 */
export function hookBody(delta, fullContextRel) {
  return fit(delta, fullContextRel, HOOK_DELTA_BYTES, "[trimmed to fit this agent's hook output]");
}

/** The same rule for the other road, against a limit the operating system sets. */
export function promptBody(delta, fullContextRel) {
  return fit(delta, fullContextRel, PROMPT_DELTA_BYTES, "[trimmed to fit a command-line prompt]");
}

/**
 * The line delivery adds to every delta that has a full context file beside it.
 *
 * It is exported because nobody upstream could see it. A delta was composed to
 * fill the road exactly, and then this was appended on the way out, so `fit`
 * trimmed the tail of a delta that had been built to fit. Since phase 3 the file
 * always exists, so the line is always added, and the overshoot was permanent
 * rather than occasional. Whoever decides how much a delta may weigh has to
 * subtract this, and asking for it beats each caller measuring a string that
 * lives here.
 */
export function untrimmedPointer(fullContextRel) {
  return fullContextRel ? `\n\nThe untrimmed version of this handoff is at ${fullContextRel}.` : "";
}

/**
 * What the launcher writes when the departing agent's last words cannot ride in
 * the delta.
 *
 * Here rather than in the launcher, because whoever composes the delta has to
 * leave room for it. The closing words themselves cannot be reserved, since
 * nobody knows yet what the agent will say or whether it will say anything. This
 * sentence can be, exactly, and reserving it is what makes it a guarantee: a
 * notice that gets trimmed away reports the loss to nobody, which is the failure
 * it exists to prevent.
 */
export function closingWordsNotice(displayName) {
  return (
    `\n\nClosing words from ${displayName} did not fit in this delta. ` +
    "They are whole in the full context checkpoint, and only there.\n"
  );
}

/**
 * How much a delta may weigh on disk and still survive delivery untouched.
 *
 * Two things are appended after composition and neither was subtracted before.
 * Delivery adds the pointer above, always, since the full context file always
 * exists now. And the launcher may add the notice above once the departing agent
 * finishes its turn. Compose against the road itself and both overflow it.
 */
export function deliverableBudget(road, fullContextRel, displayName = null) {
  return (
    road -
    Buffer.byteLength(untrimmedPointer(fullContextRel)) -
    (displayName ? Buffer.byteLength(closingWordsNotice(displayName)) : 0)
  );
}

function fit(delta, fullContextRel, limit, markerText) {
  const pointer = untrimmedPointer(fullContextRel);
  if (Buffer.byteLength(delta) + Buffer.byteLength(pointer) <= limit) return delta + pointer;

  // Everything that will still be there after the cut has to come out of the
  // budget, or the trimmed result ends up larger than the untrimmed limit. A
  // test caught exactly that.
  const marker = `\n\n${markerText}`;
  const budget = limit - Buffer.byteLength(pointer) - Buffer.byteLength(marker);
  // Cut on a line boundary so the text does not end mid-sentence.
  let cut = Buffer.from(delta).subarray(0, budget).toString("utf8");
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > budget / 2) cut = cut.slice(0, lastBreak);
  return `${cut}${marker}${pointer}`;
}

/** The full context checkpoint written beside a delta, if it is still on disk. */
export function fullContextFor(projectDir, deltaRel) {
  if (!deltaRel) return null;
  const fullContextRel = deltaRel.replace(new RegExp(`${CHECKPOINT_KINDS.delta.replace(".", "\\.")}$`), CHECKPOINT_KINDS.fullContext);
  return fs.existsSync(path.join(projectDir, fullContextRel)) ? fullContextRel : null;
}

/**
 * Was a pending delta actually taken? Consuming renames the file, so the name on
 * disk is the truth even when state and a hook raced each other to write it.
 */
export function deltaWasConsumed(projectDir, injection) {
  if (!injection?.deltaFile) return true;
  const delta = path.join(projectDir, injection.deltaFile);
  if (fs.existsSync(`${delta}${CONSUMED_SUFFIX}`)) return true;
  return !fs.existsSync(delta);
}
