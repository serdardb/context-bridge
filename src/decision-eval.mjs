import { randomInt, randomUUID } from "node:crypto";
import { composeDelta, summaryBudgetFor, checkSummaryFits } from "./delta.mjs";
import { hookBody, HOOK_DELTA_BYTES } from "./delivery.mjs";

function alternatives(descriptions) {
  const values = descriptions.map((description) => ({ code: randomUUID(), description }));
  const correct = values[0].code;
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return { correct, values };
}

// Choices paraphrase the causal relationship; answer codes never appear in
// the source record. This is a bounded assessment, not an LLM judge.
export function liveDecisionFixture({ variant = randomInt(2) === 0 ? "immediate-revocation" : "stable-permissions" } = {}) {
  if (!["immediate-revocation", "stable-permissions"].includes(variant)) throw new Error("Unknown decision fixture variant.");
  const revoke = variant === "immediate-revocation";
  const decision = alternatives(revoke ? [
    "Obtain a fresh authorization decision for every operation.",
    "Reuse the last authorization decision for ten minutes.",
    "Allow every operation without checking authorization.",
  ] : [
    "Reuse the last authorization decision for ten minutes.",
    "Obtain a fresh authorization decision for every operation.",
    "Allow every operation without checking authorization.",
  ]);
  const reason = alternatives(revoke ? [
    "A revoked credential must lose access immediately, including during service outages.",
    "Repeated checks are expensive but permissions cannot change during the reuse window.",
    "The team prefers fewer source files regardless of behavior.",
  ] : [
    "Repeated checks are expensive but permissions cannot change during the reuse window.",
    "A revoked credential must lose access immediately, including during service outages.",
    "The team prefers fewer source files regardless of behavior.",
  ]);
  const next = alternatives(revoke ? [
    "Test that revocation denies the next operation even when the authorization service is unavailable.",
    "Publish the feature immediately because design approval proves production correctness.",
    "Benchmark reuse while assuming an unavailable service grants access.",
  ] : [
    "Verify reuse stops at the ten-minute expiry and cannot leak decisions between accounts.",
    "Publish the feature immediately because design approval proves production correctness.",
    "Remove the expiry check because decisions never need refreshing.",
  ]);
  const rejected = alternatives(revoke ? [
    "The earlier proposal to reuse authorization for ten minutes.",
    "The requirement to deny access after revocation.",
    "All future performance measurements.",
  ] : [
    "The earlier proposal to contact authorization on every operation.",
    "The requirement to keep different accounts isolated.",
    "All future performance measurements.",
  ]);
  const summary = revoke
    ? "Final design: consult authorization anew for each operation and deny access if it is unreachable. " +
      "Credential withdrawal must take effect on the very next operation; an old allow decision could violate that. " +
      "The proposed ten-minute reuse was therefore rejected. Before shipping, exercise withdrawal followed by an outage. No person has been assigned that check."
    : "Final design: retain each account's authorization result for at most ten minutes. " +
      "The contract guarantees permissions cannot change within that interval, while remote checks are costly. " +
      "The proposal to contact authorization on every operation was therefore rejected. Before shipping, verify expiration and account separation. No person has been assigned that check.";
  const conversation = Array.from({ length: 20 }, (_, i) => ({ role: "assistant",
    text: `Earlier investigation ${i}: ` + "This is an intermediate observation, not the approved final design. ".repeat(20) }));
  conversation.push({ role: "assistant", text: revoke
    ? "Earlier proposal: reuse a successful authorization decision for ten minutes to reduce latency."
    : "Earlier proposal: contact authorization on every operation, regardless of service cost." });
  const sections = { fromAgent: "claude", conversation, decisions: [], work: [], next: [] };
  const budget = summaryBudgetFor(sections, HOOK_DELTA_BYTES);
  const expected = { decision: decision.correct, reason: reason.correct, rejected: rejected.correct,
    next: next.correct, owner: null, completeTranscript: false };
  const assessment =
    "\nSelect the option code whose meaning matches the FINAL decision, its rationale, the rejected proposal, and the required next check. " +
    "Historical proposals are not current decisions. Return only JSON with keys decision, reason, rejected, next, owner, completeTranscript. " +
    "Use null for an unassigned owner; completeTranscript is a boolean indicating whether every source message was delivered inline.\n" +
    JSON.stringify({ decision: decision.values, reason: reason.values, rejected: rejected.values, next: next.values });
  const assessSummary = (text) => {
    checkSummaryFits(text, budget);
    const body = hookBody(composeDelta({ ...sections, summary: text }, HOOK_DELTA_BYTES));
    return { expected, prompt: "Synthetic handoff assessment. Do not use tools or change files.\n" + body + assessment,
      contextBytes: Buffer.byteLength(body), variant,
      scope: "synthetic constrained-choice decision/rationale/next-step and omission assessment; not a native hook delivery or general semantic-quality proof" };
  };
  const source = [
    { role: "assistant", text: conversation.at(-1).text },
    { role: "user", text: revoke
      ? "Constraint: credentials may be withdrawn at any instant. Withdrawal must deny the very next operation, even during an authorization outage."
      : "Constraint: permissions are contractually fixed for ten minutes after a check. Remote authorization calls are costly. Accounts must remain isolated." },
    { role: "assistant", text: revoke
      ? "Then cached success can incorrectly admit a revoked credential. I propose a fresh check each time and denial when the service is unavailable."
      : "Then per-operation calls add cost without changing authorization within the guaranteed window. I propose per-account reuse with a strict ten-minute expiry." },
    { role: "user", text: revoke
      ? "Approved. Reject the ten-minute cache proposal. Before release, test withdrawal followed by an authorization outage. No owner has been assigned."
      : "Approved. Reject the per-operation remote-check proposal. Before release, test expiry and separation between accounts. No owner has been assigned." },
  ];
  const generationPrompt = "Synthetic handoff-writing exercise. Do not use tools or change files. " +
    "Write only a concise handoff summary from the conversation below. Preserve the final decision, its stated justification, " +
    "the rejected alternative, the next required check and any unassigned ownership. Do not invent facts or treat approval as test evidence. " +
    `Keep the summary within ${budget} UTF-8 bytes.\n` + JSON.stringify(source);
  return { ...assessSummary(summary), generationPrompt, assessSummary };
}
