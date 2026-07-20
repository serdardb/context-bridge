# context-bridge

[![CI](https://github.com/serdardb/context-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/serdardb/context-bridge/actions/workflows/ci.yml)

**Switch agents. Not context.**

Developers increasingly use multiple coding agents — but switching between them usually means losing conversational context, or manually copying summaries, session IDs and file lists from one tool to the other.

**context-bridge connects native coding-agent sessions.** Each agent keeps its own real session; the bridge remembers which sessions belong to the same project and transfers only the context the other agent is missing.

- It does **not** replace Claude Code or Codex.
- It does **not** proxy their APIs.
- It requires **no API keys** — it drives the subscription-authenticated CLIs you already have.

**Supported today: Claude Code, Codex and Grok**, in any of the six directions.

> **Status: developer preview (0.7.1).** The core flow is tested and used daily, but vendor session formats can change under it — treat it as a private-beta tool, not a hardened production release.

## The core UX

One command, wherever you are. Inside **Claude Code**:

```
/bridge codex
/bridge grok
```

Inside **Codex** or **Grok**:

```
$bridge claude
$bridge grok
```

→ the agent you are leaving closes automatically
→ the one you asked for opens automatically, holding the context it was missing

> Tip: if the `$` prefix is awkward on your keyboard layout, just ask in plain
> language — e.g. "switch to claude with the bridge" — and the agent will invoke
> the same skill for you.

Highlights:

- Native sessions on every side — nothing is replaced or wrapped
- **Chains keep their history**: hand Claude → Grok → Codex and Codex receives Grok's work *and* the Claude context Grok was given, labelled by who said it
- Automatic context synchronization (delta-based, not full transcript copies)
- No copy/paste · no session IDs · no manual resume commands
- No API keys · no extra AI billing — your existing subscriptions
- No nested TUIs — a flat launcher owns exactly one agent at a time

## Why context-bridge

One direction already exists officially: OpenAI ships a Claude Code plugin and Codex's `/import` that can turn a Claude session into a Codex thread. context-bridge **uses** that official machinery where it exists — and adds everything around it:

1. **The way back.** Nothing official returns another agent's context to your *original* session. The bridge extracts what changed (conversation, decisions, files, git) and injects it on resume, through each agent's own mechanism.
2. **Repeat switching.** Re-importing creates a brand-new thread every time (we verified this). The bridge links each agent **once**, remembers the session, and afterwards syncs with compact deltas into the *same* sessions.
3. **Chains, not just pairs.** With three agents there are six directions, and a hop must not cost you the hop before it. The bridge tracks what each agent has already been told, by each other agent, so a handoff carries everything the target missed no matter who produced it.
4. **Zero session management.** Session discovery, thread capture, resume commands, injection — all automatic. You only ever type `/bridge <agent>` or `$bridge <agent>`.

**Honest about the asymmetry:** only Claude → Codex has an official import, which seeds the new thread with the whole session. Every other first switch opens a fresh session whose opening prompt is the full un-clipped conversation instead. The knowledge is equal; the session shape is not.

## How it works

```
shell
└── bridge                     ← launcher (Node CLI, zero dependencies)
    └── one agent child at a time
        claude ⇄ codex ⇄ grok  ← real TUIs, real sessions, any direction

.bridge/state.json             ← per-project: native session references, the
                                 knownBy matrix, git checkpoint, pending markers
                                 (never transcripts; auto-gitignored)
```

- `/bridge <agent>` (a Claude plugin skill) and `$bridge <agent>` (a shared skill for Codex and Grok) are the same command with a target argument. The departing agent writes down its decisions and open questions, the bridge computes what the target is missing from every agent's native session files plus git, and delivers it as a bounded 4-section delta (Conversation / Decisions / Work / Next).
- **Delivery uses whatever each agent supports.** Codex and Grok take the delta as an auto-submitted resume prompt; Claude has no such argument, so it arrives through the official `SessionStart` hook instead — exactly once.
- Later deltas can ship a **temporary full-context companion** in `.bridge/checkpoints/`, referenced from the delta itself. The bounded summary keeps handoffs fast; exact wording is available **during the receiving session** if the clipped one-liners aren't enough. Companions are delivery artifacts, not an archive: they may be pruned after that agent hands off (or by a small newest-N backstop). Canonical memory is each agent's native transcript plus the `knownBy` matrix.
- **Agent flags pass straight through.** `bridge claude --dangerously-skip-permissions --model claude-fable-5` forwards everything after the agent name to that agent verbatim, so any flag it supports (now or later) just works. The set is remembered per agent for the launcher run and re-applied on every switch back, but never written to disk, so a permission-bypass flag cannot quietly return tomorrow. The only args the bridge holds back are the ones that would break its own session link (`-c`, `--resume`, `--fork-session`, `--no-session-persistence` on Claude; `--last`, `--cd`, `--remote` on Codex), each dropped with a printed reason. `--cb-*` is reserved for the bridge itself.
- **A handoff carries what the target missed, from everyone.** The bridge remembers, per pair, how far into each agent's own stream it has packed material for each other agent. So Claude → Grok → Codex works: Codex receives Grok's work *and* the Claude context Grok was given, each block labelled with who said it, instead of losing a hop's worth of history at every switch. Nothing is sent to an agent twice.
- **Checkpoints are delivery artifacts, not memory.** A handoff to an agent that already has an undelivered one replaces it. The un-truncated companions delivered to an agent are dropped when that agent hands off, which proves it had a live session and finished reading them; a small newest-N cap backstops a target that never hands off again. Bounded deltas are kept longer for auditing (7 days and the newest 20), and a pending injection is never deleted. `bridge clean` (with `--dry-run`, `--keep N`, `--days N`, `--all`) does the same on demand. Canonical memory is each agent's native transcript plus the `knownBy` matrix, never these files.
- The launcher watches the state file. When a handoff is ready **and the agent's turn has finished**, it terminates its own child process (SIGTERM, never by name, never SIGKILL) and starts the other agent. Terminal state stays healthy; Ctrl+C inside an agent behaves normally. It also records which state version it understands, so a launcher left running across an upgrade is told to restart rather than silently failing to switch.
- **Started without the bridge?** Sessions can be adopted mid-flight. `$bridge claude` inside a Codex session that was never linked adopts it automatically (Codex exposes the running thread via `CODEX_THREAD_ID`); if that variable is unavailable, the newest Codex session working in the project directory is offered as a candidate and linked only after you confirm (`--adopt`). Codex-first projects work too: with no Claude session to resume, the delta — plus a pointer to the full Codex transcript — seeds the first Claude session that starts in the project. The rule everywhere: **automatic when identity is deterministic, confirmed when heuristic.**

## Requirements

- macOS (verified on macOS; Linux is untested, Windows unsupported)
- Node.js ≥ 18.18
- At least two of the supported agents, logged in:
  - [Claude Code](https://code.claude.com/docs/en/setup) ≥ 2.1.x, with your Claude subscription
  - [Codex CLI](https://developers.openai.com/codex) ≥ 0.143.0, with your ChatGPT subscription (`codex login`)
  - [Grok CLI](https://github.com/superagent-ai/grok-cli) ≥ 0.2.x, with your xAI key (`grok auth`)
- `git` (used for the work-delta; projects without git still work, with a thinner delta)

## Installation

```bash
git clone https://github.com/SerdarDB/context-bridge.git
cd context-bridge
npm install -g .

bridge doctor        # see what's present and what's missing
bridge doctor --fix  # bootstrap the missing pieces (asks before each change)
```

`bridge doctor --fix` can install, with your confirmation, using only official mechanisms:

- the **context-bridge Claude plugin** (provides `/bridge` + session hooks)
- the **official OpenAI Codex plugin** for Claude Code (`openai/codex-plugin-cc`, used for the first import)
- the **$bridge agent skill** (`~/.agents/skills/bridge/SKILL.md`, shared by Codex and Grok)
- an optional Codex allow-rule so `bridge handoff` runs without an approval prompt

Agent-specific steps are only offered for agents you actually have installed.

Nothing is mutated without confirmation, and no secrets are ever read or printed.

## bridge doctor

```
Context Bridge Doctor

Claude Code
  ✓ Installed: 2.1.215 (Claude Code)
  ✓ Authenticated (you@example.com)
  ✓ context-bridge plugin installed (provides /bridge and the session hooks)
  ✓ Official OpenAI Codex plugin installed (seeds the first Claude→Codex switch)

Codex
  ✓ Installed: codex-cli 0.144.6
  ✓ Authenticated (Logged in using ChatGPT)
  ✓ $bridge skill installed and current (~/.agents/skills/bridge)
  ✓ bridge command pre-allowed in Codex rules

Grok
  ✓ Installed: grok 0.2.106
  ✓ Authenticated
  ✓ $bridge skill installed and current (~/.agents/skills/bridge)

Bridge
  ✓ bridge on PATH (hooks can reach it)
  ✓ Project state: linked claude, codex, grok

Available routes
  claude->codex      ✓ READY  first switch: official import
  claude->grok       ✓ READY  first switch: delta-seeded
  codex->claude      ✓ READY  first switch: delta-seeded
  codex->grok        ✓ READY  first switch: delta-seeded
  grok->claude       ✓ READY  first switch: delta-seeded
  grok->codex        ✓ READY  first switch: delta-seeded
```

On a fresh machine the plugin/skill rows start as `✗` with the exact official command next to each; `--fix` offers to run them for you. `--deep` goes further and asks each agent a real one-line question, because installed and authenticated is not the same as working: vendors change headless flags between releases.

## First run

```bash
cd your-project
bridge              # Claude Code, the default
bridge grok         # or start on any supported agent
```

`bridge` starts (or resumes) that agent as its child, and forwards any flags you add straight to it (`bridge claude --dangerously-skip-permissions`). Work normally; the session is recorded automatically and you never see an ID.

## Switching

From inside whichever agent you are in:

```
/bridge codex          # in Claude Code
$bridge grok           # in Codex or Grok
```

The departing agent records its decisions and open questions, the bridge packs everything the target has not seen yet, that agent's turn ends, and the launcher closes it and opens the target on the same project.

The first switch to an agent links it: Claude → Codex uses the official OpenAI transfer, and every other pair opens a new session seeded with the full conversation. After that a switch is a resume plus a compact delta — no re-import, same sessions, prior context intact.

Coming back is the same command in the other direction. Ask the agent *"where were we?"* and it knows, including what happened in an agent you never spoke to on this hop.

Each delta costs the receiving agent one short acknowledgment sentence — that is the entire overhead.

## Architecture

| Piece | What it is |
|---|---|
| `bridge` CLI | Zero-dependency Node CLI: launcher loop, state, deltas, doctor |
| `.bridge/state.json` | Versioned per-project state: session references, sync watermarks, git checkpoint, pending markers. Migrated forward automatically, with a backup. Never transcripts. Auto-gitignored. |
| `src/agents/` | One adapter per agent: discovery, resume command, activity parsing, idle signal, conflicting flags, health. Adding an agent is one file. |
| `knownBy` matrix | Per pair, how far into each agent's own stream has been packed for each other agent. This is what makes chains keep their history. |
| Claude plugin | `/bridge` skill + `SessionStart` / `Stop` / `UserPromptSubmit` hooks (session recording, delta injection, idle marking) |
| Shared agent skill | `$bridge <agent>` for Codex and Grok → runs `bridge handoff <agent>` |
| Official import | The first Claude→Codex switch uses OpenAI's `codex-plugin-cc` transfer (`externalAgentConfig/import` under the hood) |

Full design details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · contributing: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Privacy and security

- Everything is local. No SaaS, no accounts, no telemetry, no database server.
- No API keys are read, requested, or stored. Auth detection checks *existence* only (e.g. Keychain entry name, `codex login status`) and never touches secret values.
- `.bridge/` holds references, timestamps and bounded delta files — not full transcripts — and is added to your `.gitignore` automatically.
- Context deltas travel only between your two local CLIs, inside their normal subscription-authenticated calls.

## Compatibility

Verified against: **Claude Code 2.1.215**, **codex-cli 0.144.6** and **grok 0.2.106** on macOS (Node 23). Each vendor's session format is internal; the bridge parses them defensively, but a future CLI release could require an update — pin these versions if you need stability.

## Known limitations

- Verified on **macOS only**; Linux paths exist but are untested; Windows is unsupported.
- One linked session per agent per project (no `bridge unlink` yet — delete `.bridge/` to relink).
- Only Claude → Codex has an official first-switch import; other first switches seed a new session with the full conversation as its opening prompt.
- An agent's own dialogs (folder trust, update prompts) can appear before a resumed session; answer them once and the flow continues.
- A launcher left running across a bridge upgrade cannot read the newer state file. It says so and asks to be restarted; the pending handoff is preserved.
- Decision/Next quality depends on the departing agent following its handoff instructions; Conversation/Work sections are deterministic from session files and git regardless.
- If you run `claude`/`codex` outside the `bridge` launcher, handoffs still record state, but the actual switch is manual (the handoff message tells you exactly what to run).
- **This is an early developer preview — not production-ready.**

## Roadmap

- Per-agent flags at launch and at handoff time (`bridge claude --dangerously-skip-permissions` works today; arming a second agent in the same run does not yet)
- `bridge unlink` / multi-pair support
- Linux verification, Windows support
- npm package (`npm install -g context-bridge`)
- Optional MCP quick-question mode (ask the other agent without switching)

## Development status

0.7.1 — developer preview. Round-trips across all three agents (repeatedly, without re-import) pass real end-to-end tests on macOS, and the bridge is developed with itself: Claude, Codex and Grok hand this repo's work back and forth through it daily, including three-agent review rounds where each one's findings reach the next.

Since the first release:

- **Adopt flow** — sessions started outside the bridge can be linked mid-flight (deterministic via `CODEX_THREAD_ID`, confirmed when heuristic)
- **Full-context checkpoints** — every delta ships with an un-truncated companion, so long prose survives a handoff
- **Three agents, six directions** — Grok joined behind an adapter contract, and a `knownBy` matrix keeps chains from dropping the hop before last
- **Regression suite + CI** — `node:test` coverage over parsers, discovery, adopt paths and hooks, gated on ubuntu+macos × Node 18/20/22
- **Checkpoint retention** — checkpoints are delivery artifacts: a companion is dropped once its reader has handed off, with `bridge clean` as the manual backstop

Design details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); contributions are welcome via [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

MIT © SerdarDB
