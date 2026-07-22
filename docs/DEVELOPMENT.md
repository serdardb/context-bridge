# Developing context-bridge

Contributor guide. For the design itself, read [ARCHITECTURE.md](./ARCHITECTURE.md) first.

## Local setup

```bash
git clone https://github.com/SerdarDB/context-bridge.git
cd context-bridge
npm install -g .     # installs the `bridge` binary (a copy)
# or, to have edits take effect immediately during development:
npm link
```

Requirements: Node ≥ 18.18, git, and at least two of Claude Code, Codex CLI (`codex login`) and Grok CLI (`grok auth`), logged in. macOS is the verified platform.

> `bridge` must be on `PATH`: the Claude plugin hooks and the Codex skill invoke it by name. `bridge doctor` checks this.

## Repository structure

```
bin/bridge.mjs        CLI entry point
src/
  cli.mjs             command dispatch (bridge | claude | codex | grok | doctor | status | clean | handoff | internal-hook)
  agents/             one adapter per agent; the only place vendor knowledge lives
    index.mjs         the registry and the contract every adapter implements
    claude.mjs codex.mjs grok.mjs
  state.mjs           .bridge/state.json — versioned, atomic writes, forward migrations
  config.mjs          .bridge/config.json — per-agent launch flags
  launcher.mjs        flat child-process loop, session linking, idle-safe auto-switch
  handoff.mjs         `bridge handoff <agent>` for every direction
  delta.mjs           deterministic delta extraction (session files + git)
  delivery.mjs        which road a delta takes, and how a trim stays readable
  probe.mjs           the parser canary shared by every adapter
  clean.mjs           checkpoint retention: deltas are delivery artifacts
  transfer.mjs        wrapper around the official OpenAI transfer machinery
  discover.mjs        rollout/transcript lookup helpers
  doctor.mjs          environment checks + --fix bootstrap
  hooks.mjs           hook endpoints for Claude and Codex (stdin JSON)
plugin/               Claude Code plugin (skill /bridge + hooks.json)
codex/SKILL.md        shared $bridge skill for Codex and Grok (~/.agents/skills/bridge)
.claude-plugin/       marketplace manifest — the repo doubles as a Claude plugin marketplace
docs/                 this documentation
```

No runtime dependencies; plain Node ESM throughout.

## Running from source

```bash
node bin/bridge.mjs --help
node bin/bridge.mjs doctor
```

or via the linked global `bridge`.

## Installing the Claude plugin locally

The repository root is itself a Claude plugin marketplace:

```bash
claude plugin marketplace add /absolute/path/to/context-bridge
claude plugin install bridge@context-bridge
```

After changing plugin files, bump `plugin/.claude-plugin/plugin.json`'s `version`, then:

```bash
claude plugin marketplace update context-bridge
claude plugin update bridge@context-bridge
```

New sessions pick up the update (or use `/reload-plugins` inside a session).

Notes that matter:

- The `/bridge` entry ships as a plugin **skill** whose name equals the plugin name — that is what makes it resolve as plain `/bridge`; plugin *commands* are always namespaced (`/plugin:command`).
- Hooks are declared in `plugin/hooks/hooks.json` and call `bridge internal-hook <event>`; they silently no-op in projects without `.bridge/` state.

## Installing/testing the Codex skill locally

```bash
bridge doctor --fix        # offers to install it, plus an optional allow-rule
# or manually:
mkdir -p ~/.agents/skills/bridge && cp codex/SKILL.md ~/.agents/skills/bridge/
```

Invoke inside Codex or Grok by typing `$bridge <agent>`. The optional allow-rule (`~/.codex/rules/bridge.rules`) lets Codex run `bridge handoff` without a per-run approval prompt; its format is a single line — Codex rules files do not accept `//` comments:

```
prefix_rule(pattern=["bridge"], decision="allow")
```

## How bridge doctor works

`src/doctor.mjs` collects a result object and renders it. Everything it reports is generated from the adapter registry, so a fourth agent appears in the health rows and in all its directed routes without touching this file.

Read the wording as load-bearing. A route says `CONFIGURED`, meaning installed, configured, and its session still parses; it used to say `READY`, which people reasonably read as proof that a switch would work. `--deep` asks each agent a real one-line question and reports `LIVE` or `BROKEN`. Two canaries run by default and cost about 98ms: one checks that each adapter can still read its linked session, the other that its discovery reader can still name what is stored on disk. An unreadable session takes its routes off green and the exit code with it.

`--json` prints the raw object; `--fix` offers confirmed bootstraps using official mechanisms only. Auth checks are existence-only (Keychain entry name, `codex login status` exit code) and never read or print secret values. Keep it that way.

## Testing a handoff end-to-end

Use a throwaway git repository:

```bash
mkdir /tmp/bridge-demo && cd /tmp/bridge-demo && git init
bridge doctor        # routes must be CONFIGURED
bridge               # starts Claude; the SessionStart hook records the session
```

1. Do some real work in Claude (create a file, state a decision).
2. Run `/bridge codex` → Claude should close itself and Codex should open with the context.
3. Do some work in Codex (modify a file, state a decision).
4. Run `$bridge claude` → Codex should close and the original Claude session should resume.
5. Ask Claude *"Where were we?"* — it should describe both its own prior work and Codex's, including decisions.
6. Run `/bridge codex` again — see the next section for what to verify.
7. Then `$bridge grok`, and ask Grok what Claude decided. A chain that only carried the previous hop would fail here, which is the whole point of `knownBy`.

Useful inspection points during all of this:

- `bridge status` — where you are, the recent switches, and what each agent is holding. Session ids and raw watermarks are not shown at all; `--debug` adds them.
- `.bridge/state.json` — the ground truth the launcher polls.
- `.bridge/checkpoints/` — delta files; delivered ones are renamed `*.consumed`.

## Verifying first-import vs repeat-resume

The single most important behavioral invariant:

- **First** `/bridge codex` for a project → exactly one new entry appears in Codex's import ledger (`~/.codex/external_agent_session_imports.json`) and `agents.codex.id` appears in `.bridge/state.json`.
- **Every subsequent** `/bridge codex` → the ledger count for this project **must not change**, the id **must not change**, and the linked thread receives the delta. Where it arrives depends on the road: with Codex hooks installed and trusted the delta lands inside the conversation and the command line stays bare, otherwise it rides as the opening prompt. Ask Codex about something from its earlier turns to confirm the thread's own context survived.

If a change causes a second import, it has broken the product model (each import creates a disconnected new thread).

## Invariants

Treat these as hard rules; changes that violate them should not merge:

1. **Import once.** Never run the official Claude→Codex import for an already-linked pair.
2. **No visible IDs.** Session/thread IDs never appear in user-facing output (debug flags excepted).
3. **No process-name killing.** Never `pgrep`/name-match processes; the launcher may signal only the exact child PID it spawned.
4. **Never SIGKILL** an agent. `SIGTERM` only — both CLIs flush session files on it.
5. **No blind termination.** Auto-exit requires: persisted handoff + confirmed idle + debounce + final state re-read. Idle comes from the agent's own Stop hook where one exists, and from parsing its session file otherwise; both paths stay, because hooks do not run until they are trusted. If idle is uncertain, print guidance and do nothing.
6. **Exactly-once injection.** Pending deltas are consumed atomically (rename before emit); a missing delta file surfaces a warning rather than silence.
7. **One road per delta.** `pendingInjection.via` decides hook or prompt, and exactly one deliverer honours it. Never let both carry the same delta.
8. **No API keys.** Subscription CLIs only; auth detection is existence-only.
9. **No transcripts in bridge state.** References, timestamps, checkpoints and bounded deltas only.
10. **Nothing enumerates agents by hand.** Iterate the adapter registry. A retention rule that hard-coded one pair meant Grok's checkpoints were never pruned at all.
11. **Watermarks are opaque.** Persist what an adapter returns, hand it back untouched, never compare across agents.
12. **Never claim what is not observed.** A green tick, an "installed" that implies "works", a "delivered" that implies "read": each of those has already been wrong here once.

## Compatibility matrix

| Component | Verified | Notes |
|---|---|---|
| Claude Code | 2.1.x (2.1.216) | resume-append semantics, SessionStart `additionalContext`, plugin skills/hooks |
| Codex CLI | 0.144.x | `codex resume <id>` auto-submit, rollout format, `$skill` invocation, plugin transfer RPC, hooks with `additionalContext` (trusted once via `/hooks`) |
| Grok CLI | 0.2.x | resume by id, per-project session directories, live `active_sessions.json`; hooks fire but ignore stdout for passive events |
| OS | macOS | Linux paths implemented, suite runs there in CI, vendor layouts unverified; Windows unsupported |
| Node | ≥ 18.18 | no runtime dependencies |

Every CLI's session format is vendor-internal. When a new CLI release changes behavior, re-run the end-to-end handoff test above before assuming compatibility.

## Release checklist

1. `npm test` and `npm run check` pass. `prepublishOnly` runs both before any publish, so a broken build cannot reach the registry by accident.
2. `npm pack --dry-run` includes `bin/`, `src/`, `plugin/`, `codex/`, `.claude-plugin/`, `docs/`.
3. Fresh-install path works from a clean checkout: `npm install -g .` → `bridge doctor` → `--fix` → routes CONFIGURED. Worth doing from a packed tarball into an isolated prefix at least once per release, since `REPO_ROOT` resolves differently under `node_modules`.
4. Full end-to-end handoff test, including the repeat-switch ledger check and one three-agent chain.
5. Hygiene scan: no machine-specific paths, no credentials, no tracked `.bridge/` state.
6. Version bumps kept in sync across all four: `package.json`, `src/cli.mjs` `VERSION`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.
7. Update README and docs if user-visible behaviour changed. The published package is `@serdardb/context-bridge`, because the plain name belongs to an unrelated library; publishing needs `--access public`.
