import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { adapterFor } from "./agents/index.mjs";
import { composeDelta } from "./delta.mjs";
import { promptBody, PROMPT_DELTA_BYTES } from "./delivery.mjs";
import { liveDecisionFixture } from "./decision-eval.mjs";

export function liveRecallFixture() {
  const value = () => randomUUID();
  const expected = { project: value(), decision: value(), reason: value(), next: value(), owner: null };
  const summary = `Current project code: ${expected.project}. Selected option code: ${expected.decision}. ` +
    `Reason code: ${expected.reason}. Next action code: ${expected.next}. No owner was assigned.`;
  const delta = composeDelta({ fromAgent: "claude", summary,
    conversation: [{ role: "user", text: `Superseded option code: ${value()}. Do not use that option.` }],
    decisions: [], work: [], next: [],
  }, PROMPT_DELTA_BYTES);
  const body = promptBody(delta);
  const prompt = "This is a synthetic context-recall evaluation, not a coding task. Do not use tools.\n" +
    body + "\nReturn only one JSON object with keys project, decision, reason, next, owner. " +
    "Use the current project code, selected option code, reason code, next action code and assigned owner " +
    "from the context. Use null for information that was not provided. Do not repeat the context.";
  return { expected, prompt, contextBytes: Buffer.byteLength(body) };
}

export function scoreLiveRecall(expected, answer) {
  let parsed;
  try { parsed = JSON.parse(answer); } catch {}
  const valid = parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
    Object.keys(parsed).length === Object.keys(expected).length;
  const checks = Object.entries(expected).map(([name, value]) => ({ name, passed: Boolean(valid && parsed[name] === value) }));
  return { passed: checks.every((check) => check.passed), checks,
    satisfied: checks.filter((check) => check.passed).length, total: checks.length };
}

function runChild(command, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command.cmd, command.args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
    let timedOut = false;
    let error = null;
    let telemetry = "";
    let telemetryBytes = 0;
    let telemetryTruncated = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      telemetryBytes += Buffer.byteLength(chunk);
      if (telemetryBytes <= 1024 * 1024) telemetry += chunk;
      else { telemetryTruncated = true; telemetry = ""; }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("error", (err) => { error = err.code ?? "spawn failed"; });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, timedOut, error, telemetry, telemetryTruncated });
    });
  });
}

/** Explicitly opt-in: calls a provider with synthetic data, never project files. */
export async function runLiveEvaluation(agent, { timeoutMs = 60000, scenario = "recall" } = {}) {
  if (!["recall", "decision"].includes(scenario)) throw new Error("Live evaluation scenario must be recall or decision.");
  const adapter = adapterFor(agent);
  if (!adapter?.evaluationCommand) throw new Error(`Live recall evaluation is not supported for ${agent}. Supported: codex.`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error("Invalid live evaluation timeout.");
  const fixture = scenario === "decision" ? liveDecisionFixture() : liveRecallFixture();
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-live-eval-")));
  const response = path.join(cwd, "answer.json");
  const env = { ...process.env, CONTEXT_BRIDGE_HOME: path.join(cwd, "runtime") };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "OPENCODE_SESSION_ID",
    "CONTEXT_BRIDGE_LAUNCHER", "CONTEXT_BRIDGE_LANE", "CONTEXT_BRIDGE_STORAGE"]) delete env[key];
  const started = Date.now();
  try {
    const { telemetry, telemetryTruncated, ...outcome } = await runChild(adapter.evaluationCommand(fixture.prompt, response), cwd, env, timeoutMs);
    const tokens = !telemetryTruncated && outcome.status === 0 && !outcome.timedOut
      ? adapter.evaluationUsage?.(telemetry) ?? null : null;
    let answer = "";
    if (outcome.status === 0 && !outcome.error && !outcome.timedOut) {
      try {
        const info = fs.lstatSync(response);
        if (info.isFile() && info.size <= 64 * 1024) answer = fs.readFileSync(response, "utf8");
      } catch {}
    }
    const score = scoreLiveRecall(fixture.expected, answer);
    return { mode: `live-${scenario}`, scenario, variant: fixture.variant ?? null, agent, passed: score.passed && outcome.status === 0 && !outcome.timedOut,
      scope: fixture.scope ?? "synthetic fresh-session prompt recall; not a native handoff or semantic-quality proof",
      durationMs: Date.now() - started, contextBytes: fixture.contextBytes,
      promptBytes: Buffer.byteLength(fixture.prompt), responseBytes: Buffer.byteLength(answer),
      efficiency: {
        contextBytesPerCorrectField: score.satisfied ? fixture.contextBytes / score.satisfied : null,
        wholeTurnInputTokensPerCorrectField: score.satisfied && tokens ? tokens.input / score.satisfied : null,
      },
      tokens, telemetryTruncated, outcome, recall: score };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}
