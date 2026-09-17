import { fileURLToPath } from "node:url";
import { aiderSessionRef, aiderSessionsForProject, aiderStartedSessions } from "./aider-sessions.mjs";
import { readAiderHistory, readAiderEvidence, aiderMark, aiderActivity } from "./aider-records.mjs";
import { resolveAiderRuntime } from "./aider-runtime.mjs";
import { AdapterResultError } from "../adapter-contract.mjs";
import { isBridgeProtocolNoise } from "../delta.mjs";

export const id = "aider";
export const displayName = "Aider";
export const injection = "prompt";
export const conflictFlags = [
  { flags: ["--chat-history-file", "--input-history-file", "--llm-history-file", "--message", "-m", "--message-file", "--load", "--apply"], value: "required", why: "bridge owns history and the incoming interactive turn" },
  { flags: ["--restore-chat-history", "--no-restore-chat-history", "--exit", "--gui", "--browser", "--version", "--help", "-h", "--just-check-update", "--upgrade", "--update", "--commit", "--lint", "--test"], value: "none", why: "changes the controlled interactive lifecycle" },
];
const entry = fileURLToPath(new URL("aider-entry.mjs", import.meta.url));
const command = (mode, native) => ({ cmd: process.execPath, args: [entry, ...mode, "--native-args",
  JSON.stringify(native[0] === "--" ? native.slice(1) : native)] });
export const startCommand = (extra = []) => command(["--new"], extra);
export const resumeCommand = (ref, extra = []) => {
  if (!ref?.id) throw new Error("Aider resume requires a linked session.");
  return command(["--session", ref.id], extra);
};
export const promptArgs = (delta) => ["--prompt", delta];
export const smokeCommand = () => command(["--smoke"], []);
export const detectHost = () => null;
export const discover = (projectDir) => aiderSessionsForProject(projectDir)[0] ?? null;
export const adoptStartedSession = aiderStartedSessions;
export function refById(projectDir, sessionId) {
  try { return aiderSessionRef(projectDir, sessionId); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export const hydrate = (projectDir, slot) => slot?.id ? refById(projectDir, slot.id) : null;

function read(ref) {
  const history = readAiderHistory(ref.transcriptPath, { allowEmpty: true });
  const evidence = readAiderEvidence(ref.eventsPath, history, { sessionId: ref.id, projectId: ref.projectId });
  return { history, evidence };
}
export function currentMark(ref) {
  const { history, evidence } = read(ref);
  return aiderMark(history, evidence);
}
export function activitySince(ref, mark) {
  try {
    const { history, evidence } = read(ref);
    const activity = aiderActivity(history, evidence, mark);
    activity.messages = activity.messages.filter((message) => message.role !== "user" || !isBridgeProtocolNoise(message.text));
    if (activity.unobservedText) activity.messages.push({ role: "assistant", at: null,
      text: "[Aider unobserved native transcript fragment; speaker boundaries and completion are unverified]\n" + activity.unobservedText });
    return activity;
  } catch { throw new AdapterResultError(id, "activitySince"); }
}
export function idleAfter(ref, sinceIso) {
  const { history, evidence } = read(ref);
  const last = evidence.rows.at(-1);
  return Boolean(last && !evidence.incompleteTail && last.history.bytes === history.bytes.length &&
    (!sinceIso || Date.parse(last.at) >= Date.parse(sinceIso)));
}
export function parseProbe(ref) {
  try {
    const { history, evidence } = read(ref);
    return { status: evidence.incompleteTail ? "partial" : "readable", rows: evidence.rows.length + 1,
      known: evidence.rows.length + 1, malformed: evidence.incompleteTail ? 1 : 0,
      messages: aiderActivity(history, evidence).messages.length };
  } catch (error) { return { status: error.code === "ENOENT" ? "missing" : "mismatch", rows: 0, known: 0, malformed: 0 }; }
}
export function discoveryProbe(projectDir = process.cwd()) {
  const sessions = aiderSessionsForProject(projectDir);
  return { status: sessions.length ? "readable" : "none", examined: sessions.length, recognised: sessions.length };
}
export function health() {
  let runtime;
  try { runtime = resolveAiderRuntime(); } catch {}
  return { version: runtime?.sdkVersion ?? null, ready: false,
    auth: { ok: false, via: "provider authentication is not inferred from an installed SDK", account: null },
    extras: [{ ok: Boolean(runtime), label: "Compatible isolated Aider Python runtime" }],
    installHint: "Configure a trusted aider-chat 0.86.2 Python 3.10-3.12 environment and set CONTEXT_BRIDGE_AIDER_PYTHON to its absolute interpreter path." };
}
export const capabilities = Object.fromEntries(["commands", "commandArgs", "outcome", "exitCode", "duration",
  "filesRead", "filesChanged", "toolOutput", "reasoning", "tokenUsage", "pairing"].map((key) => [key, false]));
export const observeAudit = () => ({ ...capabilities });
export function auditSince(ref, mark) {
  const activity = activitySince(ref, mark);
  return { commands: [], filesRead: [], filesChanged: [], dropped: 0, sourceComplete: activity.sourceComplete };
}
