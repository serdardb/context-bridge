import test from "node:test";
import assert from "node:assert/strict";
import { liveDecisionFixture } from "../src/decision-eval.mjs";
import { scoreLiveRecall, runLiveEvaluation } from "../src/live-eval.mjs";
import { HOOK_DELTA_BYTES } from "../src/delivery.mjs";

test("decision assessment distinguishes opposing policies, keeps the answer key out of the source, and rejects wrong reasons", async () => {
  for (const variant of ["immediate-revocation", "stable-permissions"]) {
    const fixture = liveDecisionFixture({ variant });
    const options = JSON.parse(fixture.prompt.slice(fixture.prompt.lastIndexOf('\n') + 1));
    const context = fixture.prompt.slice(0, fixture.prompt.lastIndexOf('\n'));
    assert.equal(fixture.variant, variant);
    assert.ok(fixture.contextBytes <= HOOK_DELTA_BYTES);
    assert.match(context, /not included in this delta preview/);
    assert.match(context, /Earlier proposal/);
    assert.equal(fixture.expected.completeTranscript, false);
    assert.equal(fixture.expected.owner, null);
    for (const key of ["decision", "reason", "rejected", "next"]) {
      assert.equal(context.includes(fixture.expected[key]), false, "the source cannot hand out answer codes");
      const choices = options[key];
      assert.equal(new Set(choices.map((choice) => choice.code)).size, 3);
      assert.equal(choices.filter((choice) => choice.code === fixture.expected[key]).length, 1);
      for (const wrong of choices.filter((choice) => choice.code !== fixture.expected[key])) {
        const score = scoreLiveRecall(fixture.expected, JSON.stringify({ ...fixture.expected, [key]: wrong.code }));
        assert.equal(score.passed, false);
        assert.equal(score.satisfied, 5);
      }
    }
    const chosen = options.decision.find((choice) => choice.code === fixture.expected.decision).description;
    assert.match(chosen, variant === "immediate-revocation" ? /fresh authorization/ : /Reuse/);
    assert.equal(scoreLiveRecall(fixture.expected, JSON.stringify(fixture.expected)).passed, true);
    assert.equal(scoreLiveRecall(fixture.expected, fixture.prompt).passed, false);
    assert.equal(scoreLiveRecall(fixture.expected, JSON.stringify({ ...fixture.expected, completeTranscript: true })).passed, false);
    assert.equal(scoreLiveRecall(fixture.expected, JSON.stringify({ ...fixture.expected, owner: "invented" })).passed, false);
    assert.notDeepEqual(liveDecisionFixture({ variant }).expected, fixture.expected);
  }
  await assert.rejects(runLiveEvaluation("codex", { scenario: "not-supported" }), /scenario must be/);
});
