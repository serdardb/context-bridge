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
import { loadState } from "./state.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_SKILL_PATH = path.join(HOME, ".agents", "skills", "bridge", "SKILL.md");

export async function runDoctor(projectDir, { fix = false, json = false } = {}) {
  const r = collect(projectDir);
  if (json) {
    log(JSON.stringify(r, null, 2));
    return r.routes.claudeCodex === "READY" ? 0 : 1;
  }
  render(r);
  if (fix) await applyFixes(projectDir, r);
  return r.routes.claudeCodex === "READY" ? 0 : 1;
}

export function collect(projectDir) {
  // --- Claude Code ---
  const claudeVersion = tryExec("claude", ["--version"]);
  const claudeAuth = detectClaudeAuth();
  const plugins = readJson(path.join(CLAUDE_DIR, "plugins", "installed_plugins.json"))?.plugins || {};
  const ourPlugin = !!plugins["bridge@context-bridge"];
  const officialPlugin = !!plugins["codex@openai-codex"];
  const companion = findCompanionScript();

  // --- Codex ---
  const codexVersion = tryExec("codex", ["--version"]);
  const codexAuthOut = codexVersion ? tryExec("sh", ["-c", "codex login status 2>&1"]) : null;
  const codexAuth = codexAuthOut !== null;
  const codexSkill = fileExists(CODEX_SKILL_PATH);
  const codexTrusted = detectCodexTrust(projectDir);
  const codexRules = fileExists(path.join(CODEX_HOME, "rules", "bridge.rules"));

  // --- Bridge itself ---
  const bridgeOnPath = tryExec("bridge", ["--version"]) !== null;
  let state = null;
  let stateError = null;
  try {
    state = loadState(projectDir);
  } catch (e) {
    stateError = e.message;
  }
  const linked = !!(state?.agents?.claude?.id && state?.agents?.codex?.id);

  const claudeReady = !!(claudeVersion && claudeAuth.ok && ourPlugin);
  const codexReady = !!(codexVersion && codexAuth && codexSkill);
  const importReady = linked || !!companion;
  const routes = {
    claudeCodex: claudeReady && codexReady && importReady ? "READY" : "NOT READY",
    claudeGemini: "UNAVAILABLE (planned)",
    codexGemini: "UNAVAILABLE (planned)",
  };

  return {
    project: projectDir,
    claude: {
      version: claudeVersion,
      auth: claudeAuth,
      bridgePlugin: ourPlugin,
      officialCodexPlugin: officialPlugin,
      companionScript: companion,
    },
    codex: {
      version: codexVersion,
      auth: codexAuth,
      authDetail: codexAuthOut,
      skill: codexSkill,
      projectTrusted: codexTrusted,
      rules: codexRules,
    },
    bridge: { onPath: bridgeOnPath, state: !!state, stateError, linked },
    routes,
  };
}

function detectClaudeAuth() {
  // macOS keychain (existence only — never read the secret), Linux fallback file.
  if (process.platform === "darwin") {
    const kc = tryExec("security", ["find-generic-password", "-s", "Claude Code-credentials"]);
    if (kc !== null) return { ok: true, via: "keychain", account: claudeAccount() };
  }
  if (fileExists(path.join(CLAUDE_DIR, ".credentials.json"))) {
    return { ok: true, via: "credentials-file", account: claudeAccount() };
  }
  // OAuth account record alone is a decent signal too
  const account = claudeAccount();
  return account ? { ok: true, via: "oauth-account", account } : { ok: false, via: null, account: null };
}

function claudeAccount() {
  return readJson(path.join(HOME, ".claude.json"))?.oauthAccount?.emailAddress ?? null;
}

function detectCodexTrust(projectDir) {
  try {
    const toml = fs.readFileSync(path.join(CODEX_HOME, "config.toml"), "utf8");
    return toml.includes(`"${projectDir}"`);
  } catch {
    return false;
  }
}

function render(r) {
  log(bold("Context Bridge Doctor"));
  log("");
  log(bold("Claude Code"));
  row(!!r.claude.version, `Installed: ${r.claude.version ?? "not found"}`, "curl -fsSL https://claude.ai/install.sh | bash");
  row(r.claude.auth.ok, r.claude.auth.ok ? `Authenticated${r.claude.auth.account ? ` (${displayAccount(r.claude.auth.account)})` : ""}` : "Not authenticated", "run `claude` and use /login (subscription, no API key)");
  row(r.claude.bridgePlugin, "context-bridge plugin installed", "bridge doctor --fix");
  row(!!r.claude.companionScript, r.claude.officialCodexPlugin ? "Official OpenAI Codex plugin installed" : r.claude.companionScript ? "Official transfer machinery available (vendor)" : "Official OpenAI Codex plugin missing", "claude plugin marketplace add openai/codex-plugin-cc && claude plugin install codex@openai-codex");
  log("");
  log(bold("Codex"));
  row(!!r.codex.version, `Installed: ${r.codex.version ?? "not found"}`, "npm install -g @openai/codex");
  row(r.codex.auth, r.codex.auth ? `Authenticated (${r.codex.authDetail})` : "Not authenticated", "codex login  (your ChatGPT subscription can be used)");
  row(r.codex.skill, "$bridge skill installed (~/.agents/skills/bridge)", "bridge doctor --fix");
  rowInfo(r.codex.projectTrusted, r.codex.projectTrusted ? "Project trusted by Codex" : "Project not yet trusted — Codex will show a one-time trust prompt");
  rowInfo(r.codex.rules, r.codex.rules ? "bridge command pre-allowed in Codex rules" : "No Codex allow-rule for `bridge` — Codex may ask approval once");
  log("");
  log(bold("Bridge"));
  row(r.bridge.onPath, r.bridge.onPath ? "bridge on PATH (hooks can reach it)" : "bridge not on PATH", "run `npm link` in the context-bridge repo");
  rowInfo(r.bridge.state, r.bridge.state ? (r.bridge.linked ? "Project state: linked Claude ↔ Codex pair" : "Project state present (not linked yet)") : "No project state yet (created on first use)");
  if (r.bridge.stateError) row(false, `State error: ${r.bridge.stateError}`, "inspect .bridge/state.json");
  log("");
  log(bold("Available routes"));
  log(`  Claude <-> Codex     ${r.routes.claudeCodex === "READY" ? OK + " READY" : BAD + " NOT READY"}`);
  log(`  Claude <-> Gemini    ${NONE} ${r.routes.claudeGemini}`);
  log(`  Codex  <-> Gemini    ${NONE} ${r.routes.codexGemini}`);
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
    if (!r.codex.skill) {
      if (await yes("Install the $bridge skill for Codex (~/.agents/skills/bridge/SKILL.md)?")) {
        installCodexSkill();
        log(`${OK} Codex $bridge skill installed.`);
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
