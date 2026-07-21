// Per-agent launch flags.
//
// The need this serves is a moment, not a preference: you are working with
// approvals on, and then you decide, now, that this agent should stop asking,
// and perhaps run a different model while it is at it. Making that require a
// file edit would put the friction exactly where the moment is.
//
// So there are three layers and the file is the last of them:
//
//   defaults   .bridge/config.json, applied to every launch of that agent
//   moment     flags typed on the launcher command line, for that launch only
//   save       --cb-save-args, which promotes the moment into the defaults
//
// Nobody hand-edits the file. It is where saved decisions accumulate, written by
// the same command that made them, which is why `bridge args` can show and clear
// them: a saved "stop asking" with no way to unsay it would be a trap.
import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "./util.mjs";
import { bridgeDir } from "./state.mjs";
import { AGENT_IDS } from "./agents/index.mjs";
import { filterAgentArgs } from "./agentargs.mjs";

export const CONFIG_VERSION = 1;

/**
 * Flags that change what an agent is allowed to do without asking. They are
 * announced loudly on every launch, because a silently armed "skip all
 * approvals" is the kind of invisible state this project exists to remove.
 * Matched on the flag name, so `--model gpt-5` stays quiet while
 * `--dangerously-skip-permissions` does not.
 */
const DANGEROUS = [
  /^--dangerously/,
  /^--yolo$/,
  /^--full-auto$/,
  /^--bypass/,
  /^--no-sandbox$/,
  /^--trust$/,
  /^--ask-for-approval$/,
  /^--sandbox$/,
];

export function isDangerous(arg) {
  const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
  return DANGEROUS.some((re) => re.test(name));
}

function configPath(projectDir) {
  return path.join(bridgeDir(projectDir), "config.json");
}

/** Read the project's config, or an empty one. Never throws on a missing file. */
export function loadConfig(projectDir) {
  let raw;
  try {
    raw = fs.readFileSync(configPath(projectDir), "utf8");
  } catch {
    return { version: CONFIG_VERSION, agents: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A broken config is the user's file, so it is worth a real complaint rather
    // than a silent reset that throws their saved flags away.
    throw new BridgeError(`.bridge/config.json is not valid JSON (${err.message}). Fix or delete it.`);
  }
  return { version: parsed.version ?? CONFIG_VERSION, agents: parsed.agents ?? {} };
}

export function saveConfig(projectDir, config) {
  const dir = bridgeDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(projectDir), JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2) + "\n");
}

/** The saved flags for one agent, always an array. */
export function savedArgs(config, agent) {
  const args = config.agents?.[agent]?.args;
  return Array.isArray(args) ? args : [];
}

/**
 * Save flags as this agent's default, refusing the ones that would break the
 * bridge's own session link. The refusal happens here, when someone is writing
 * the flag, rather than at spawn time when the reason is far from the cause.
 */
export function saveArgs(projectDir, agent, args) {
  if (!AGENT_IDS.includes(agent)) {
    throw new BridgeError(`Unknown agent '${agent}'. Known agents: ${AGENT_IDS.join(", ")}.`);
  }
  if (!args.length) {
    throw new BridgeError(
      `Nothing to save for ${agent}. Pass the flags you want remembered, for example:\n` +
        `  bridge ${agent} --some-flag --cb-save-args`
    );
  }
  const { kept, dropped } = filterAgentArgs(agent, args);
  const refused = dropped.filter((d) => !d.isValue);
  if (refused.length) {
    throw new BridgeError(
      `These flags cannot be saved for ${agent} because they break the bridge's session link:\n` +
        refused.map((d) => `  ${d.arg} — ${d.why}`).join("\n")
    );
  }
  const config = loadConfig(projectDir);
  config.agents[agent] = { ...(config.agents[agent] ?? {}), args: kept };
  saveConfig(projectDir, config);
  return kept;
}

/** Forget an agent's saved flags. Returns what was removed, so callers can say. */
export function clearArgs(projectDir, agent) {
  if (!AGENT_IDS.includes(agent)) {
    throw new BridgeError(`Unknown agent '${agent}'. Known agents: ${AGENT_IDS.join(", ")}.`);
  }
  const config = loadConfig(projectDir);
  const had = savedArgs(config, agent);
  if (!had.length) return [];
  delete config.agents[agent];
  saveConfig(projectDir, config);
  return had;
}

/**
 * The flags a launch should use: saved defaults first, then whatever was typed
 * on this command line. Typed flags come last so a CLI takes them as the final
 * word, which is what makes the moment able to override the default.
 *
 * That override rests on an assumption worth naming: repeating a flag makes the
 * last occurrence win. It holds for all three agents today and it is how CLIs
 * conventionally behave, but it is convention rather than law. The alternative
 * was a merge language of our own that knows which flags supersede which, and
 * that is a lot of vendor knowledge to invent and then maintain for a case that
 * is already served. If an agent ever takes the first occurrence instead, this
 * is the place that has to learn it.
 */
export function resolveArgs(projectDir, agent, typed = []) {
  const saved = savedArgs(loadConfig(projectDir), agent);
  return { saved, typed, all: [...saved, ...typed] };
}
