import test from "node:test";
import assert from "node:assert/strict";
import { adapterFor, AGENT_IDS } from "../src/agents/index.mjs";

// `bridge --help` is the only place a new user learns what exists, and it is
// assembled by hand around AGENT_IDS. Adding the fourth agent broke it twice at
// once: "antigravity [flags]" was wider than the fixed column, so its
// description ran into its own name, and the line telling people how to hand off
// still listed Codex and Grok only, so the newest agent had no documented way to
// be used at all. Neither was caught, because nothing ever read the help text.

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The lines under "Usage:" and nothing else. The example under "Agent flags"
 * also begins with two spaces and the word bridge, but it is a command someone
 * would type rather than a row in a table, and it has no description column.
 */
function usageRows(help) {
  const lines = strip(help).split("\n");
  const start = lines.findIndex((l) => l.trim() === "Usage:") + 1;
  const rest = lines.slice(start);
  const end = rest.findIndex((l) => !l.trim());
  return rest.slice(0, end === -1 ? rest.length : end).filter((l) => /^ {2}bridge/.test(l));
}

test("every agent appears in the usage block as a way to start", async () => {
  const { HELP } = await import("../src/cli.mjs");
  const plain = strip(HELP);
  for (const id of AGENT_IDS) {
    assert.match(plain, new RegExp(`bridge ${id} \\[flags\\]`), `${id} is not listed as a way to start`);
    assert.ok(plain.includes(adapterFor(id).displayName), `${adapterFor(id).displayName} is never named`);
  }
});

test("no command label runs into its own description", async () => {
  const { HELP } = await import("../src/cli.mjs");
  for (const row of usageRows(HELP)) {
    assert.match(row, /^ {2}bridge.*?\s{2,}\S/, `no gap between label and description: ${JSON.stringify(row)}`);
  }
});

test("descriptions line up in one column, whatever the longest agent is called", async () => {
  const { HELP } = await import("../src/cli.mjs");
  const columns = new Set(usageRows(HELP).map((row) => row.length - row.replace(/^.*?\s{2,}/, "").length));
  assert.equal(columns.size, 1, `descriptions start in ${columns.size} different columns: ${[...columns].join(", ")}`);
});

// Every agent but Claude reaches the bridge through the shared skill, and the
// help has to name each of them. This was the string "Codex, Grok".
test("every non-Claude agent is named as using the shared handoff command", async () => {
  const { HELP } = await import("../src/cli.mjs");
  const line = strip(HELP)
    .split("\n")
    .find((l) => l.includes("$bridge <agent>"));
  assert.ok(line, "the shared skill must be documented at all");
  for (const id of AGENT_IDS.filter((a) => a !== "claude")) {
    assert.ok(line.includes(adapterFor(id).displayName), `${id} is not told how to hand off`);
  }
});
