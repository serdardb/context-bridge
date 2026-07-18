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

Requirements: Node ≥ 18.18, git, Claude Code (logged in), Codex CLI (logged in via `codex login`). macOS is the verified platform.

> `bridge` must be on `PATH`: the Claude plugin hooks and the Codex skill invoke it by name. `bridge doctor` checks this.

## Repository structure

```
bin/bridge.mjs        CLI entry point
src/
  cli.mjs             command dispatch (bridge | claude | codex | doctor | status | handoff | internal-hook)
  state.mjs           .bridge/state.json — versioned, atomic writes
  launcher.mjs        flat child-process loop + idle-safe auto-switch
  handoff.mjs         `bridge handoff codex|claude` business logic
  delta.mjs           deterministic delta extraction (session files + git)
  transfer.mjs        wrapper around the official OpenAI transfer machinery
  discover.mjs        rollout/transcript lookup helpers
  doctor.mjs          environment checks + --fix bootstrap
  hooks.mjs           endpoints for the Claude plugin hooks (stdin JSON)
plugin/               Claude Code plugin (skill /bridge + hooks.json)
codex/SKILL.md        Codex $bridge skill (installed to ~/.agents/skills/bridge)
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

Invoke inside Codex by typing `$bridge claude`. The optional allow-rule (`~/.codex/rules/bridge.rules`) lets Codex run `bridge handoff` without a per-run approval prompt; its format is a single line — Codex rules files do not accept `//` comments:

```
prefix_rule(pattern=["bridge"], decision="allow")
```

## How bridge doctor works

`src/doctor.mjs` collects a result object (installed versions, auth existence-checks, plugin/skill presence, project state health), renders it with a route table, and exits 0 only when the Claude⇄Codex route is READY. `--json` prints the raw object; `--fix` offers confirmed bootstraps using official mechanisms only. Auth checks are existence-only (Keychain entry name, `codex login status` exit code) — never read or print secret values, and keep it that way in any change.

## Testing a handoff end-to-end

Use a throwaway git repository:

```bash
mkdir /tmp/bridge-demo && cd /tmp/bridge-demo && git init
bridge doctor        # route must be READY
bridge               # starts Claude; the SessionStart hook records the session
```

1. Do some real work in Claude (create a file, state a decision).
2. Run `/bridge codex` → Claude should close itself and Codex should open with the context.
3. Do some work in Codex (modify a file, state a decision).
4. Run `$bridge claude` → Codex should close and the original Claude session should resume.
5. Ask Claude *"Where were we?"* — it should describe both its own prior work and Codex's, including decisions.
6. Run `/bridge codex` again — see the next section for what to verify.

Useful inspection points during all of this:

- `bridge status` — link state and pending markers (IDs are masked; `--debug` shows them).
- `.bridge/state.json` — the ground truth the launcher polls.
- `.bridge/checkpoints/` — delta files; delivered ones are renamed `*.consumed`.

## Verifying first-import vs repeat-resume

The single most important behavioral invariant:

- **First** `/bridge codex` for a project → exactly one new entry appears in Codex's import ledger (`~/.codex/external_agent_session_imports.json`) and `.bridge/state.json` gains a `threadId`.
- **Every subsequent** `/bridge codex` → the ledger count for this project **must not change**, the `threadId` **must not change**, and the linked thread opens with a `[Bridge Context Update]` prompt auto-submitted. Ask Codex about something from its earlier turns to confirm the thread's own context survived.

If a change causes a second import, it has broken the product model (each import creates a disconnected new thread).

## Invariants

Treat these as hard rules; changes that violate them should not merge:

1. **Import once.** Never run the official Claude→Codex import for an already-linked pair.
2. **No visible IDs.** Session/thread IDs never appear in user-facing output (debug flags excepted).
3. **No process-name killing.** Never `pgrep`/name-match processes; the launcher may signal only the exact child PID it spawned.
4. **Never SIGKILL** an agent. `SIGTERM` only — both CLIs flush session files on it.
5. **No blind termination.** Auto-exit requires: persisted handoff + confirmed idle (Claude: Stop-hook marker; Codex: rollout turn-completion after the request) + debounce + final state re-read. If idle is uncertain, print guidance and do nothing.
6. **Exactly-once injection.** Pending deltas are consumed atomically (rename before emit); a missing delta file surfaces a warning rather than silence.
7. **No API keys.** Subscription CLIs only; auth detection is existence-only.
8. **No transcripts in bridge state.** References, timestamps, checkpoints and bounded deltas only.

## Compatibility matrix

| Component | Verified | Notes |
|---|---|---|
| Claude Code | 2.1.x (2.1.214) | resume-append semantics, SessionStart `additionalContext`, plugin skills/hooks |
| Codex CLI | 0.143.x | `codex resume <id> "<prompt>"` auto-submit, rollout format, `$skill` invocation, plugin transfer RPC |
| OS | macOS | Linux paths implemented but untested; Windows unsupported |
| Node | ≥ 18.18 | no runtime dependencies |

Both CLIs' session formats are vendor-internal. When a new CLI release changes behavior, re-run the end-to-end handoff test above before assuming compatibility.

## Release checklist

1. `node --check` passes on `bin/**` and `src/**`; `npm pack --dry-run` includes `bin/`, `src/`, `plugin/`, `codex/`, `.claude-plugin/`, `docs/`.
2. Fresh-install path works from a clean checkout: `npm install -g .` → `bridge doctor` → `--fix` → route READY.
3. Full end-to-end handoff test (previous sections), including the repeat-switch ledger check.
4. Hygiene scan: no machine-specific paths, no credentials, no tracked `.bridge/` state.
5. Version bumps kept in sync: `package.json`, `src/cli.mjs` `VERSION`, `plugin/.claude-plugin/plugin.json`.
6. Update README/docs if user-visible behavior changed; commit with the repository-local git identity.
