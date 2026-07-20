// `bridge doctor` — dependency-aware environment diagnostics + optional
// bootstrap. Never prints secret values; never mutates without confirmation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import {
  HOME,
  CLAUDE_DIR,
  CODEX_HOME,
  tryExec,
  readJson,
  fileExists,
  OK,
  BAD,
  WARN,
  NONE,
  bold,
  dim,
  log,
} from "./util.mjs";
import { findCompanionScript } from "./transfer.mjs";
import { loadState, agentSlot } from "./state.mjs";
import { ADAPTERS, AGENT_IDS, adapterFor } from "./agents/index.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_SKILL_PATH = path.join(HOME, ".agents", "skills", "bridge", "SKILL.md");

export async function runDoctor(projectDir, { fix = false, json = false, deep = false } = {}) {
  const r = collect(projectDir);
  // Installed and authenticated is not the same as working: --deep asks each
  // agent a harmless one-line question and reports what actually came back.
  r.deep = deep;
  if (deep) for (const agentId of AGENT_IDS) r.agents[agentId].smoke = smoke(agentId, r.agents[agentId]);
  if (json) {
    log(JSON.stringify(r, null, 2));
    return anyRouteReady(r) ? 0 : 1;
  }
  render(r);
  if (fix) await applyFixes(projectDir, r);
  return anyRouteReady(r) ? 0 : 1;
}

/** The two verdicts that mean a handoff through this agent would fail today. */
const SESSION_BROKEN = new Set(["missing", "mismatch"]);

/**
 * Exit code. Zero means a switch could happen AND nothing we rely on has drifted
 * under us. An unreadable linked session fails the whole command even when other
 * routes are fine, because in CI that drift is the only warning anyone will get
 * and a green tick beside it would be the original bug wearing a new word.
 */
function anyRouteReady(r) {
  const drifted = AGENT_IDS.some((id) => SESSION_BROKEN.has(r.agents[id].session.status));
  return !drifted && Object.values(r.routes).some((route) => route.ready);
}

function smoke(agentId, health) {
  if (!health.version) return { ok: false, detail: "not installed" };
  const { cmd, args } = adapterFor(agentId).smokeCommand();
  const out = tryExec(cmd, args, { timeout: 60000 });
  if (out === null) return { ok: false, detail: "no answer (auth, network or a changed headless flag)" };
  return { ok: out.includes("bridge-ok"), detail: out.slice(0, 120) };
}

export function collect(projectDir) {
  // Every agent answers for itself; this file only knows how to arrange answers.
  const agents = {};
  for (const agentId of AGENT_IDS) agents[agentId] = adapterFor(agentId).health(projectDir);

  const companion = findCompanionScript();
  const plugins = readJson(path.join(CLAUDE_DIR, "plugins", "installed_plugins.json"))?.plugins || {};
  const officialPlugin = !!plugins["codex@openai-codex"];

  const bridgeOnPath = tryExec("bridge", ["--version"]) !== null;
  let state = null;
  let stateError = null;
  try {
    state = loadState(projectDir);
  } catch (e) {
    stateError = e.message;
  }
  const linked = state ? AGENT_IDS.filter((agentId) => agentSlot(state, agentId).id) : [];

  // The parser canary. Being installed proves nothing about whether we can still
  // read the agent's own session files, and that is the failure that hurts most:
  // it is silent. Linked session first; otherwise one deterministic discover, so
  // doctor never guesses the way adopt is allowed to.
  for (const agentId of AGENT_IDS) agents[agentId].session = probeSession(projectDir, agentId, state);

  // A route is ready when both ends are. Claude to Codex additionally has the
  // official import for its first switch; every other first switch opens a new
  // session seeded with the delta, which is weaker and says so.
  const routes = {};
  for (const from of AGENT_IDS) {
    for (const to of AGENT_IDS) {
      if (from === to) continue;
      const installed = agents[from].ready && agents[to].ready;
      const official = from === "claude" && to === "codex";
      // An end whose session we can no longer read cannot carry a handoff, so it
      // does not get to stay green. Renaming READY to CONFIGURED while leaving
      // the verdict on install alone would have been the same lie in a new word,
      // and the footer promising that CONFIGURED covers readability would have
      // been the one telling it. `none` is not broken: a fresh project has no
      // session yet and must never go red.
      const broken = [from, to].filter((a) => SESSION_BROKEN.has(agents[a].session.status));
      const configured = installed && broken.length === 0;
      routes[`${from}->${to}`] = {
        ready: configured,
        configured,
        firstSwitch: official ? (companion ? "official import" : "official import unavailable") : "delta-seeded",
        status: configured ? "CONFIGURED" : broken.length && installed ? "SESSION UNREADABLE" : "NOT CONFIGURED",
        sessionWarning: broken.length ? `cannot read the linked session for ${broken.join(", ")}` : null,
      };
    }
  }

  return {
    project: projectDir,
    agents,
    claude: { ...agents.claude, officialCodexPlugin: officialPlugin, companionScript: companion },
    codex: agents.codex,
    bridge: { onPath: bridgeOnPath, state: !!state, stateError, linked },
    routes,
  };
}




/**
 * Probe one agent's session parsing. Returns a status the render layer can print
 * without further judgement:
 *   none      nothing linked and nothing discoverable — a fresh project, not a fault
 *   readable  the parser understands this file (message count is information only)
 *   partial   understood, but some lines were not JSON and were read past
 *   missing   we hold a session reference whose transcript is gone
 *   mismatch  the file is there and we no longer recognise a single row in it
 */
function probeSession(projectDir, agentId, state) {
  const adapter = adapterFor(agentId);
  if (!adapter.parseProbe) return { status: "none", detail: "no probe for this agent" };
  let ref = null;
  let linked = false;
  try {
    const slot = state ? agentSlot(state, agentId) : null;
    if (slot?.id) {
      linked = true;
      ref = adapter.hydrate(projectDir, slot);
    } else {
      ref = adapter.discover(projectDir);
    }
  } catch {
    ref = null;
  }
  // Being linked to a session we can no longer resolve is the opposite of a
  // fresh project, and reporting it as one hid a real fault behind the very
  // wording chosen to keep fresh projects calm.
  if (!ref?.transcriptPath) return linked ? { status: "missing", linked, detail: "the linked session is gone" } : { status: "none", linked: false };
  try {
    return { ...adapter.parseProbe(ref), linked };
  } catch (err) {
    return { status: "mismatch", linked, detail: err.message };
  }
}

/** One line per agent, worded so nobody reads a fresh project as a broken one. */
function sessionLine(session) {
  const n = session.messages;
  switch (session.status) {
    case "none":
      return { level: "info", text: "Session: none linked yet (nothing to check on a fresh project)" };
    case "readable":
      return {
        level: "ok",
        text: `Session readable by this version of the bridge${n == null ? "" : ` (${n} messages)`}`,
      };
    case "partial":
      return { level: "warn", text: `Session readable, ${session.malformed} malformed line(s) skipped` };
    case "missing":
      // Naming the file matters: Grok keeps two, and "transcript" sent people
      // looking at the wrong one.
      return {
        level: "bad",
        text: `Session file is missing: ${session.detail ?? "the transcript this project is linked to is gone"}`,
      };
    default:
      return {
        level: "bad",
        text: `Session UNREADABLE: no known record shape in ${session.rows} rows${session.detail ? ` (${session.detail})` : ""} — the agent likely changed its session format`,
      };
  }
}

function render(r) {
  log(bold("Context Bridge Doctor"));
  for (const agentId of AGENT_IDS) {
    const a = r.agents[agentId];
    const adapter = adapterFor(agentId);
    log("");
    log(bold(adapter.displayName));
    row(!!a.version, `Installed: ${a.version ?? "not found"}`, a.installHint);
    row(
      a.auth.ok,
      a.auth.ok ? `Authenticated${authLabel(a.auth)}` : "Not authenticated",
      `sign in to ${adapter.displayName} (subscription, no API key)`
    );
    for (const extra of a.extras ?? []) {
      if (extra.info) rowInfo(extra.ok, extra.label);
      else row(extra.ok, extra.label, extra.fix);
    }
    if (agentId === "claude") {
      row(
        !!r.claude.companionScript,
        r.claude.officialCodexPlugin
          ? "Official OpenAI Codex plugin installed (seeds the first Claude→Codex switch)"
          : r.claude.companionScript
            ? "Official transfer machinery available (vendor)"
            : "Official OpenAI Codex plugin missing",
        "claude plugin marketplace add openai/codex-plugin-cc && claude plugin install codex@openai-codex"
      );
    }
    const sl = sessionLine(a.session);
    if (sl.level === "bad") row(false, sl.text, "run a handoff to relink, or open an issue if the agent just updated");
    else if (sl.level === "info") log(`  ${dim("·")} ${dim(sl.text)}`);
    else rowInfo(sl.level === "ok", sl.text);
    if (a.smoke) rowInfo(a.smoke.ok, a.smoke.ok ? "LIVE: answered a real headless question" : `BROKEN: ${a.smoke.detail}`);
  }

  log("");
  log(bold("Bridge"));
  row(r.bridge.onPath, r.bridge.onPath ? "bridge on PATH (hooks can reach it)" : "bridge not on PATH", "run `npm link` in the context-bridge repo");
  rowInfo(
    r.bridge.state,
    r.bridge.state
      ? r.bridge.linked.length
        ? `Project state: linked ${r.bridge.linked.join(", ")}`
        : "Project state present (nothing linked yet)"
      : "No project state yet (created on first use)"
  );
  if (r.bridge.stateError) row(false, `State error: ${r.bridge.stateError}`, "inspect .bridge/state.json");

  log("");
  log(bold("Available routes"));
  for (const [route, info] of Object.entries(r.routes)) {
    const label = route.padEnd(18);
    const note = info.configured ? dim(`  first switch: ${info.firstSwitch}`) : "";
    const warn = info.sessionWarning ? dim(`  ${info.sessionWarning}`) : "";
    log(`  ${label} ${info.configured ? OK + " CONFIGURED" : NONE + " " + info.status}${note}${warn}`);
  }
  log("");
  log(
    dim(
      r.deep
        ? "CONFIGURED means installed, configured and readable. LIVE above means the agent answered a real question just now."
        : "CONFIGURED means installed, configured, and its session still parses. It does not mean the agent answers: run `bridge doctor --deep` to ask each one a real question."
    )
  );
}

function authLabel(auth) {
  if (!auth.account) return "";
  return ` (${displayAccount(auth.account)})`;
}

/** Privacy-friendly account label: BRIDGE_ACCOUNT_LABEL overrides; emails are masked by default. */
function displayAccount(account) {
  if (process.env.BRIDGE_ACCOUNT_LABEL) return process.env.BRIDGE_ACCOUNT_LABEL;
  const at = String(account).indexOf("@");
  if (at > 1) return account[0] + "…" + account.slice(at);
  return account;
}

function row(ok, label, fixHint) {
  log(`  ${ok ? OK : BAD} ${label}${!ok && fixHint ? dim(`  → ${fixHint}`) : ""}`);
}
function rowInfo(ok, label) {
  log(`  ${ok ? OK : WARN} ${label}`);
}

async function applyFixes(projectDir, r) {
  if (!process.stdin.isTTY) {
    log(`${WARN} --fix needs an interactive terminal; the exact commands are shown above.`);
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const yes = async (q) => /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
  try {
    if (!r.claude.companionScript && r.claude.version) {
      if (await yes("Install the official OpenAI Codex plugin for Claude Code (official mechanism)?")) {
        run("claude", ["plugin", "marketplace", "add", "openai/codex-plugin-cc"]);
        run("claude", ["plugin", "install", "codex@openai-codex"]);
      }
    }
    if (!r.claude.bridgePlugin && r.claude.version) {
      if (await yes(`Install the context-bridge Claude plugin from ${REPO_ROOT}?`)) {
        run("claude", ["plugin", "marketplace", "add", REPO_ROOT]);
        run("claude", ["plugin", "install", "bridge@context-bridge"]);
      }
    }
    const skillExtra = r.agents.codex.extras.find((e) => e.label.includes("$bridge skill"));
    if (skillExtra && !skillExtra.ok) {
      const verb = skillExtra.label.includes("OUT OF DATE") ? "Update" : "Install";
      if (await yes(`${verb} the shared $bridge skill (~/.agents/skills/bridge/SKILL.md)?`)) {
        installCodexSkill();
        log(`${OK} Shared $bridge skill written from this repo.`);
      }
    }
    if (!r.codex.rules) {
      if (await yes("Pre-allow the `bridge` command in Codex (writes ~/.codex/rules/bridge.rules)?")) {
        installCodexRule();
        log(`${OK} Codex allow-rule installed.`);
      }
    }
    if (!r.codex.projectTrusted && r.codex.version) {
      log(dim("Note: Codex will show its own one-time trust prompt for this folder on first launch — that dialog is owned by Codex."));
    }
  } finally {
    rl.close();
  }
}

function run(cmd, args) {
  const out = tryExec(cmd, args, { timeout: 120000 });
  if (out === null) log(`${BAD} '${cmd} ${args.join(" ")}' failed — run it manually to see the error.`);
  else log(`${OK} ${cmd} ${args.join(" ")}`);
}

export function installCodexSkill() {
  const src = path.join(REPO_ROOT, "codex", "SKILL.md");
  fs.mkdirSync(path.dirname(CODEX_SKILL_PATH), { recursive: true });
  fs.copyFileSync(src, CODEX_SKILL_PATH);
}

export function installCodexRule() {
  const dir = path.join(CODEX_HOME, "rules");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "bridge.rules"),
    'prefix_rule(pattern=["bridge"], decision="allow")\n'
  );
}
