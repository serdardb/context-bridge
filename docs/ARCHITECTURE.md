# context-bridge Architecture

**Switch agents. Not context.**

This document describes how context-bridge works internally. For product usage, see the [README](../README.md); for contributing, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Design principles

1. **Native sessions are preserved, never replaced.** Claude Code keeps its own session (`~/.claude/projects/<project-slug>/<uuid>.jsonl`); Codex keeps its own thread (`~/.codex/sessions/…/rollout-*.jsonl`). context-bridge never wraps, proxies, or re-implements either agent — it orchestrates them. If you delete the bridge, both sessions still work with their own CLIs.
2. **Official mechanisms wherever one exists.** Session import, resume, hooks, plugins and skills are all vendor-supported surfaces. The bridge adds only what neither vendor ships: the mapping between sessions, the return path, and delta-based repeat switching.
3. **Deltas, not transcript copies.** Agents already hold their own history. When switching, the bridge transfers only what the target agent is missing.
4. **No API keys, no extra billing.** Both CLIs run under the user's existing subscription authentication. The bridge never reads or stores credentials.
5. **Safety over magic.** If any part of a switch cannot be confirmed, the bridge says so and falls back to a manual step instead of pretending.

## System overview

```
shell
└── bridge                          launcher (Node CLI, zero dependencies)
    └── one agent child at a time
        ┌────────┐    switch    ┌────────┐
        │ claude │ ───────────► │ codex  │
        │  TUI   │ ◄─────────── │  TUI   │
        └────────┘              └────────┘
             │                       │
   ~/.claude/projects/…      ~/.codex/sessions/…
      (native session)         (native thread)

        .bridge/state.json  ← per-project link between the two
```

Components:

| Component | Role |
|---|---|
| `bridge` CLI (`src/`) | launcher loop, state, delta engine, doctor, hook endpoints |
| Claude Code plugin (`plugin/`) | `/bridge` skill + `SessionStart` / `Stop` / `UserPromptSubmit` hooks |
| Codex skill (`codex/SKILL.md`) | `$bridge` — instructs Codex to run `bridge handoff claude` |
| `.bridge/state.json` | project-local link state (references only, never transcripts) |

## Claude → Codex: the first switch

The Claude→Codex direction has an official path: OpenAI's Claude Code plugin ([`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)) converts a Claude session transcript into a real Codex thread via the Codex app-server (`externalAgentConfig/import`). context-bridge deliberately **uses** this mechanism rather than re-implementing transcript conversion:

1. The user runs `/bridge codex` inside Claude Code.
2. The plugin skill has Claude summarize its decisions and open questions, then run `bridge handoff codex --decisions … --next …`.
3. On the first switch for a project, the bridge invokes the official plugin's transfer machinery (`codex-companion.mjs transfer --json`) with the current session transcript.
4. The resulting Codex **thread ID** is captured programmatically from the transfer's JSON output (Codex also records the import in `~/.codex/external_agent_session_imports.json`, keyed by source path and content hash).
5. The thread ID, its rollout path, sync timestamps and a git checkpoint are persisted in `.bridge/state.json`.

The user never sees an ID at any point.

## Why repeated switches never re-import

Re-running the official import for the same (changed) transcript creates a **brand-new Codex thread** each time — the import ledger is append-only and the previous mapping is not updated. A naive bridge would therefore scatter the user's work across disconnected threads and lose Codex-side context on every switch.

So the bridge imports **once per project**, persists the pair, and afterwards:

```
codex resume <linked-thread-id> "<context delta>"
```

Interactive `codex resume` auto-submits the prompt argument as a real turn, so the linked thread receives the Claude-side delta the moment it opens — same thread, full prior Codex context, one short acknowledgment sentence as the only overhead. The delta prompt ends with an instruction to acknowledge briefly and not repeat the content back.

## Codex → Claude: the return flow

Nothing official exists in this direction; this is the core problem context-bridge solves.

1. The user runs `$bridge claude` inside Codex.
2. The Codex skill has the model summarize its decisions and open questions, then run `bridge handoff claude --decisions … --next …`.
3. The bridge extracts everything that happened in Codex since the last sync, deterministically, from the thread's own rollout file (user/agent messages, per-turn final messages, applied patches) plus git truth (status, commits, diff stat since the recorded checkpoint).
4. A bounded delta file is written to `.bridge/checkpoints/` and registered as a *pending injection* for the original Claude session.
5. The launcher resumes the **original** session: `claude --resume <original-session-id>`.

### Why the original session ID is stable

`claude --resume <id>` (interactive and headless) **appends to the same session** — it does not fork unless `--fork-session` is passed explicitly. The bridge records the session ID once, at session start, through its `SessionStart` hook (hook input carries `session_id`, `transcript_path`, and `cwd`), and every return trip resumes that exact session. Identity is preserved across any number of round-trips.

### Context injection via SessionStart(resume)

Claude Code's `SessionStart` hook may return `additionalContext`, which is injected into the resumed conversation — an official, supported mechanism. The bridge's hook:

1. Fires on resume, checks `.bridge/state.json` for a pending injection matching this project and session.
2. Reads the delta file, **atomically renames it to `*.consumed` before emitting** and clears the pending marker — this guarantees **exactly-once** injection even if hooks fire again (later resumes, restarts). The injected context persists in the session transcript, so it never needs re-injection.
3. Emits the delta as `additionalContext`. If the delta file is missing, the hook injects an explicit warning instead of failing silently — the bridge never pretends a sync succeeded.

## The context delta model

A delta is a bounded (~8 KB) plain-text block with four sections:

```
[Bridge Context Update]

Conversation   ← what was discussed (from native session files)
Decisions      ← what was decided, and what was rejected and why
Work           ← files changed, patches applied, git commits/status
Next           ← current objective and unresolved questions
```

- **Conversation** and **Work** are extracted deterministically: session/rollout records newer than the last sync timestamp, plus git (`status --porcelain`, `log`/`diff --stat` since the recorded commit checkpoint). No LLM summarization call is added.
- **Decisions** and **Next** come from the *departing* agent itself: the handoff skill asks it to write one-line notes in the same turn the user triggered — capturing intent that files and git cannot reveal, at zero extra cost.
- Size is capped by truncating the middle of the conversation region; decisions and next-steps are never truncated.

## Project state: `.bridge/state.json`

Versioned, written atomically (temp file + rename). It stores **references, never content**:

```json
{
  "version": 1,
  "project": "<absolute path>",
  "activeAgent": "claude",
  "agents": {
    "claude": { "sessionId": "…", "transcriptPath": "…", "lastSyncAt": "…", "idle": false },
    "codex":  { "threadId": "…",  "rolloutPath": "…",   "lastSyncAt": "…", "idle": false }
  },
  "pendingHandoff":   { "target": "codex", "ready": true, "requestedAt": "…" },
  "pendingInjection": { "agent": "claude", "sessionId": "…", "deltaFile": "…" },
  "git": { "sha": "…", "recordedAt": "…" }
}
```

`lastSyncAt` semantics: `agents.codex.lastSyncAt` is the time up to which *Codex has received Claude context*, and vice versa — each delta filters native files strictly by `timestamp > lastSyncAt`.

Full transcripts are deliberately **not** duplicated into bridge state: the native session files already are the transcripts, duplicating them would double the on-disk footprint of sensitive conversation data, and references + timestamps are sufficient to compute every delta. `.bridge/` is auto-added to the project's `.gitignore`.

## Launcher architecture

The launcher owns the terminal session and keeps a **flat process tree**:

```
shell
└── bridge
    └── claude        (exits) →
    └── codex         (exits) →
    └── claude        …
```

Never `claude → codex → claude` nesting: each agent is a direct child spawned with `stdio: "inherit"`, so the TUI gets the real terminal (raw mode, colors, signals) and the tree never grows. Nested TUIs would stack raw-mode terminals, break Ctrl+C semantics, and leak processes; sequential children provably leave the terminal healthy across switches.

Details:

- The parent ignores `SIGINT` — Ctrl+C typed inside an agent belongs to that agent (the signal reaches the whole foreground process group).
- Missing binaries (`ENOENT`) produce a doctor hint; unexpected non-zero exits preserve state and explain how to continue; a `SIGTERM`-driven exit is treated as a normal switch.
- On child exit the launcher re-reads state: a pending handoff towards the other agent continues the loop, otherwise the bridge session ends cleanly.

## Idle-safe automatic switching

The headline UX — the current agent closes itself after a handoff — is implemented as a guarded termination. The launcher sends `SIGTERM` only when **all** of these hold:

1. A handoff has been **persisted** (`pendingHandoff.ready` in state, written by `bridge handoff …`).
2. The agent is **idle** — its handoff turn has fully completed:
   - *Claude:* the plugin's `Stop` hook (turn finished) sets an idle marker, and `UserPromptSubmit` clears it, so the marker is true only between turns.
   - *Codex:* the launcher watches the thread's rollout file for a turn-completion event recorded **after** the handoff request — turn-end truth from Codex's own append-only session file.
3. Idle persisted across a debounce, and a final state re-read from disk is still consistent.

Hard rules: the launcher signals **only the exact child PID it spawned** — never `pgrep`, never process-name matching (another process with a similar name must never be touched) — and never `SIGKILL` (both CLIs shut down cleanly on `SIGTERM`, flushing their session files; `SIGKILL` would forfeit that guarantee). If idle cannot be confirmed within a generous window, the launcher prints a clear fallback ("exit the agent normally; the bridge will continue") and does nothing destructive. If the child ignores `SIGTERM`, the launcher says so and waits.

## Dependency detection: `bridge doctor`

Every environment assumption is checked, not assumed:

- **Installed & version** — `claude --version`, `codex --version`.
- **Subscription auth, without touching secrets** — existence checks only: the Claude Code credentials Keychain entry (macOS) or credentials file (Linux) plus the OAuth account record; `codex login status` exit code for Codex.
- **Integrations** — the context-bridge Claude plugin, the official OpenAI Codex plugin (needed for first import), the `$bridge` Codex skill, the optional Codex allow-rule, and `bridge` being on `PATH` (hooks invoke it).
- **Project state health** and a final route table (`Claude <-> Codex READY / NOT READY`).

`bridge doctor --fix` bootstraps missing pieces using only official mechanisms (`claude plugin marketplace add` / `claude plugin install`, file installs for the skill), asking for confirmation before every change. Failures print the exact official command instead of improvising.

## Security & privacy

- Local-only: no SaaS, no accounts, no telemetry, no server.
- No API keys read, requested, or stored; auth checks are existence-only and never print secret values.
- Bridge state holds references, timestamps and bounded delta files; transcripts stay where the vendors put them.
- Context deltas travel only inside the two CLIs' own subscription-authenticated calls.
- The bridge never mutates global CLI configuration without explicit user confirmation (`--fix`).

## Current limitations (Claude ⇄ Codex, v0.1)

- Verified on macOS; Linux untested; Windows unsupported.
- One linked session/thread pair per project; delete `.bridge/` to relink.
- Codex-owned one-time dialogs (folder trust, update prompt) may appear before a resumed thread; the bridge cannot suppress another product's dialogs.
- Each delta costs the receiving agent one short acknowledgment response.
- Both vendors' session file formats are internal; parsers are defensive, but a future CLI release may require an update.

## Extensibility toward Gemini

The architecture generalizes to any agent that offers: (a) discoverable per-project sessions, (b) resume-by-id, (c) a context injection point, and (d) an in-agent extension mechanism to trigger `bridge handoff`. Gemini CLI has session resume (`--resume`, `--list-sessions`), extensions, hooks and headless JSON output, so a `gemini` entry can slot into `agents` in the state schema and a third branch into the launcher/doctor without changing the delta model. Not implemented in v0.1.
