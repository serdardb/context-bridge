// `bridge doctor` — dependency-aware environment diagnostics + optional
// bootstrap. Never prints secret values; never mutates without confirmation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import {
  CLAUDE_DIR,
  codexHome,
  sharedSkillPath,
  writeFileAtomic,
  writeFileExclusive,
  BridgeError,
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
import { installHooks as installCodexHooks, hooksPath as codexHooksPath, installedAllowRule, BRIDGE_ALLOW_RULE } from "./agents/codex.mjs";
import { projectIdentity, projectStoreDir, runtimeStoreDir, storageHome, inspectMigrationReceipts } from "./storage.mjs";
import { kernelLockHealth } from "./locking.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runDoctor(projectDir, { fix = false, json = false, deep = false } = {}) {
  const r = collect(projectDir);
  // Installed and authenticated is not the same as working: --deep asks each
  // agent a harmless one-line question and reports what actually came back.
  r.deep = deep;
  if (deep && r.bridge.locking.ok && !r.bridge.storage.error && !r.bridge.stateError) for (const agentId of AGENT_IDS) r.agents[agentId].smoke = smoke(agentId, r.agents[agentId]);
  refreshIntegration(r);
  if (json) {
    log(JSON.stringify(r, null, 2));
    return anyRouteReady(r) ? 0 : 1;
  }
  render(r);
  if (fix) await applyFixes(projectDir, r);
  return anyRouteReady(r) ? 0 : 1;
}

/** Run strict real-agent verification for release and automation. */
export async function runVerify(projectDir, { json = false, all = false } = {}) {
  const r = collect(projectDir);
  r.deep = true;
  for (const agentId of AGENT_IDS) {
    if (r.bridge.locking.ok && !r.bridge.storage.error && !r.bridge.stateError && r.agents[agentId].version) r.agents[agentId].smoke = smoke(agentId, r.agents[agentId]);
  }
  refreshIntegration(r);
  r.verify = verifyReport(r, { all });
  if (json) {
    log(JSON.stringify(r, null, 2));
    return r.verify.ok ? 0 : 1;
  }
  render(r);
  log("");
  log(r.verify.ok ? `${OK} Verification passed for ${r.verify.agents} installed agents and ${r.verify.routes} routes.` : `${BAD} Verification failed: ${r.verify.failures.join("; ")}`);
  return r.verify.ok ? 0 : 1;
}

/** Pure verdict used by the CLI and tests without starting agent processes. */
export function verifyReport(r, { all = false } = {}) {
  const installed = AGENT_IDS.filter((id) => r.agents[id]?.version);
  const failures = [];
  if (r.bridge?.locking?.ok !== true) failures.push("native locking is unavailable or unverified; mutations cannot be verified");
  if (r.bridge?.storage?.error || r.bridge?.stateError) failures.push("runtime storage or migration evidence needs recovery");
  if (all) for (const id of AGENT_IDS) {
    if (!installed.includes(id)) failures.push(`${id} is required for release verification but is not installed`);
  }
  if (installed.length < 2) failures.push("fewer than two supported agents are installed");
  for (const id of installed) {
    const a = r.agents[id];
    if (!a.smoke?.ok) failures.push(`${id} did not answer the smoke question`);
    if (["missing", "mismatch"].includes(a.session?.status)) failures.push(`${id} session is ${a.session.status}`);
    if (a.discovery?.status === "blind") failures.push(`${id} session discovery is blind`);
  }
  let routes = 0;
  for (const from of installed) {
    for (const to of installed) {
      if (from === to) continue;
      routes++;
      if (!r.routes[`${from}->${to}`]?.configured) failures.push(`${from}->${to} is not configured`);
    }
  }
  return { ok: failures.length === 0, agents: installed.length, routes, failures };
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
  const drifted = AGENT_IDS.some(
    (id) => SESSION_BROKEN.has(r.agents[id].session.status) || r.agents[id].discovery?.status === "blind"
  );
  return r.bridge.locking.ok && !r.bridge.storage.error && !r.bridge.stateError && !drifted && Object.values(r.routes).some((route) => route.ready);
}

function smoke(agentId, health) {
  if (!health.version) return { ok: false, detail: "not installed" };
  const { cmd, args } = adapterFor(agentId).smokeCommand();
  const out = tryExec(cmd, args, { timeout: 60000 });
  if (out === null) return { ok: false, detail: "no answer (auth, network or a changed headless flag)" };
  return { ok: out.includes("bridge-ok"), detail: out.slice(0, 120) };
}

export function collect(projectDir) {
  const locking = kernelLockHealth();
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
    state = loadState(projectDir, { readOnly: true });
  } catch (e) {
    stateError = e.message;
  }
  const legacy = path.join(path.resolve(projectDir), ".bridge");
  const legacyState = fs.existsSync(path.join(legacy, "state.json"));
  let storage = {
    mode: process.env.CONTEXT_BRIDGE_STORAGE === "project" ? "legacy-project" : legacyState ? "legacy-migration-pending" : "global",
    home: storageHome(),
    projectId: null,
    projectStore: null,
    runtimeStore: null,
    gitOptional: true,
  };
  try {
    const identity = projectIdentity(projectDir);
    storage = { ...storage, projectId: identity.id, projectStore: projectStoreDir(projectDir), runtimeStore: runtimeStoreDir(projectDir) };
    storage.completedMigrations = inspectMigrationReceipts(projectDir);
    const issues = storage.completedMigrations.filter((record) => record.error);
    if (issues.length) storage.error = issues.map((record) => record.error).join("\n");
  } catch (error) {
    storage.error = error.message;
  }
  const linked = state ? AGENT_IDS.filter((agentId) => agentSlot(state, agentId).id) : [];

  // The parser canary. Being installed proves nothing about whether we can still
  // read the agent's own session files, and that is the failure that hurts most:
  // it is silent. Linked session first; otherwise one deterministic discover, so
  // doctor never guesses the way adopt is allowed to.
  for (const agentId of AGENT_IDS) agents[agentId].session = probeSession(projectDir, agentId, state);

  // The canary above watches the parser that reads a LINKED session. Discovery
  // uses a different reader, and that one died silently once: a 16KB buffer
  // against a 22KB rollout head record meant no session was ever found and
  // nothing said so, because an empty result is what "nothing to find" looks
  // like too. So the reader is checked against what is actually on disk.
  for (const agentId of AGENT_IDS) agents[agentId].discovery = probeDiscovery(projectDir, agentId);

  // Keep these dimensions separate. A binary's presence is not configuration,
  // configuration is not permission to use the bridge integration, and neither
  // proves that the live agent answered. The distinction is especially important
  // for optional hooks: an agent can be fully usable on the prompt road without
  // being trusted for hook delivery.
  for (const agentId of AGENT_IDS) {
    agents[agentId].integration = integrationStatus(agentId, agents[agentId]);
  }

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
      const broken = [from, to].filter(
        (a) => SESSION_BROKEN.has(agents[a].session.status) || agents[a].discovery.status === "blind"
      );
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
    bridge: {
      onPath: bridgeOnPath,
      state: !!state,
      stateError,
      linked,
      storage,
      locking,
    },
    routes,
  };
}

/** Pure, machine-readable integration state used by doctor output and tests. */
export function integrationStatus(agentId, health) {
  const installed = !!health?.version;
  const configured = !!health?.ready;
  let trusted = "not-applicable";
  if (agentId === "claude") trusted = extraOk(health, "context-bridge plugin installed");
  if (agentId === "codex") {
    const skill = extraOk(health, "$bridge skill installed and current");
    const rule = extraOk(health, "bridge allow-rule installed");
    trusted = skill && rule;
  }
  if (agentId === "grok") trusted = extraOk(health, "$bridge skill installed and current");
  const verified = !!health?.smoke?.ok &&
    !["missing", "mismatch"].includes(health?.session?.status) &&
    health?.discovery?.status !== "blind";
  return { installed, configured, trusted, verified };
}

function refreshIntegration(report) {
  for (const agentId of AGENT_IDS) {
    report.agents[agentId].integration = integrationStatus(agentId, report.agents[agentId]);
  }
}

function extraOk(health, fragment) {
  return !!health?.extras?.find((extra) => extra.label?.includes(fragment))?.ok;
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
  //
  // Agents that use CLI export (like OpenCode) have no transcript file on disk
  // by design — transcriptPath is null in their ref. These agents are probed
  // through their parseProbe which shells out to the CLI, so a missing
  // transcriptPath is expected and must not be reported as "missing".
  if (!ref?.id) return linked ? { status: "missing", linked, detail: "the linked session is gone" } : { status: "none", linked: false };
  if (!ref?.transcriptPath && typeof adapter.parseProbe === "function") {
    // CLI-based agent: probe through the adapter directly
    try {
      return { ...adapter.parseProbe(ref), linked };
    } catch (err) {
      return { status: "mismatch", linked, detail: err.message };
    }
  }
  if (!ref?.transcriptPath) return linked ? { status: "missing", linked, detail: "the linked session is gone" } : { status: "none", linked: false };
  try {
    return { ...adapter.parseProbe(ref), linked };
  } catch (err) {
    return { status: "mismatch", linked, detail: err.message };
  }
}

/** Ask the adapter whether its own discovery reader still understands the disk. */
function probeDiscovery(projectDir, agentId) {
  const adapter = adapterFor(agentId);
  if (!adapter?.discoveryProbe) return { status: "none", examined: 0, recognised: 0 };
  try {
    return adapter.discoveryProbe(projectDir);
  } catch (err) {
    return { status: "blind", examined: 0, recognised: 0, detail: err.message };
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
    if (a.integration) {
      const trust = a.integration.trusted === "not-applicable" ? "n/a" : a.integration.trusted ? "yes" : "no";
      log(dim(`  Integration state: installed=${a.integration.installed ? "yes" : "no"}, configured=${a.integration.configured ? "yes" : "no"}, trusted=${trust}, verified=${a.integration.verified ? "yes" : "no"}`));
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
    if (a.discovery?.status === "blind") {
      // Deliberately silent when healthy: doctor is already long, and a check
      // that only speaks when something is wrong is a check people still read.
      row(
        false,
        `Session DISCOVERY is blind: ${a.discovery.examined} stored session(s), none recognisable` +
          `${a.discovery.detail ? ` (${a.discovery.detail})` : ""} — the bridge can no longer find sessions it was not already told about`,
        "this usually means the agent changed its storage format; please open an issue"
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
  row(r.bridge.locking.ok, `Native locking (${r.bridge.locking.platform}/${r.bridge.locking.arch}): ${r.bridge.locking.detail}`, "repair the native runtime, then run bridge doctor --json");
  row(r.bridge.onPath, r.bridge.onPath ? "bridge on PATH (hooks can reach it)" : "bridge not on PATH", "run `npm link` in the context-bridge repo");
  rowInfo(
    r.bridge.state,
    r.bridge.state
      ? r.bridge.linked.length
        ? `Project state: linked ${r.bridge.linked.join(", ")}`
        : "Project state present (nothing linked yet)"
      : "No project state yet (created on first use)"
  );
  if (r.bridge.stateError) row(false, `State error: ${r.bridge.stateError}`, "run `bridge doctor --json` for the diagnostic");
  if (r.bridge.storage.error) row(false, `Storage error: ${r.bridge.storage.error}`, "run `bridge storage plan --json` to inspect preserved evidence");

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
    const hookExtra = r.agents.codex.extras.find((e) => e.label.includes("Session hooks"));
    if (hookExtra && !hookExtra.ok && r.codex.version) {
      if (await yes(`Install context-bridge session hooks for Codex (${codexHooksPath()})?`)) {
        const written = installCodexHooks();
        log(`${OK} Wrote ${written}.`);
        log(dim("  Codex will not run them until you review them once with /hooks inside Codex."));
      }
    }
    if (!installedAllowRule()) {
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
  const destination = sharedSkillPath();
  inspectInstallDestination(destination);
  writeFileAtomic(destination, fs.readFileSync(src));
}

export function installCodexRule() {
  const dir = path.join(codexHome(), "rules");
  const file = path.join(dir, "bridge.rules");
  if (inspectInstallDestination(file)) {
    if (fs.readFileSync(file, "utf8").trim() === BRIDGE_ALLOW_RULE.trim()) return;
    throw new BridgeError("Existing bridge.rules contains custom content. It was preserved; review it manually instead of replacing its permission policy.", { path: file });
  }
  fs.mkdirSync(dir, { recursive: true });
  writeFileExclusive(file, BRIDGE_ALLOW_RULE);
}

function inspectInstallDestination(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new BridgeError("Refusing to replace an unsafe installation destination; existing files were preserved.", { path: file });
  }
  return true;
}
