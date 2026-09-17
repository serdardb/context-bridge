import { composeDelta, composeFullContext, messageBlock, planDelta } from "./delta.mjs";

const DEFAULT_BUDGET = 8 * 1024;

function contains(text, value) {
  return typeof value === "string" && value.length > 0 && text.includes(value);
}

function metric(name, passed, detail) {
  return { name, passed: Boolean(passed), detail };
}

/**
 * Evaluate a deterministic handoff fixture. This is intentionally mechanical:
 * it does not pretend a keyword score is semantic understanding, but it catches
 * regressions in the delivery contract before a live-agent run is attempted.
 */
export function evaluateFixture(fixture) {
  const budget = fixture.budget ?? DEFAULT_BUDGET;
  const sections = { ...fixture.sections, summaryBudget: fixture.summaryBudget ?? budget };
  const delta = composeDelta(sections, budget);
  const fullContext = composeFullContext({ decisions: [], work: [], next: [], ...sections });
  return evaluateArtifacts(fixture, { delta, fullContext });
}

/** Score the actual produced artifacts, not only the composer's selection plan. */
export function evaluateArtifacts(fixture, { delta, fullContext }) {
  const budget = fixture.budget ?? DEFAULT_BUDGET;
  const sections = { ...fixture.sections, summaryBudget: fixture.summaryBudget ?? budget };
  const plans = planDelta(sections, budget);
  const kept = plans.flatMap((plan) => plan.kept);
  const omitted = plans.reduce((sum, plan) => sum + plan.omitted, 0);
  const expected = fixture.expected ?? {};
  const metrics = [];
  const summary = String(sections.summary ?? "").trim();
  const summaryLabelledMissing = delta.includes("No agent-written summary was available");
  metrics.push(metric(
    "summary-present-or-labelled",
    summary ? delta.includes(summary) : summaryLabelledMissing,
    summary ? "the complete agent-written summary is present" : "missing summary is explicitly labelled"
  ));
  for (const value of expected.decisions ?? []) {
    metrics.push(metric("decision-preserved", contains(delta, value), value));
  }
  for (const value of expected.next ?? []) {
    metrics.push(metric("next-step-preserved", contains(delta, value), value));
  }
  for (const value of expected.messages ?? []) {
    metrics.push(metric("required-message-carried", plans.some((plan) => plan.kept.some((message) =>
      message.text === value && delta.includes(messageBlock(message, plan.label)))), value));
  }
  const omissionExpected = expected.omission ?? omitted > 0;
  const omissionVisible = delta.includes("not included in this delta preview") || delta.includes("could be carried");
  metrics.push(metric("omission-disclosed", omissionExpected ? omissionVisible : !omissionVisible, omissionExpected ? "omitted messages are disclosed" : "no false omission notice"));
  metrics.push(metric("within-road-budget", Buffer.byteLength(delta) <= budget, `${Buffer.byteLength(delta)} / ${budget} bytes`));
  const layers = { summary: [], transcript: [], checkpoint: [] };
  for (const fact of expected.summary ?? []) {
    layers.summary.push(metric("summary-fact-preserved", contains(summary, fact) && contains(delta, summary), fact));
  }
  const sources = sections.sources?.length ? sections.sources.map((source) => source.messages ?? []) : [sections.conversation ?? []];
  plans.forEach((plan, index) => {
    for (const message of plan.kept) layers.transcript.push(metric("selected-message-whole",
      delta.includes(messageBlock(message, plan.label)), `${plan.label}: ${message.text.slice(0, 80)}`));
    for (const message of sources[index]) layers.checkpoint.push(metric("source-message-whole",
      fullContext.includes(messageBlock(message, plan.label)), `${plan.label}: ${message.text.slice(0, 80)}`));
  });
  layers.summary.push(metric("summary-present-or-labelled", summary ? delta.includes(summary) : summaryLabelledMissing,
    summary ? "complete summary" : "explicit missing-summary label"));
  layers.checkpoint.push(metric("checkpoint-summary-preserved", summary ? fullContext.includes(summary) :
    fullContext.includes("No agent-written summary was available"), "summary or missing-summary label in full context"));
  metrics.push(...Object.entries(layers).flatMap(([layer, values]) => values.map((value) => ({ ...value, layer }))));
  const passed = metrics.every((m) => m.passed);
  return {
    id: fixture.id,
    passed,
    bytes: Buffer.byteLength(delta),
    budget,
    kept: kept.length,
    omitted,
    layers: Object.fromEntries(Object.entries(layers).map(([layer, values]) => [layer, {
      passed: values.every((value) => value.passed), checks: values.length,
      satisfied: values.filter((value) => value.passed).length,
    }])),
    checkpointBytes: Buffer.byteLength(fullContext),
    metrics,
  };
}

export function defaultFixtures() {
  return [
    {
      id: "summary-and-recent-context",
      sections: {
        fromAgent: "codex",
        summary: "The storage provider is global and Git is optional. Next, verify migration.",
        conversation: [
          { role: "assistant", text: "The migration preserves the old state and creates a recoverable backup." },
          { role: "user", text: "Verify migration." },
        ],
        decisions: ["Use global storage."],
        work: ["src/storage.mjs changed"],
        next: ["Verify migration."],
      },
      expected: {
        summary: ["Git is optional", "verify migration"],
        decisions: ["Use global storage."],
        next: ["Verify migration."],
        messages: ["The migration preserves the old state and creates a recoverable backup."],
        omission: false,
      },
    },
    {
      id: "overflow-is-explicit",
      sections: {
        fromAgent: "claude",
        summary: "The summary is deliberately short.",
        conversation: Array.from({ length: 18 }, (_, i) => ({ role: "assistant", text: `message-${i} ` + "x".repeat(500) })),
        decisions: [],
        work: [],
        next: [],
      },
      expected: { messages: ["message-17 " + "x".repeat(500)], omission: true },
    },
    {
      id: "recovery-without-summary",
      sections: {
        fromAgent: "codex",
        conversation: [{ role: "assistant", text: "The process stopped before a summary could be written." }],
        decisions: [],
        work: [],
        next: [],
      },
      expected: { messages: ["The process stopped before a summary could be written."], omission: false },
    },
  ];
}

export function runEvaluation(fixtures = defaultFixtures()) {
  const results = fixtures.map(evaluateFixture);
  return { passed: results.every((r) => r.passed), total: results.length, results };
}
