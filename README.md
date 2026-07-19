# context-bridge

[![CI](https://github.com/serdardb/context-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/serdardb/context-bridge/actions/workflows/ci.yml)

**Switch agents. Not context.**

Developers increasingly use multiple coding agents — but switching between them usually means losing conversational context, or manually copying summaries, session IDs and file lists from one tool to the other.

**context-bridge connects native coding-agent sessions.** Each agent keeps its own real session; the bridge remembers which sessions belong to the same project and transfers only the context the other agent is missing.

- It does **not** replace Claude Code or Codex.
- It does **not** proxy their APIs.
- It requires **no API keys** — it drives the subscription-authenticated CLIs you already have.

**Supported today: Claude Code ⇄ Codex** (Gemini planned, not implemented).

> **Status: developer preview (0.3.0).** The core flow is tested and used daily, but vendor session formats can change under it — treat it as a private-beta tool, not a hardened production release.

## The core UX

Inside **Claude Code**:

```
/bridge codex
```

→ Claude closes automatically
→ Codex opens automatically, with the context it was missing

Inside **Codex**:

```
$bridge claude
```

→ Codex closes automatically
→ your **original** Claude session resumes, with what happened in Codex injected

> Tip: if the `$` prefix is awkward on your keyboard layout, just ask in plain
> language — e.g. "switch to claude with the bridge" — and the agent will invoke
> the same skill for you.

Highlights:

- Native Claude and Codex sessions — nothing is replaced or wrapped
- Automatic context synchronization (delta-based, not full transcript copies)
- No copy/paste · no session IDs · no manual resume commands
- No API keys · no extra AI billing — your existing subscriptions
- No nested TUIs — a flat launcher owns exactly one agent at a time

## Why context-bridge

The Claude→Codex direction already exists officially: OpenAI ships a Claude Code plugin and Codex's `/import` that can turn a Claude session into a Codex thread. context-bridge **uses** that official machinery — and adds the missing half:

1. **The way back.** Nothing official returns Codex context to your *original* Claude session. The bridge extracts what changed (conversation, decisions, files, git) and injects it on resume via Claude's official hook mechanism.
2. **Repeat switching.** Re-importing creates a brand-new Codex thread every time (we verified this). The bridge imports **once**, remembers the pair, and afterwards syncs both directions with compact deltas into the *same* sessions.
3. **Zero session management.** Session discovery, thread capture, resume commands, injection — all automatic. You only ever type `/bridge codex` or `$bridge claude`.

## How it works

```
shell
└── bridge                     ← launcher (Node CLI, zero dependencies)
    └── one agent child at a time
        claude  ⇄  codex       ← real TUIs, real sessions

.bridge/state.json             ← per-project: native session/thread references,
                                 sync timestamps, git checkpoint, pending markers
                                 (never transcripts; auto-gitignored)
```

- `/bridge codex` (a Claude plugin skill) has Claude write down its decisions and open questions, then runs `bridge handoff codex`. First time, the **official OpenAI transfer** seeds a Codex thread; afterwards, a bounded 4-section delta (Conversation / Decisions / Work / Next) is delivered as the resume prompt.
- `$bridge claude` (a Codex skill) does the reverse: the delta is computed from Codex's own session file plus git, and injected into your original Claude session through a `SessionStart` hook — exactly once.
- Every delta ships with a **full un-truncated context** companion in `.bridge/checkpoints/`, referenced from the delta itself. The bounded 8KB summary keeps handoffs fast; exact wording (long prose, drafts, specs that live only in conversation) survives on disk, and the receiving agent reads it whenever the clipped one-liners aren't enough.
- The launcher watches the state file. When a handoff is ready **and the agent's turn has finished**, it terminates its own child process (SIGTERM, never by name, never SIGKILL) and starts the other agent. Terminal state stays healthy; Ctrl+C inside an agent behaves normally.
- **Started without the bridge?** Sessions can be adopted mid-flight. `$bridge claude` inside a Codex session that was never linked adopts it automatically (Codex exposes the running thread via `CODEX_THREAD_ID`); if that variable is unavailable, the newest Codex session working in the project directory is offered as a candidate and linked only after you confirm (`--adopt`). Codex-first projects work too: with no Claude session to resume, the delta — plus a pointer to the full Codex transcript — seeds the first Claude session that starts in the project. The rule everywhere: **automatic when identity is deterministic, confirmed when heuristic.**

## Requirements

- macOS (verified on macOS; Linux is untested, Windows unsupported)
- Node.js ≥ 18.18
- [Claude Code](https://code.claude.com/docs/en/setup) ≥ 2.1.x, logged in with your Claude subscription
- [Codex CLI](https://developers.openai.com/codex) ≥ 0.143.0, logged in with your ChatGPT subscription (`codex login`)
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
- the **$bridge Codex skill** (`~/.agents/skills/bridge/SKILL.md`)
- an optional Codex allow-rule so `bridge handoff` runs without an approval prompt

Nothing is mutated without confirmation, and no secrets are ever read or printed.

## bridge doctor

```
Context Bridge Doctor

Claude Code
  ✓ Installed: 2.1.214 (Claude Code)
  ✓ Authenticated (you@example.com)
  ✓ context-bridge plugin installed
  ✓ Official OpenAI Codex plugin installed

Codex
  ✓ Installed: codex-cli 0.143.0
  ✓ Authenticated (Logged in using ChatGPT)
  ✓ $bridge skill installed (~/.agents/skills/bridge)
  ⚠ Project not yet trusted — Codex will show a one-time trust prompt
  ✓ bridge command pre-allowed in Codex rules

Bridge
  ✓ bridge on PATH (hooks can reach it)
  ⚠ No project state yet (created on first use)

Available routes
  Claude <-> Codex     ✓ READY
  Claude <-> Gemini    ○ UNAVAILABLE (planned)
  Codex  <-> Gemini    ○ UNAVAILABLE (planned)
```

On a fresh machine the plugin/skill rows start as `✗` with the exact official command next to each; `--fix` offers to run them for you.

## First run

```bash
cd your-project
bridge
```

`bridge` starts (or resumes) Claude Code as its child. Work normally. The bridge's hooks record the session automatically — you never see an ID.

## Switching from Claude to Codex

Inside Claude Code:

```
/bridge codex
```

Claude summarizes its decisions/open questions into the handoff, the bridge links (first time: officially imports) the Codex thread, Claude's turn ends, and the launcher closes Claude and opens Codex on the same project context.

## Switching from Codex to Claude

Inside Codex:

```
$bridge claude
```

Codex records its decisions, the bridge computes the Codex delta (messages + patched files + git truth), Codex closes, and your **original** Claude session resumes with a `[Bridge Context Update]` injected. Ask Claude *"Where were we?"* — it knows.

## Repeat switching

Switch as often as you like. After the first link:

- `/bridge codex` → `codex resume <linked thread>` with a compact Claude-delta (no re-import, same thread, prior Codex context intact)
- `$bridge claude` → original session resume with a compact Codex-delta

Each delta costs the receiving agent one short acknowledgment sentence — that's the entire overhead.

## Architecture

| Piece | What it is |
|---|---|
| `bridge` CLI | Zero-dependency Node CLI: launcher loop, state, deltas, doctor |
| `.bridge/state.json` | Versioned per-project state: session/thread references, sync timestamps, git checkpoint, pending handoff/injection markers. Never transcripts. Auto-gitignored. |
| Claude plugin | `/bridge` skill + `SessionStart` / `Stop` / `UserPromptSubmit` hooks (session recording, delta injection, idle marking) |
| Codex skill | `$bridge` → runs `bridge handoff claude` |
| Official import | First Claude→Codex switch uses OpenAI's `codex-plugin-cc` transfer (`externalAgentConfig/import` under the hood) |

Full design details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · contributing: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Privacy and security

- Everything is local. No SaaS, no accounts, no telemetry, no database server.
- No API keys are read, requested, or stored. Auth detection checks *existence* only (e.g. Keychain entry name, `codex login status`) and never touches secret values.
- `.bridge/` holds references, timestamps and bounded delta files — not full transcripts — and is added to your `.gitignore` automatically.
- Context deltas travel only between your two local CLIs, inside their normal subscription-authenticated calls.

## Compatibility

Verified against: **Claude Code 2.1.214** and **codex-cli 0.143.0** on macOS (Node 23). Both vendors' session formats are internal; the bridge parses them defensively, but a future CLI release could require an update — pin these versions if you need stability.

## Known limitations

- Verified on **macOS only**; Linux paths exist but are untested; Windows is unsupported.
- One linked Claude-session ⇄ Codex-thread pair per project (no `bridge unlink` yet — delete `.bridge/` to relink).
- Codex's own one-time dialogs (folder trust, update prompt) can appear before a resumed session; answer them once and the flow continues.
- Decision/Next quality depends on the departing agent following its handoff instructions; Conversation/Work sections are deterministic from session files and git regardless.
- If you run `claude`/`codex` outside the `bridge` launcher, handoffs still record state, but the actual switch is manual (the handoff message tells you exactly what to run).
- **This is an early developer preview — not production-ready.**

## Roadmap

- Gemini CLI as a third bridged agent (`/bridge gemini`) — session resume, extensions and headless JSON are already verified feasible
- `bridge unlink` / multi-pair support
- Linux verification, Windows support
- npm package (`npm install -g context-bridge`)
- Optional MCP quick-question mode (ask the other agent without switching)

## Development status

0.3.0 — developer preview. The full Claude → Codex → original-Claude round-trip (repeatedly, without re-import) passes a real end-to-end test on macOS, and the bridge is developed with itself: Claude and Codex hand this repo's work back and forth through it daily.

Since the first release:

- **Adopt flow** — sessions started outside the bridge can be linked mid-flight (deterministic via `CODEX_THREAD_ID`, confirmed when heuristic)
- **Full-context checkpoints** — every delta ships with an un-truncated companion file, so long prose survives handoffs
- **Regression suite + CI** — `node:test` coverage over parsers, discovery, adopt paths and hooks, gated on ubuntu+macos × Node 18/20/22

Design details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); contributions are welcome via [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

MIT © SerdarDB
