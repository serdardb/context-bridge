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
 * Codex caps that output and degrades gracefully past it, writing the full text
 * to a file and showing the model a preview with the path. Rather than encode
 * somebody's token arithmetic, this is a deliberately smaller byte budget with
 * the companion file named alongside it, so the agent always has a way to read
 * the rest.
 */
export const HOOK_DELTA_BYTES = 4 * 1024;

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
 * companion file, whose path travels with the text.
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
 * Whatever is trimmed stays readable in the companion file, whose path travels
 * with the text so the agent can open it instead of guessing what it missed.
 */
export function hookBody(delta, companionRel) {
  return fit(delta, companionRel, HOOK_DELTA_BYTES, "[trimmed to fit this agent's hook output]");
}

/** The same rule for the other road, against a limit the operating system sets. */
export function promptBody(delta, companionRel) {
  return fit(delta, companionRel, PROMPT_DELTA_BYTES, "[trimmed to fit a command-line prompt]");
}

function fit(delta, companionRel, limit, markerText) {
  const pointer = companionRel ? `\n\nThe untrimmed version of this handoff is at ${companionRel}.` : "";
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

/** The companion that was written beside a delta, if it is still on disk. */
export function companionFor(projectDir, deltaRel) {
  if (!deltaRel) return null;
  const companionRel = deltaRel.replace(new RegExp(`${CHECKPOINT_KINDS.delta.replace(".", "\\.")}$`), CHECKPOINT_KINDS.companion);
  return fs.existsSync(path.join(projectDir, companionRel)) ? companionRel : null;
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
