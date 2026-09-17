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
  for (const empty of [false, true]) {
    const fixture = defaultFixtures()[1];
    if (empty) fixture.sections.conversation = [{ role: "assistant", text: "x".repeat(9000) }];
    const delta = composeDelta(fixture.sections, 8192);
    const fullContext = composeFullContext(fixture.sections);
    fixture.expected.messages = [];
    assert.equal(evaluateArtifacts(fixture, { delta, fullContext }).passed, true);
    const wrongCount = empty ? delta.replace(/'s 1 new message/, "'s 999 new messages") :
      delta.replace(/\[\d+ earlier/, "[999 earlier");
    const wrongSource = delta.replace(/from Claude |of Claude's /, empty ? "of Other's " : "from Other ");
    const wrongTotal = empty ? wrongCount : delta.replace(/out of \d+ new/, "out of 999 new");
    const duplicated = delta + "\n" + delta.split("\n").find((line) => /^(?:\[None of |\[\d+ earlier )/.test(line));
    for (const damaged of [wrongCount, wrongTotal, wrongSource, duplicated]) {
      assert.notEqual(damaged, delta);
      const result = evaluateArtifacts(fixture, { delta: damaged, fullContext });
      assert.equal(result.passed, false);
      assert.ok(result.metrics.some((metric) => metric.name === "omission-counts-correct" && !metric.passed));
    }
  }
});

test("context evaluation fails when a required decision is absent", () => {
  const fixture = defaultFixtures()[0];
  fixture.expected.decisions = ["a decision that is not present"];
  const result = evaluateFixture(fixture);
  assert.equal(result.passed, false);
  assert.ok(result.metrics.some((m) => m.name === "decision-preserved" && !m.passed));
});
