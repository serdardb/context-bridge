import assert from "node:assert/strict";
import test from "node:test";
import { defaultFixtures, evaluateFixture, evaluateArtifacts, runEvaluation } from "../src/eval.mjs";
import { composeDelta, composeFullContext } from "../src/delta.mjs";

test("facts in the transcript cannot stand in for facts required in the summary", () => {
  const fixture = defaultFixtures()[0];
  fixture.expected.summary = [fixture.sections.conversation[0].text];
  const result = evaluateFixture(fixture);
  assert.equal(result.layers.summary.passed, false);
  assert.equal(result.layers.transcript.passed, true);
  assert.equal(result.layers.checkpoint.passed, true);
  assert.equal(result.passed, false);
});

test("a correct delta cannot conceal a truncated evidence checkpoint", () => {
  const fixture = defaultFixtures()[0];
  const delta = composeDelta(fixture.sections, 8192);
  const complete = composeFullContext(fixture.sections);
  const fullContext = complete.replace(fixture.sections.conversation[0].text, "truncated");
  const result = evaluateArtifacts(fixture, { delta, fullContext });
  assert.equal(result.layers.summary.passed, true);
  assert.equal(result.layers.transcript.passed, true);
  assert.equal(result.layers.checkpoint.passed, false);
  assert.equal(result.passed, false);
});

test("evaluation counts and validates every conversation source", () => {
  const fixture = defaultFixtures()[0];
  fixture.sections.sources = [
    { label: "First", messages: [{ role: "assistant", text: "first evidence" }] },
    { label: "Second", messages: [{ role: "assistant", text: "second evidence" }] },
  ];
  fixture.expected.messages = ["first evidence", "second evidence"];
  const result = evaluateFixture(fixture);
  assert.equal(result.passed, true);
  assert.equal(result.kept, 2);
  assert.equal(result.layers.transcript.checks, 2);
  assert.equal(result.layers.checkpoint.checks, 3);
});

test("deterministic context evaluation fixtures pass", () => {
  const report = runEvaluation();
  assert.equal(report.passed, true);
  assert.equal(report.total, 3);
  assert.ok(report.results.every((result) => result.metrics.length >= 4));
});

test("context evaluation fails when a required decision is absent", () => {
  const fixture = defaultFixtures()[0];
  fixture.expected.decisions = ["a decision that is not present"];
  const result = evaluateFixture(fixture);
  assert.equal(result.passed, false);
  assert.ok(result.metrics.some((m) => m.name === "decision-preserved" && !m.passed));
});
