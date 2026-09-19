#!/usr/bin/env node
// Publishes this repository's reference documentation to dogrubakar.com.
//
// Two sources, deliberately split. The command tables are parsed out of
// `bridge --help`, so a command that changes its flags cannot keep an old
// description on the website. The prose around them lives in docs/site/*.md,
// next to the code it explains, and is edited in the same commit as the
// behaviour it describes.
//
// Nothing is written here by hand, which is the point: a second copy of a
// command list is a copy that drifts, and this project has already published
// the article about what that costs.
//
//   node scripts/publish-docs.mjs --dry-run
//   CONTENT_API_TOKEN=... node scripts/publish-docs.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = process.env.CONTENT_API_URL ?? "https://dogrubakar.com";
const PROJECT = "context-bridge";

/** Which commands belong to which page, in reading order. */
const PAGES = [
  { slug: "getting-started", title: "Getting started", match: [/^bridge$/, /^bridge (claude|codex|grok|antigravity|opencode)\b/] },
  { slug: "health-checks", title: "Doctor, verify and adapters", match: [/^bridge (doctor|verify|adapters|eval)\b/] },
  { slug: "handoffs", title: "Handoffs", match: [/^bridge (handoff|inspect|unlink|clean)\b/] },
  { slug: "lanes", title: "Lanes and worktrees", match: [/^bridge lane\b/] },
  { slug: "storage", title: "Storage and migration", match: [/^bridge storage\b/] },
  { slug: "projects", title: "Project lifecycle", match: [/^bridge project\b/] },
  { slug: "artifacts", title: "Portable and sealed context", match: [/^bridge artifact\b/] },
  { slug: "sharing", title: "Sharing sealed bundles", match: [/^bridge share\b/] },
  { slug: "observing", title: "Status, search and watch", match: [/^bridge (status|search|watch)\b/] },
  { slug: "mcp", title: "MCP companion", match: [/^bridge mcp\b/] },
  { slug: "releasing", title: "Release gates", match: [/^bridge release-/] },
];

/**
 * `bridge --help` as structured rows.
 *
 * The help text is two columns of fixed width with wrapped continuation lines,
 * so a line that starts a command is one beginning with `bridge` and everything
 * after it until the next such line is more of its description.
 */
function commands() {
  const help = execFileSync(process.execPath, [path.join(root, "bin/bridge.mjs"), "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

  const rows = [];
  for (const line of help.split("\n")) {
    const started = line.match(/^ {2}(bridge(?: [^\s].*?)?)\s{2,}(.+)$/);
    if (started) {
      rows.push({ cmd: started[1].trim(), text: started[2].trim() });
      continue;
    }
    const continued = line.match(/^ {30,}(\S.*)$/);
    if (continued && rows.length) rows[rows.length - 1].text += " " + continued[1].trim();
  }
  return rows;
}

function table(rows) {
  if (!rows.length) return "";
  const out = ["| Command | What it does |", "| --- | --- |"];
  for (const r of rows) out.push(`| \`${r.cmd}\` | ${r.text.replace(/\|/g, "\\|")} |`);
  return out.join("\n");
}

function prose(slug) {
  const file = path.join(root, "docs/site", `${slug}.md`);
  if (!fs.existsSync(file)) throw new Error(`Missing prose for ${slug}: docs/site/${slug}.md`);
  const raw = fs.readFileSync(file, "utf8");
  const summary = raw.match(/^>\s*(.+)$/m)?.[1]?.trim();
  if (!summary) throw new Error(`docs/site/${slug}.md needs a one-line summary as a leading blockquote.`);
  return { summary, body: raw.replace(/^>\s*.+$/m, "").trim() };
}

async function publish(page, index, dryRun) {
  const { summary, body } = prose(page.slug);
  const rows = commands().filter((r) => page.match.some((m) => m.test(r.cmd)));

  const markdown = [body, rows.length ? "## Commands\n\n" + table(rows) : ""]
    .filter(Boolean)
    .join("\n\n") + `\n\nGenerated from \`bridge --help\` at ${version()}.\n`;

  if (dryRun) {
    console.log(`${page.slug}: ${rows.length} commands, ${markdown.length} bytes — ${summary}`);
    return;
  }

  const response = await fetch(`${SITE}/api/docs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "context-bridge-docs",
    },
    body: JSON.stringify({
      project: PROJECT,
      slug: page.slug,
      title: page.title,
      summary,
      body: markdown,
      status: "published",
      sort_order: (index + 1) * 10,
    }),
  });

  if (!response.ok) throw new Error(`${page.slug}: ${response.status} ${await response.text()}`);
  console.log(`${response.status} ${page.slug} (${rows.length} commands)`);
}

function version() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
}

function token() {
  const value = process.env.CONTENT_API_TOKEN;
  if (!value) throw new Error("CONTENT_API_TOKEN is required. It is not stored in this repository.");
  return value;
}

const dryRun = process.argv.includes("--dry-run");
for (const [index, page] of PAGES.entries()) await publish(page, index, dryRun);
console.log(dryRun ? "Dry run: nothing published." : `Published ${PAGES.length} pages for ${PROJECT} ${version()}.`);
