// First Claude -> Codex switch: use the OFFICIAL OpenAI codex-plugin-cc
// transfer machinery (never reimplement the import RPC).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { CLAUDE_DIR, readJson, fileExists } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the official codex-companion.mjs script. */
export function findCompanionScript() {
  // 1) explicit override
  if (process.env.BRIDGE_CODEX_COMPANION && fileExists(process.env.BRIDGE_CODEX_COMPANION)) {
    return process.env.BRIDGE_CODEX_COMPANION;
  }
  // 2) installed official plugin (codex@openai-codex)
  const installed = readJson(path.join(CLAUDE_DIR, "plugins", "installed_plugins.json"));
  const records = installed?.plugins?.["codex@openai-codex"];
  if (Array.isArray(records)) {
    for (const rec of records) {
      const p = rec.installPath && path.join(rec.installPath, "scripts", "codex-companion.mjs");
      if (p && fileExists(p)) return p;
    }
  }
  return null;
}

/**
 * Run the official transfer for a Claude transcript.
 * Returns {threadId, sessionId, sourcePath}. Throws with a readable message on failure.
 */
export function transferClaudeSession(transcriptPath) {
  const companion = findCompanionScript();
  if (!companion) {
    throw new Error(
      "Official OpenAI Codex plugin not found. Install it with:\n" +
        "  claude plugin marketplace add openai/codex-plugin-cc\n" +
        "  claude plugin install codex@openai-codex\n" +
        "(or run `bridge doctor --fix`)"
    );
  }
  let stdout;
  try {
    stdout = execFileSync("node", [companion, "transfer", "--json", "--source", transcriptPath], {
      encoding: "utf8",
      timeout: 120000,
    });
  } catch (e) {
    const msg = e.stdout || e.stderr || e.message;
    throw new Error(`Official Claude→Codex transfer failed: ${String(msg).trim()}`);
  }
  const parsed = extractJson(stdout);
  if (!parsed?.threadId) {
    throw new Error(`Transfer did not return a threadId. Output was:\n${stdout.trim()}`);
  }
  return parsed;
}

function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}
