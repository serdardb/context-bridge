# context-bridge Architecture

**Switch agents. Not context.**

How the bridge works inside. For usage see the [README](../README.md); for
working on it see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Design principles

1. **Native sessions are preserved, never replaced.** Claude keeps its own
   session, Codex its own thread, Grok its own session directory. The bridge
   orchestrates them and re-implements none of them. Delete the bridge and all
   three still work with their own CLIs.
2. **Official mechanisms wherever one exists.** Import, resume, hooks, plugins
   and skills are all vendor-supported surfaces. The bridge adds only what no
   vendor ships: the mapping between sessions, the way back, and switching
   repeatedly without starting over.
3. **Deltas, not transcript copies.** Every agent already holds its own history.
   A switch carries only what the target has not seen.
4. **No API keys, no extra billing.** Every CLI runs under the subscription the
   user already has. The bridge never reads or stores credentials.
5. **Nothing important is silent.** A dropped input, a deletion, a delta that
   never arrived, a parser that no longer understands a file: each of these is
   reported. Most of this document's odder decisions come from this one rule.

## System overview

```
shell
└── bridge                       launcher, zero-dependency Node CLI
    └── exactly one agent at a time

        claude ⇄ codex ⇄ grok    six directed routes

  ~/.claude/projects/…    ~/.codex/sessions/…    ~/.grok/sessions/…
     native session          native thread         native session

        .bridge/state.json   ← what links them, references only
        .bridge/config.json  ← per-agent launch flags for this project
```

| Component | Role |
|---|---|
| `bridge` CLI (`src/`) | launcher loop, state, delta engine, doctor, hook endpoints |
| `src/agents/` | one adapter per agent; the only place vendor knowledge lives |
| Claude plugin (`plugin/`) | `/bridge` skill and the `SessionStart` / `Stop` / `UserPromptSubmit` hooks |
| Codex hooks (`~/.codex/hooks.json`) | the same three events, installed by `doctor --fix`, merged into whatever is already there |
| Shared skill (`codex/SKILL.md`) | `$bridge <agent>` for Codex and Grok |
| `.bridge/state.json` | project-local links, watermarks, pending markers. References, never content |

## The adapter contract

Adding an agent used to mean touching a dozen files. It is now one module in
`src/agents/` implementing a narrow contract, and the registry is what every
other part of the system iterates over: the doctor's route table, checkpoint
pruning, the delta engine. A pruning rule that hard-coded one pair once meant
Grok's checkpoints were never cleaned up at all, which is why nothing enumerates
agents by hand any more.

The contract covers exactly the parts that are genuinely per-vendor: discovery,
rehydrating a reference, the resume and start commands, parsing activity since a
watermark, the idle signal, flags that would break the session link, health, a
harmless headless probe, and the two parser canaries below.

### Watermarks are opaque

The two-agent design assumed time was universal. Claude and Codex timestamp
their records, so their watermark is an ISO instant. Grok's chat rows carry no
timestamps at all, so its watermark is a compound `{rows, ts}` counting rows in
the chat file and the newest event timestamp beside it. Using time there would
have silently resent the whole conversation on every switch.

So a watermark is whatever the adapter says it is. Callers persist it and hand
it back untouched, never compare one agent's to another's, and never look inside.

## What crosses, and what does not

A delta is a bounded plain-text block with four sections:

```
[Bridge Context Update]

Conversation   what was said, from the native session files
Decisions      what was decided, and what was rejected and why
Work           files touched, commits, diffstat, from git
Next           the current objective and what is still open
```

Conversation and Work are deterministic: session records newer than the
watermark, plus `git status --porcelain` and `log`/`diff --stat` since the
recorded checkpoint. No summarisation call is added anywhere.

Decisions and Next come from the departing agent, written in the same turn the
user triggered the switch. They carry intent, which neither files nor git can
show.

**Tool calls and their output never cross.** They are enormous, shaped
differently by every vendor, and not replayable in another agent. On this
repository a raw Claude session file is 14.9MB of which 285KB is conversation:
the tool output is the noise. The receiving agent debugs against the repository
itself rather than against a stale account of somebody else's run. The honest
cost is that a failure which lived only in tool output, and which nobody wrote
down, does not travel.

Each bounded delta is capped, and the middle is cut rather than the ends, so the
beginning and the latest exchange both survive. Beside it, every handoff also
writes an **un-truncated companion** holding every message verbatim. That exists
because a size cap once clipped long prose in the middle of drafting it.

## knownBy: why chains keep their history

The naive model is a single sync timestamp per agent, and it loses material as
soon as there are three agents: hand from Claude to Grok to Codex, and Codex
receives only what Grok said.

State therefore holds `knownBy[target][source]`: for each pair, how far into the
source's own stream material has been packed for that target. A handoff gathers
from every agent whose watermark for the target is behind, labels each block by
who produced it, and commits the new watermarks only once the delta is actually
delivered. Committing at write time would mark the departing agent's final
answer as delivered before it had been written.

This ledger is also the difference from tools that copy a session on every
switch. Copying needs no such bookkeeping because it starts over each time.

## Delivery: two roads, chosen in advance

A delta reaches its target one of two ways.

**Hook.** Claude and Codex both accept `hookSpecificOutput.additionalContext`
from a `SessionStart` hook, which places the delta inside the conversation. The
hook renames the delta file to `*.consumed` before emitting, which is what makes
handing it over happen exactly once even across a crash or a race: whoever
renames the file owns it. Handed over is as far as this goes; whether the model
then attends to it is not something any of this can observe.

**Prompt.** The delta rides as the opening message of the resumed session. This
works everywhere and shapes the session around the delivery. Grok uses it
permanently: its hooks fire but their output is ignored for passive events.

The road has to be chosen *before* the agent starts, because nothing can be
injected into a session already running, and whether a hook will fire cannot be
known: Codex runs hooks only after the user reviews them once with `/hooks`,
that trust can be withdrawn silently, and neither state is readable from
outside. So `pendingInjection.via` records the choice at handoff time, and
exactly one deliverer honours it, which is what makes delivering twice
impossible rather than merely unlikely.

When the choice turns out wrong the launcher says so after the agent exits,
names the file the delta is still sitting in, and points at `/hooks`. Nothing is
resent automatically; the next handoff supersedes that delta anyway. A delayed
delta is a cost worth paying, a silent one is not.

## The first switch is different, for everyone

The target has no session yet, so something must be created. Claude → Codex uses
OpenAI's official transfer (`codex-plugin-cc`, `externalAgentConfig/import`
underneath), which seeds a real thread with the whole conversation; the returned
thread id is captured programmatically. Every other first switch opens a new
session whose opening prompt is the conversation.

Re-running that import for a changed transcript creates a **brand-new thread**
every time, because the import ledger is append-only. So it runs once per
project, the pair is persisted, and from then on the same session is resumed
with a delta.

## Project state

`.bridge/state.json`, versioned and written atomically, migrated forward with a
`.v<n>.backup` kept and a refusal to read anything newer than this build
understands. References only:

```json
{
  "version": 4,
  "project": "<absolute path>",
  "activeAgent": "claude",
  "agents": {
    "claude": { "id": "…", "transcriptPath": "…", "mark": "2026-07-21T…", "idle": false },
    "codex":  { "id": "…", "transcriptPath": "…", "mark": "2026-07-21T…", "idle": false, "hookSeen": "…" },
    "grok":   { "id": "…", "transcriptPath": "…", "mark": { "rows": 262, "ts": "…" }, "idle": false }
  },
  "knownBy": { "grok": { "claude": "…", "codex": "…" } },
  "pendingHandoff":   { "target": "codex", "ready": true, "requestedAt": "…" },
  "pendingInjection": { "agent": "codex", "via": "hook", "deltaFile": "…", "sources": {} },
  "launcher": { "stateVersion": 4, "pid": 71272, "recordedAt": "…" },
  "git": { "sha": "…", "recordedAt": "…" }
}
```

Transcripts are deliberately not duplicated here. The native files already are
the transcripts; copying them would double the on-disk footprint of sensitive
conversation, and references plus watermarks are enough to compute every delta.
`.bridge/` is added to the project's `.gitignore` automatically.

`launcher` exists because a launcher started before an upgrade cannot read a
newer state file. It says so and asks to be restarted rather than waiting for a
switch that can never come.

## Checkpoints are delivery artifacts

Checkpoint files are packages in transit, not memory. The canonical record is
each agent's native transcript plus `knownBy`.

So retention follows the delivery lifecycle rather than a clock: an un-truncated
companion is dropped once its reader hands off. That is an event, not a proof.
It means the agent had a live session in which the companion was available to
it, which is the strongest thing anything here can observe; nobody watches
whether a file was opened. A small newest-N cap backstops a target that never
hands off again. Bounded deltas are kept longer for auditing, and a
pending injection is never deleted under any flag. Re-issuing a handoff
supersedes the previous undelivered one instead of leaving it on disk forever.

## Session linking

Claude records itself through its `SessionStart` hook. Codex does the same now:
its hook input carries `session_id` and `transcript_path`, so linking is a fact
it tells us rather than something inferred from the newest file on disk.

For an agent started without hooks, the launcher links the session it started
itself, through `adoptStartedSession` on the adapter. Grok publishes a live
registry of open sessions at `~/.grok/active_sessions.json` keyed by pid and
cwd, which identifies our own child exactly. That registry empties the moment a
session closes, so linking runs while the child is alive *and* once more after
it exits; post-exit alone would strand every session whose terminal was killed.

When several candidates match, none is adopted and the bridge says so. A user
with a second session of the same agent open in another terminal must never have
it taken.

A hook only records what it was installed for. Each hook command declares its
agent (`internal-hook session-start --agent codex`) and refuses when the
environment says it woke up somewhere else, which matters because Grok loads
Claude's own `~/.claude/settings.json` hooks by default.

There is exactly one such marker today: `GROK_HOOK_EVENT`, which Grok's hook
runner injects into every hook process. Codex has no equivalent, so nothing
detects it, and that gap is left open rather than filled. Two earlier attempts
went wrong in opposite directions: refusing on `CODEX_THREAD_ID`, which is
ambient session environment inherited by every child, made Claude's own hook
refuse itself, and a `CODEX_HOOK_EVENT` was then added that does not exist
anywhere in the shipped binary. Detection stays negative and fails towards
working: demanding positive proof of identity would disable the bridge the day a
vendor renames a variable.

## Launcher

The process tree stays flat:

```
shell
└── bridge
    └── claude   (exits) →
    └── codex    (exits) →
    └── grok     …
```

Never nested. Each agent is a direct child spawned with `stdio: "inherit"`, so
the TUI gets the real terminal. Nested TUIs would stack raw-mode terminals,
break Ctrl+C, and leak processes.

The parent ignores `SIGINT`, because Ctrl+C typed inside an agent belongs to
that agent. A missing binary produces a doctor hint; an unexpected exit
preserves state and explains how to continue.

### Switching without cutting a turn in half

The current agent closes itself after a handoff, which is a guarded termination.
`SIGTERM` goes out only when a handoff is persisted, the agent is idle, and
idleness survived a debounce and a final re-read of state.

Idleness is either something an agent says or something we infer. Claude and
Codex both report the end of a turn through their `Stop` hook, which is cheaper
and truer than inference: it arrives when the turn ends rather than when the
file is next flushed, and it does not depend on a field name a vendor may
rename. The marker is read first, and re-reading the transcript remains the
fallback, because hooks do not run until they are trusted and a launcher
listening only for a marker would wait forever.

Hard rules: the launcher signals only the exact child pid it spawned, never by
process name, and never `SIGKILL`, because a clean shutdown and a flushed
session file both depend on `SIGTERM`. If idleness cannot be confirmed within a
generous window it prints a fallback and does nothing destructive.

## Two canaries

Both exist because of failures that produce no error at all.

**Session readability.** Installed and logged in says nothing about whether the
bridge can still read what an agent writes, and for a while the doctor's routes
claimed readiness on that basis alone. Session formats are internal to each vendor: a renamed field ships in a
point release and every handoff quietly returns an empty delta. So each adapter
runs its own parse path over the linked session, which costs 98ms across all
three on this repository. An empty session is readable, a fresh project is
neutral and never red, and rows that parse into nothing recognisable are the
drift signal.

**Discovery.** Finding a session and reading one are different code, and the
second kind of failure is just as quiet. A rollout head record was parsed into a
fixed 16KB buffer while codex-cli embeds its base instructions there and the
record grew to 22KB; every parse failed, no rollout matched any project, and
Codex discovery returned null for every session on the machine, silently,
because a failed parse looks exactly like "a different project". Each adapter
now reports whether its discovery reader can still name what is stored on disk.

An unreadable session takes its routes off green and the exit code with it.

## Per-agent launch flags

Arming an agent is a moment, not a preference: you work with approvals on, and
then decide, now, that this agent should stop asking. So flags are typed on the
launcher command line and apply to that launch, `--cb-save-args` promotes them
into `.bridge/config.json`, and `--cb-clear-args` takes it back. Nobody edits
the file by hand.

Saved defaults come first and typed flags come last, which relies on a CLI
taking the last occurrence of a repeated flag; that holds for all three agents
and is convention rather than law. A flag that would break the session link is
refused when it is saved, so the complaint reaches whoever wrote it. Flags that
change what an agent may do without asking are announced on a plain line at
every launch, and `bridge status` lists what is armed, because a saved bypass
nobody can find is one nobody can undo.

## bridge doctor

Every assumption is checked rather than assumed, and the wording is deliberate.
Routes say `CONFIGURED`, meaning installed, configured, and its session still
parses; they used to say `READY`, which read as proof that a switch would work.
`--deep` asks each agent a real one-line question and reports `LIVE` or
`BROKEN`, and it is not the default because it is slow and depends on the
network.

`--fix` bootstraps missing pieces using only official mechanisms and asks before
every change. It can install the Codex hooks, and then says plainly that Codex
will not run them until they are reviewed once with `/hooks`, because that trust
is not readable and claiming otherwise would be a green tick over an unknown.

## Security and privacy

- Local only: no SaaS, no accounts, no telemetry, no server.
- No API keys read, requested or stored. Auth checks test for existence and
  never print secret values.
- State holds references, timestamps and bounded delta files. Transcripts stay
  where the vendors put them.
- Deltas travel only inside the CLIs' own subscription-authenticated calls.
- Global CLI configuration is never mutated without confirmation.

## Known limits

- Verified on macOS. The suite runs on Linux in CI, but the vendor directory
  layouts there are unverified. Windows is unsupported.
- One linked session per agent per project. Deleting `.bridge/` relinks, and
  takes the saved launch flags with it.
- Grok cannot receive a delta through a hook, and that is a limit in Grok.
- Codex stores sessions by date rather than by project, so its discovery check
  answers for the machine rather than for one project.
- Every vendor session format is internal. The parsers are defensive and the
  canaries shout when they stop matching, but a CLI release can still require an
  update here.
