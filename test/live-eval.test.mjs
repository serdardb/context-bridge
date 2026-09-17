import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { liveRecallFixture, scoreLiveRecall, runLiveEvaluation } from "../src/live-eval.mjs";
import { evaluationUsage } from "../src/agents/codex.mjs";

test("token accounting requires valid vendor completion events, not prompt byte estimates", () => {
  const event = { type: "turn.completed", usage: { input_tokens: 15400, cached_input_tokens: 11520, output_tokens: 5 } };
  assert.deepEqual(evaluationUsage(JSON.stringify(event)), {
    source: "codex-turn.completed", scope: "whole-agent-turns", input: 15400, cachedInput: 11520, output: 5, turns: 1,
  });
  assert.equal(evaluationUsage([event, event].map((value) => JSON.stringify(value)).join("\n")).input, 30800);
  assert.equal(evaluationUsage(JSON.stringify({ type: "item.completed", text: JSON.stringify(event) })), null);
  assert.equal(evaluationUsage("not json"), null);
  assert.equal(evaluationUsage(""), null);
  for (const patch of [{ input_tokens: -1 }, { input_tokens: 0.5 }, { output_tokens: "5" },
    { cached_input_tokens: 15401 }, { output_tokens: null }]) {
    assert.equal(evaluationUsage(JSON.stringify({ ...event, usage: { ...event.usage, ...patch } })), null);
  }
});

test("live recall scoring requires every current value and explicitly unknown owner", () => {
  const { expected, prompt } = liveRecallFixture();
  assert.equal(scoreLiveRecall(expected, JSON.stringify(expected)).passed, true);
  assert.equal(scoreLiveRecall(expected, prompt).passed, false, "echoing the prompt is not answering");
  for (const key of Object.keys(expected)) {
    assert.equal(scoreLiveRecall(expected, JSON.stringify({ ...expected, [key]: "wrong" })).passed, false);
    const missing = { ...expected };
    delete missing[key];
    assert.equal(scoreLiveRecall(expected, JSON.stringify(missing)).passed, false);
  }
  assert.equal(scoreLiveRecall(expected, JSON.stringify({ ...expected, extra: true })).passed, false);
  assert.notDeepEqual(liveRecallFixture().expected, expected);
});

test("live eval executes a real child, reads only the final response and cleans its workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-live-eval-test-"));
  const oldPath = process.env.PATH;
  const oldMode = process.env.BRIDGE_TEST_EVAL_MODE;
  const oldLog = process.env.BRIDGE_TEST_EVAL_LOG;
  const log = path.join(dir, "invocation.json");
  try {
    const fake = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args.at(-1);
fs.writeFileSync(process.env.BRIDGE_TEST_EVAL_LOG, JSON.stringify({cwd:process.cwd(), args, home:process.env.CONTEXT_BRIDGE_HOME}));
if (process.env.BRIDGE_TEST_EVAL_MODE.startsWith("summary")) {
  fs.appendFileSync(process.env.BRIDGE_TEST_EVAL_LOG + ".calls", "call\\n");
  const output=args[args.indexOf("--output-last-message") + 1];
  if (prompt.startsWith("Synthetic handoff-writing")) {
    const mode=process.env.BRIDGE_TEST_EVAL_MODE;
    fs.writeFileSync(output, mode === "summary-empty" ? "" : mode === "summary-large" ? "x".repeat(9000)
      : prompt.includes("credentials may be withdrawn") ? "SYNTHETIC-SELECT-FRESH" : "SYNTHETIC-SELECT-REUSE");
  } else {
    if (!prompt.includes("SYNTHETIC-SELECT-")) process.exit(5);
    const options=JSON.parse(prompt.slice(prompt.lastIndexOf("\\n")+1));
    const fresh=prompt.includes("SYNTHETIC-SELECT-FRESH");
    const patterns=fresh ? {decision:/fresh authorization/,reason:/revoked credential/,rejected:/reuse authorization/,next:/revocation denies/}
      : {decision:/Reuse/,reason:/Repeated checks/,rejected:/every operation/,next:/reuse stops/};
    const answer={owner:null,completeTranscript:false};
    for(const [key,re] of Object.entries(patterns)) answer[key]=options[key].find(item=>re.test(item.description)).code;
    fs.writeFileSync(output,JSON.stringify(answer));
  }
}
else if (process.env.BRIDGE_TEST_EVAL_MODE === "hang") { setInterval(() => {}, 1000); }
else {
  const answer = {project:prompt.match(/Current project code: ([^.]+)/)[1],
    decision:prompt.match(/Selected option code: ([^.]+)/)[1],
    reason:prompt.match(/Reason code: ([^.]+)/)[1],
    next:prompt.match(/Next action code: ([^.]+)/)[1], owner:null};
  console.log(JSON.stringify(answer));
  if (process.env.BRIDGE_TEST_EVAL_MODE === "usage") console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:200,cached_input_tokens:100,output_tokens:40}}));
  if (process.env.BRIDGE_TEST_EVAL_MODE === "overflow") console.log("x".repeat(1024*1024));
  if (process.env.BRIDGE_TEST_EVAL_MODE !== "stdout-only") {
    if (process.env.BRIDGE_TEST_EVAL_MODE === "wrong") answer.reason = "incorrect";
    fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(answer));
  }
  if (process.env.BRIDGE_TEST_EVAL_MODE === "failed") process.exitCode = 1;
}
`;
    fs.writeFileSync(path.join(dir, "codex"), fake, { mode: 0o700 });
    process.env.PATH = dir;
    process.env.BRIDGE_TEST_EVAL_LOG = log;
    for (const mode of ["good", "usage", "overflow", "stdout-only", "wrong", "failed", "hang"]) {
      process.env.BRIDGE_TEST_EVAL_MODE = mode;
      const report = await runLiveEvaluation("codex", { timeoutMs: mode === "hang" ? 1000 : 5000 });
      assert.equal(report.passed, ["good", "usage", "overflow"].includes(mode), mode);
      assert.equal(report.outcome.timedOut, mode === "hang");
      if (mode === "usage") {
        assert.equal(report.tokens.input, 200);
        assert.equal(report.efficiency.wholeTurnInputTokensPerCorrectField, 40);
      }
      else assert.equal(report.tokens, null);
      assert.equal(report.telemetryTruncated, mode === "overflow");
      const invocation = JSON.parse(fs.readFileSync(log));
      assert.equal(fs.existsSync(invocation.cwd), false);
      assert.equal(path.dirname(invocation.home), invocation.cwd);
      assert.ok(invocation.args.includes("--ephemeral"));
      assert.ok(invocation.args.includes("read-only"));
    }
    process.env.BRIDGE_TEST_EVAL_MODE = "good";
    for (const mode of ["summary-good", "summary-empty", "summary-large"]) {
      process.env.BRIDGE_TEST_EVAL_MODE = mode;
      fs.rmSync(log + ".calls", { force: true });
      const report = await runLiveEvaluation("codex", { scenario: "summary", timeoutMs: 5000 });
      assert.equal(report.passed, mode === "summary-good");
      assert.equal(fs.readFileSync(log + ".calls", "utf8").trim().split("\n").length, mode === "summary-good" ? 2 : 1);
      assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(log)).cwd), false);
      assert.equal(JSON.stringify(report).includes("SYNTHETIC-SELECT"), false);
    }
    process.env.BRIDGE_TEST_EVAL_MODE = "good";
    const cli = spawnSync(process.execPath, [path.resolve("bin/bridge.mjs"), "eval", "--live", "codex", "--json"], {
      cwd: dir, env: process.env, encoding: "utf8", timeout: 10000,
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).recall.satisfied, 5);
    fs.unlinkSync(log);
    for (const args of [["eval", "--scenario", "decision"],
      ["eval", "--live", "codex", "--scenario", "invalid"],
      ["eval", "--live", "codex", "--scenario"]]) {
      const refused = spawnSync(process.execPath, [path.resolve("bin/bridge.mjs"), ...args], {
        cwd: dir, env: process.env, encoding: "utf8", timeout: 10000,
      });
      assert.notEqual(refused.status, 0);
      assert.equal(fs.existsSync(log), false, "invalid scenario must not call the provider");
    }
    await assert.rejects(runLiveEvaluation("claude"), /not supported/);
    assert.equal(fs.existsSync(log), false);
  } finally {
    for (const [key, value] of [["PATH", oldPath], ["BRIDGE_TEST_EVAL_MODE", oldMode], ["BRIDGE_TEST_EVAL_LOG", oldLog]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
