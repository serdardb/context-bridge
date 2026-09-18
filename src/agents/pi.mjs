import { piSessionsForProject, piSessionRef, piAgentDirectory } from "./pi-sessions.mjs";
import { readPiSession, piMark, piActivity, piAudit } from "./pi-records.mjs";
import { isBridgeProtocolNoise } from "../delta.mjs";
import path from "node:path";
import fs from "node:fs";
import { tryExec, REPO_ROOT, readJson, BridgeError } from "../util.mjs";
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
// npm's Windows .cmd shim is not an executable. Resolve this known package's
// declared entry point instead of interpolating conversation text into a shell.
function piCommand(args) {
  if (process.platform !== "win32") return { cmd: "pi", args };
  const key = Object.keys(process.env).sort().find((name) => name.toLowerCase() === "path");
  for (const value of (process.env[key] ?? "").split(path.delimiter).filter(Boolean)) {
    const directory = path.resolve(value.replace(/^"(.*)"$/, "$1"));
    const executable = path.join(directory, "pi.exe");
    if (fs.existsSync(executable)) return { cmd: executable, args };
    if (!fs.existsSync(path.join(directory, "pi.cmd"))) continue;
    const packageRoot = path.basename(directory).toLowerCase() === ".bin"
      ? path.join(directory, "..", "@earendil-works", "pi-coding-agent")
      : path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent");
    try {
      const manifest = path.join(packageRoot, "package.json");
      if (fs.statSync(manifest).size > 64 * 1024) throw new Error();
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
      if (pkg.name !== "@earendil-works/pi-coding-agent" || typeof bin !== "string" || path.isAbsolute(bin)) throw new Error();
      const entry = path.resolve(packageRoot, bin), relative = path.relative(packageRoot, entry);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
          !/\.[cm]?js$/i.test(entry) || !fs.statSync(entry).isFile()) throw new Error();
      const localNode = path.join(directory, "node.exe");
      return { cmd: fs.existsSync(localNode) ? localNode : process.execPath, args: [entry, ...args] };
    } catch (cause) {
      throw new BridgeError("The Windows Pi npm entry point could not be resolved safely. Reinstall the trusted Pi package.",
        { code: "BRIDGE_PI_ENTRYPOINT", operation: "resolve Pi command", cause });
    }
  }
  return { cmd: "pi", args };
}
export const startCommand = (extraArgs = []) => piCommand(["--append-system-prompt", bridgeInstructions(), ...extraArgs]);
export function resumeCommand(ref, extraArgs = []) {
  if (!ref?.transcriptPath) throw new Error("Pi resume requires a verified session file.");
  return piCommand(["--session", ref.transcriptPath, "--append-system-prompt", bridgeInstructions(), ...extraArgs]);
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
  } catch (error) { return { status: error.code === "ENOENT" ? "missing" : error.code === "BRIDGE_TRANSCRIPT_TOO_LARGE" ? "unreadable" : "mismatch", rows: 0, known: 0, malformed: 0 }; }
}
export function discoveryProbe(projectDir = process.cwd()) {
  const { sessions, examined } = piSessionsForProject(projectDir);
  return { status: !examined ? "none" : sessions.length ? "readable" : "blind", examined, recognised: sessions.length };
}
export function health() {
  let commandError = null;
  const execute = (args) => {
    try { const command = piCommand(args); return tryExec(command.cmd, command.args); }
    catch (error) { commandError ??= error; return null; }
  };
  const version = execute(["--version"]);
  const settings = { ...readJson(path.join(piAgentDirectory(), "settings.json")),
    ...readJson(path.join(process.cwd(), ".pi", "settings.json")) };
  const provider = typeof settings.defaultProvider === "string" && settings.defaultProvider.trim() ? settings.defaultProvider : null;
  let auth = null;
  if (version && provider) try { auth = JSON.parse(execute(["auth", "check", "--provider", provider, "--json", "--no-refresh"])); } catch {}
  return { version, ready: Boolean(version && auth?.status === "ready"),
    auth: { ok: auth?.status === "ready", via: "pi auth check (no refresh)", account: null },
    extras: [
      ...(commandError ? [{ ok: false, label: commandError.message }] : []),
      ...(provider ? [] : [{ ok: false, info: true, label: "No Pi defaultProvider is configured; authentication has not been checked for a provider." }]),
    ],
    installHint: "npm install -g @earendil-works/pi-coding-agent (Node >=22.19)" };
}
export const smokeCommand = () => piCommand(["--print", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--", "Reply with exactly: bridge-ok"]);

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
