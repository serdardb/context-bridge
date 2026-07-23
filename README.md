# context-bridge

[![npm](https://img.shields.io/npm/v/@serdardb/context-bridge)](https://www.npmjs.com/package/@serdardb/context-bridge)
[![CI](https://github.com/serdardb/context-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/serdardb/context-bridge/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@serdardb/context-bridge)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@serdardb/context-bridge)](LICENSE)

**Switch agents. Not context.**

Developers increasingly use multiple coding agents — but switching between them usually means losing conversational context, or manually copying summaries, session IDs and file lists from one tool to the other.

**context-bridge connects native coding-agent sessions.** Each agent keeps its own real session; the bridge remembers which sessions belong to the same project and transfers only the context the other agent is missing.

- It does **not** replace Claude Code, Codex, Grok or Antigravity.
- It does **not** proxy their APIs.
- It requires **no API keys** — it drives the subscription-authenticated CLIs you already have.

**Supported today: Claude Code, Codex, Grok and Antigravity**, in any of the twelve directions.

🎥 **Walkthrough:** [watch the original install-and-switch demo on X](https://x.com/SerdarDB/status/2078981172080574900). It was recorded with Claude Code and Codex, before Grok, Antigravity and `bridge inspect` were added, so it shows the flow rather than the current full set.

> **Status: developer preview (0.9.0).** The core flow is tested and used daily, but vendor session formats can change under it — treat it as a private-beta tool, not a hardened production release.

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
3. **Chains, not just pairs.** With four agents there are twelve directions, and a hop must not cost you the hop before it. The bridge tracks what each agent has already been told, by each other agent, so a handoff carries everything the target missed no matter who produced it.
4. **Zero session management.** Session discovery, thread capture, resume commands, injection — all automatic. You only ever type `/bridge <agent>` or `$bridge <agent>`.

**Honest about the asymmetry.** The first switch to an agent has to create something, for every tool that does this, because the target has no session yet: Claude → Codex uses OpenAI's official import, and the others open a new session seeded with the conversation. After that first switch the agents differ in how a handoff reaches them, and the difference is worth stating plainly rather than glossing:

| | how a delta arrives | why |
|---|---|---|
| Claude Code | its `SessionStart` hook | the conversation continues; nothing is pasted in front of it |
| Codex | its `SessionStart` hook | same, once you have trusted the hooks with `/hooks` |
| Grok | the opening prompt of the resumed session | its hooks exist but ignore what they print, so nothing can be injected |
| Antigravity | the opening prompt of the resumed session | it ships no hook mechanism to inject through |

The knowledge is equal in all four. The session shape is not, and the prompt-seeded cases are limits in those agents rather than something waiting to be built here.

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

- `/bridge <agent>` (a Claude plugin skill) and `$bridge <agent>` (a shared skill for Codex, Grok and Antigravity) are the same command with a target argument. The departing agent writes down its decisions and open questions, the bridge computes what the target is missing from every agent's native session files plus git, and delivers it as a bounded 4-section delta (Conversation / Decisions / Work / Next).
- **Delivery uses whatever each agent supports.** Claude and Codex take the delta through their own `SessionStart` hook, so it lands inside the conversation; Codex falls back to an auto-submitted resume prompt until you have trusted its hooks once with `/hooks`, and Grok always uses the prompt, because its hooks fire but ignore what they print. Either road delivers exactly once, and only ever one of them per handoff.
- Later deltas can ship a **temporary full-context companion** in `.bridge/checkpoints/`, referenced from the delta itself. The bounded summary keeps handoffs fast; exact wording is available **during the receiving session** if the clipped one-liners aren't enough. Companions are delivery artifacts, not an archive: they may be pruned after that agent hands off (or by a small newest-N backstop). Canonical memory is each agent's native transcript plus the `knownBy` matrix.
- **Agent flags pass straight through.** `bridge claude --dangerously-skip-permissions --model claude-fable-5` forwards everything after the agent name to that agent verbatim, so any flag it supports (now or later) just works. The set applies to that launch. `--cb-save-args` writes it to `.bridge/config.json` as this project's default, `--cb-clear-args` takes it back, and `bridge status` lists what is armed, because a saved permission bypass nobody can find is one nobody can undo. Flags that change what an agent may do without asking are announced on a plain line at every launch. The only args the bridge holds back are the ones that would break its own session link (`-c`, `--resume`, `--fork-session`, `--no-session-persistence` on Claude; `--last`, `--cd`, `--remote` on Codex), each dropped with a printed reason. `--cb-*` is reserved for the bridge itself.
- **A handoff carries what the target missed, from everyone.** The bridge remembers, per pair, how far into each agent's own stream it has packed material for each other agent. So Claude → Grok → Codex works: Codex receives Grok's work *and* the Claude context Grok was given, each block labelled with who said it, instead of losing a hop's worth of history at every switch. Nothing is sent to an agent twice.
- **Checkpoints are delivery artifacts, not memory.** A handoff to an agent that already has an undelivered one replaces it. The un-truncated companions delivered to an agent are dropped when that agent hands off, which means it had a live session in which they were available to it, not that anyone watched it read them; a small newest-N cap backstops a target that never hands off again. Bounded deltas are kept longer for auditing (7 days and the newest 20), and a pending injection is never deleted. `bridge clean` (with `--dry-run`, `--keep N`, `--days N`, `--all`) does the same on demand. Canonical memory is each agent's native transcript plus the `knownBy` matrix, never these files.
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
npm install -g @serdardb/context-bridge

bridge doctor        # see what's present and what's missing
bridge doctor --fix  # bootstrap the missing pieces (asks before each change)
```

The plain `context-bridge` name on npm belongs to an unrelated library, so the
package is published under a scope. Everything else keeps the name: the repo, the
command, the plugin.

To work on the bridge itself, install from a clone instead:

```bash
git clone https://github.com/SerdarDB/context-bridge.git
cd context-bridge
npm install -g .
```

`bridge doctor --fix` can install, with your confirmation, using only official mechanisms:

- the **context-bridge Claude plugin** (provides `/bridge` + session hooks)
- the **official OpenAI Codex plugin** for Claude Code (`openai/codex-plugin-cc`, used for the first import)
- the **$bridge agent skill** (`~/.agents/skills/bridge/SKILL.md`, shared by Codex, Grok and Antigravity)
- an optional Codex allow-rule so `bridge handoff` runs without an approval prompt

Agent-specific steps are only offered for agents you actually have installed.

Nothing is mutated without confirmation, and no secrets are ever read or printed.

## bridge doctor

```
Context Bridge Doctor

Claude Code
  ✓ Installed: 2.1.216 (Claude Code)
  ✓ Authenticated (you@example.com)
  ✓ context-bridge plugin installed (provides /bridge and the session hooks)
  ✓ Official OpenAI Codex plugin installed (seeds the first Claude→Codex switch)
  ✓ Session readable by this version of the bridge (884 messages)

Codex
  ✓ Installed: codex-cli 0.144.6
  ✓ Authenticated (Logged in using ChatGPT)
  ⚠ Session hooks not installed (optional: they make Codex session linking exact)
  ✓ $bridge skill installed and current (~/.agents/skills/bridge)
  ✓ bridge command pre-allowed in Codex rules
  ✓ Session readable by this version of the bridge (417 messages)

Grok
  ✓ Installed: grok 0.2.106
  ✓ Authenticated
  ✓ $bridge skill installed and current (~/.agents/skills/bridge)
  ✓ Session readable by this version of the bridge (104 messages)

Bridge
  ✓ bridge on PATH (hooks can reach it)
  ✓ Project state: linked claude, codex, grok

Available routes
  claude->codex      ✓ CONFIGURED  first switch: official import
  claude->grok       ✓ CONFIGURED  first switch: delta-seeded
  codex->claude      ✓ CONFIGURED  first switch: delta-seeded
  codex->grok        ✓ CONFIGURED  first switch: delta-seeded
  grok->claude       ✓ CONFIGURED  first switch: delta-seeded
  grok->codex        ✓ CONFIGURED  first switch: delta-seeded

CONFIGURED means installed, configured, and its session still parses. It does not mean the agent answers: run `bridge doctor --deep` to ask each one a real question.
```

On a fresh machine the plugin/skill rows start as `✗` with the exact official command next to each; `--fix` offers to run them for you.

The wording is deliberate. `CONFIGURED` means installed, logged in, and *its session files still parse with this version of the bridge*. That last check runs by default and costs about 100ms, because it is the failure nobody would otherwise notice: session formats are internal to each vendor, so a renamed field ships in a point release and every handoff quietly returns an empty delta while the binary is still installed and still logged in. If that happens the row reads `Session UNREADABLE` and every route through that agent carries the reason.

The same check covers the other reader. Finding a session and reading one are different pieces of code, and the second kind of failure is just as quiet: if sessions are stored on disk and not one of them can be named, discovery has gone blind and doctor says so. A project with nothing stored stays neutral.

What `CONFIGURED` still cannot promise is that the agent answers. `bridge doctor --deep` asks each one a real one-line question and reports `LIVE` or `BROKEN`; it is not the default because it is slow and depends on the network.

## First run

```bash
cd your-project
bridge              # Claude Code, the default
bridge grok         # or start on any supported agent
```

`bridge` starts (or resumes) that agent as its child, and forwards any flags you add straight to it (`bridge claude --dangerously-skip-permissions`). Work normally; the session is recorded automatically and you never see an ID.

A session the bridge starts is a session the bridge can return to: it links what it launched, while the agent is still running and once more when it exits, so `bridge grok` later resumes that same conversation instead of opening a new one. If you happen to have a second session of the same agent open elsewhere, it links neither and says so rather than guessing.

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
| `.bridge/state.json` | Versioned per-project state: session references, sync watermarks, git checkpoint, pending markers. Migrated forward automatically, keeping the original as `state.json.v<n>.backup` and saying so once. Never transcripts. Auto-gitignored. |
| `src/agents/` | One adapter per agent: discovery, resume command, activity parsing, idle signal, conflicting flags, health. Adding an agent is one file. |
| `knownBy` matrix | Per pair, how far into each agent's own stream has been packed for each other agent. This is what makes chains keep their history. |
| Claude plugin | `/bridge` skill + `SessionStart` / `Stop` / `UserPromptSubmit` hooks (session recording, delta injection, idle marking) |
| Codex hooks | The same three events in `~/.codex/hooks.json`, installed by `doctor --fix` and merged into whatever is already there. Each hook names the agent it belongs to, so one firing inside a different CLI refuses instead of writing the wrong session into state. |
| Shared agent skill | `$bridge <agent>` for Codex, Grok and Antigravity → runs `bridge handoff <agent>` |
| Official import | The first Claude→Codex switch uses OpenAI's `codex-plugin-cc` transfer (`externalAgentConfig/import` under the hood) |
| `.bridge/config.json` | Per-agent launch flags for this project. Written by `--cb-save-args`, never by hand, listed in `bridge status`, and cleared with `--cb-clear-args`. |

Full design details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · contributing: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Privacy and security

- Everything is local. No SaaS, no accounts, no telemetry, no database server.
- No API keys are read, requested, or stored. Auth detection checks *existence* only (e.g. Keychain entry name, `codex login status`) and never touches secret values.
- `.bridge/` holds references, timestamps and bounded delta files — not full transcripts — and is added to your `.gitignore` automatically.
- Context deltas travel only between the agent CLIs on your machine, inside their normal subscription-authenticated calls.

## Compatibility

Verified against: **Claude Code 2.1.215**, **codex-cli 0.144.6** and **grok 0.2.106** on macOS (Node 23). Each vendor's session format is internal; the bridge parses them defensively, but a future CLI release could require an update — pin these versions if you need stability.

## When something goes wrong

**An agent ran out of quota or crashed before it could hand off.** Its work is
not lost. The bridge builds a delta from the agent's own session files on disk,
not from the running process, so the agent being alive was never what a handoff
actually needed. Run `bridge status`: it names any agent holding work that never
made it out, along with the exact command to free it.

```
Antigravity has work that was never handed off. It is saved, not lost:
bridge handoff claude --from antigravity
```

That command works from any terminal, with the stuck agent still open, closed,
or hours in the past. `--from` names the departing agent explicitly instead of
inferring it, which is the whole point: the agent that would normally announce
itself is the one that cannot.

**A delta was routed to a hook that never fired.** The launcher says so when the
session ends and names the file the context is still sitting in. Nothing is lost
and the next handoff carries it again. For Codex this usually means its hooks
have not been trusted yet — review them once with `/hooks`.

**You want to know what the previous agent actually did.** `bridge inspect`
renders the audit written beside the last delta: commands with their outcomes,
failures first, files changed and read. Each agent contributes what its own
record can yield, and the output says plainly where an agent is blind rather
than leaving an empty column to be misread as nothing happened.

## Known limitations

- Verified on **macOS only**; Linux paths exist but are untested; Windows is unsupported.
- One linked session per agent per project (no `bridge unlink` yet — delete `.bridge/` to relink).
- Only Claude → Codex has an official first-switch import; other first switches seed a new session with the full conversation as its opening prompt.
- Codex runs hooks only after you review them once with `/hooks`, and that trust is not readable from outside. Until then a handoff falls back to the prompt path, and when a delta was routed to a hook that never fired the launcher says so and names the file it is still sitting in.
- Grok cannot receive a delta through a hook at all: its hooks fire but their output is ignored for passive events, so Grok stays on prompt delivery.
- An agent's own dialogs (folder trust, update prompts) can appear before a resumed session; answer them once and the flow continues.
- A launcher left running across a bridge upgrade cannot read the newer state file. It says so and asks to be restarted; the pending handoff is preserved.
- Upgrading the state file is one way. An older bridge refuses a newer one rather than guessing at it, so downgrading means restoring the backup the migration keeps beside it (`state.json.v<n>.backup`). The upgrade says both of these once, when it happens.
- The summary is written by the departing agent, so its quality depends on that agent following its handoff instructions. When one is missing, from a crash or a recovery, the delta says so and falls back to the deterministic Conversation and Work sections rather than presenting an extract as a reading.
- If you run `claude`/`codex` outside the `bridge` launcher, handoffs still record state, but the actual switch is manual (the handoff message tells you exactly what to run).
- Codex stores its sessions by date rather than by project, so the discovery check for it is measured across the machine rather than for one project.
- **This is an early developer preview — not production-ready.**

## Roadmap

- Flags given at handoff time, so a switch can arm the agent it is switching to (per-project defaults and `--cb-save-args` work today)
- `bridge unlink` / multi-pair support
- Linux verification, Windows support
- Optional MCP quick-question mode (ask the other agent without switching)

## Development status

0.9.0 — developer preview. Round-trips across all four agents (repeatedly, without re-import) pass real end-to-end tests on macOS, and the bridge is developed with itself: Claude, Codex, Grok and Antigravity hand this repo's work back and forth through it daily, including review rounds where each one's findings reach the next. That is not a slogan about dogfooding. Antigravity's first act as the fourth agent was to read its own adapter and raise three objections, two of which changed the code before it was committed.

Since the first release:

- **Adopt flow** — sessions started outside the bridge can be linked mid-flight (deterministic via `CODEX_THREAD_ID`, confirmed when heuristic)
- **Full-context checkpoints** — every delta ships with a temporary un-truncated companion, so long prose survives a handoff
- **Three agents, six directions** — Grok joined behind an adapter contract, and a `knownBy` matrix keeps chains from dropping the hop before last
- **Codex is hook-driven too** — it records its own session, receives deltas inside the conversation rather than in front of it, and reports the end of a turn instead of having it inferred from a 3MB transcript
- **Per-agent launch flags** — typed when you want them, saved with `--cb-save-args` when you want them to stick, announced loudly when they change what an agent may do without asking
- **Sessions the bridge starts are linked** — Codex and Grok used to be unreachable until they handed off once, so `bridge grok` refused to resume the session it had just created
- **Doctor tells the truth** — `READY` became `CONFIGURED`, and two canaries check that this version of the bridge can still read what each agent writes and still find what each agent stores
- **Regression suite + CI** — `node:test` coverage over parsers, discovery, adopt paths and hooks, gated on ubuntu+macos × Node 18/20/22
- **Checkpoint retention** — checkpoints are delivery artifacts: a companion is dropped once its reader has handed off, with `bridge clean` as the manual backstop
- **A fourth agent, and what reaching it exposed** — Antigravity joined behind the same adapter contract, and getting a delta to it uncovered a first switch too large for a command line, a delta recorded as delivered before anything carried it, and an agent's identity read from a variable that outlives its session

What changed between versions: [CHANGELOG.md](CHANGELOG.md). Design details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); contributions are welcome via [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

MIT © SerdarDB
