import { piSessionsForProject, piSessionRef, piAgentDirectory } from "./pi-sessions.mjs";
import { readPiSession, piMark, piActivity, piAudit } from "./pi-records.mjs";
import { isBridgeProtocolNoise } from "../delta.mjs";
import path from "node:path";
import fs from "node:fs";
import { tryExec, REPO_ROOT, readJson } from "../util.mjs";
import { AdapterResultError } from "../adapter-contract.mjs";

export const id = "pi";
export const displayName = "Pi";
export const injection = "prompt";
export const conflictFlags = [
  { flags: ["--session", "--session-id", "--session-dir", "--fork"], value: "required", why: "bridge owns the selected native session" },
  { flags: ["--continue", "-c", "--resume", "-r", "--no-session"], value: "none", why: "changes or disables the linked session" },
  { flags: ["--mode", "--export"], value: "required", why: "replaces the interactive handoff transport" },
  { flags: ["--print", "-p"], value: "optional", why: "headless exit bypasses the interactive launcher lifecycle" },
];

export function discover(projectDir) {
  const result = piSessionsForProject(projectDir);
  if (result.examined && !result.sessions.length && result.unreadable) throw new Error("Pi session candidates could not be linked safely; inspect their project and schema.");
  return result.sessions[0] ?? null;
}
export function hydrate(projectDir, slot) {
  if (!slot?.id) return null;
  if (slot.transcriptPath) {
    try { return piSessionRef(projectDir, slot.transcriptPath, slot.id); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return refById(projectDir, slot.id);
}
export function refById(projectDir, sessionId) {
  return piSessionsForProject(projectDir).sessions.find((ref) => ref.id === sessionId) ?? null;
}
export function adoptStartedSession(projectDir, { startedAt } = {}) {
  if (!startedAt || !Number.isFinite(Date.parse(startedAt))) return [];
  return piSessionsForProject(projectDir).sessions.filter((ref) => Date.parse(ref.startedAt) >= Date.parse(startedAt));
}
export const detectHost = () => null;
export const bridgeSkillPath = () => path.join(REPO_ROOT, "codex", "SKILL.md");
// Pi resolves duplicate skill names first-wins. Carry the current protocol
// explicitly without disabling, replacing or installing the user's skills.
export function bridgeInstructions() {
  return "Context Bridge handoff protocol (conditional):\n" +
    "Apply the following instructions ONLY when the user requests a context-bridge handoff. " +
    "Otherwise continue the requested work; receiving context is not a request to hand off. " +
    "For that handoff, use this packaged protocol rather than a same-name bridge skill.\n\n" +
    fs.readFileSync(bridgeSkillPath(), "utf8");
}
export const startCommand = (extraArgs = []) => ({ cmd: "pi", args: ["--append-system-prompt", bridgeInstructions(), ...extraArgs] });
export function resumeCommand(ref, extraArgs = []) {
  if (!ref?.transcriptPath) throw new Error("Pi resume requires a verified session file.");
  return { cmd: "pi", args: ["--session", ref.transcriptPath, "--append-system-prompt", bridgeInstructions(), ...extraArgs] };
}
export const promptArgs = (delta) => ["--", delta];
export const currentMark = (ref) => piMark(readPiSession(ref.transcriptPath));
export function activitySince(ref, mark) {
  try { return readActivity(ref, mark); }
  catch { throw new AdapterResultError(id, "activitySince"); }
}
function readActivity(ref, mark) {
  const session = readPiSession(ref.transcriptPath);
  const result = piActivity(session, mark);
  result.messages = result.messages.filter((message) => message.role !== "user" || !isBridgeProtocolNoise(message.text));
  if (result.branchChanged) result.messages.unshift({ role: "assistant", at: null,
    text: "[Pi changed conversation branch since the last handoff. The following record reintroduces the current branch, not the abandoned one.]" });
  result.patchedFiles = piAudit(session, mark).filesChanged;
  return result;
}
export const auditSince = (ref, mark) => piAudit(readPiSession(ref.transcriptPath), mark);
export function idleAfter(ref, sinceIso) {
  const session = readPiSession(ref.transcriptPath);
  if (session.incompleteTail) return false;
  const last = [...session.branch].reverse().find((entry) => entry.type === "message");
  return Boolean(last?.message.role === "assistant" && ["stop", "length", "error", "aborted"].includes(last.message.stopReason) &&
    (!sinceIso || Date.parse(last.timestamp) >= Date.parse(sinceIso)));
}
export function parseProbe(ref) {
  try {
    const session = readPiSession(ref.transcriptPath);
    const activity = piActivity(session);
    return { status: session.incompleteTail ? "partial" : "readable", rows: session.records.length + 1,
      known: session.records.length + 1, malformed: session.incompleteTail ? 1 : 0, messages: activity.messages.length };
  } catch (error) { return { status: error.code === "ENOENT" ? "missing" : "mismatch", rows: 0, known: 0, malformed: 0 }; }
}
export function discoveryProbe(projectDir = process.cwd()) {
  const { sessions, examined } = piSessionsForProject(projectDir);
  return { status: !examined ? "none" : sessions.length ? "readable" : "blind", examined, recognised: sessions.length };
}
export function health() {
  const version = tryExec("pi", ["--version"]);
  const settings = { ...readJson(path.join(piAgentDirectory(), "settings.json")),
    ...readJson(path.join(process.cwd(), ".pi", "settings.json")) };
  const provider = typeof settings.defaultProvider === "string" && settings.defaultProvider.trim() ? settings.defaultProvider : null;
  let auth = null;
  if (version && provider) try { auth = JSON.parse(tryExec("pi", ["auth", "check", "--provider", provider, "--json", "--no-refresh"])); } catch {}
  return { version, ready: Boolean(version && auth?.status === "ready"),
    auth: { ok: auth?.status === "ready", via: "pi auth check (no refresh)", account: null },
    extras: provider ? [] : [{ ok: false, info: true, label: "No Pi defaultProvider is configured; authentication has not been checked for a provider." }],
    installHint: "npm install -g @earendil-works/pi-coding-agent (Node >=22.19)" };
}
export const smokeCommand = () => ({ cmd: "pi", args: ["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--", "Reply with exactly: bridge-ok"] });

// Native v3 evidence, not a claim that every tool uses these fields. Shell
// side effects and truncated vendor output remain structurally incomplete.
export const capabilities = { commands: true, commandArgs: true, outcome: true, exitCode: false,
  duration: false, filesRead: "partial", filesChanged: "partial", toolOutput: "partial",
  reasoning: "partial", tokenUsage: true, pairing: "keyed" };
export function observeAudit(ref) {
  const messages = readPiSession(ref.transcriptPath).branch.filter((entry) => entry.type === "message").map((entry) => entry.message);
  const calls = messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part?.type === "toolCall") : []);
  const results = messages.filter((message) => message.role === "toolResult");
  return { commands: calls.length ? true : null,
    commandArgs: calls.length ? calls.every((call) => call.arguments !== undefined) : null,
    outcome: results.length ? results.every((result) => typeof result.isError === "boolean") : null,
    pairing: calls.length && results.length ? "keyed" : null,
    tokenUsage: messages.some((message) => message.usage) ? true : null };
}
