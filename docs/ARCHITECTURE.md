# context-bridge Architecture

**Switch agents. Not context.**

How the bridge works inside. For usage see the [README](../README.md); for
working on it see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Design principles

1. **Native sessions are preserved, never replaced.** Claude keeps its own
   session, Codex its own thread, Grok and Antigravity their own session
   directories. The bridge orchestrates them and re-implements none of them.
   Delete the bridge and all four still work with their own CLIs.
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

   claude ⇄ codex ⇄ grok ⇄ antigravity ⇄ opencode    twenty directed routes

  ~/.claude/projects/…   ~/.codex/sessions/…   ~/.grok/sessions/…
     native session         native thread        native session
        ~/.gemini/antigravity-cli/brain/…   ~/.local/share/opencode/opencode.db
              native conversation              native session, in a database

        machine-local state   ← what links them, references only
        machine-local config  ← per-agent launch flags for this project
```

| Component | Role |
|---|---|
| `bridge` CLI (`src/`) | launcher loop, state, delta engine, doctor, hook endpoints |
| `src/agents/` | one adapter per agent; the only place vendor knowledge lives |
| Claude plugin (`plugin/`) | `/bridge` skill and the `SessionStart` / `Stop` / `UserPromptSubmit` hooks |
| Codex hooks (`~/.codex/hooks.json`) | the same three events, installed by `doctor --fix`, merged into whatever is already there |
| Shared skill (`codex/SKILL.md`) | `$bridge <agent>` for Codex, Grok, Antigravity and OpenCode |
| `machine-local state.json` | links, watermarks and pending markers. References, never content; Git is optional |
| `machine-local checkpoints` | Deltas, full context and audit manifests retained by handoff group |
| `.cbctx` artifact | Explicit redacted context package with schema and integrity hash; never native session state |

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

Three of its methods are optional, present only where an agent needs them.
`kickoffArgs` returns a one-line opening prompt for a hook-injecting agent, whose
hook delivers context but not a turn (see Delivery below). `preResume` returns a
command the launcher runs before the interactive session opens, for an agent that
takes its delta neither on the command line nor through a hook: OpenCode keeps its
sessions in a SQLite database and the delta is written straight in, authless,
because the alternative was a paid, authenticated model call. An adapter that does
not implement one of these is simply never asked for it.

### Watermarks are opaque

The two-agent design assumed time was universal. Claude and Codex timestamp
their records, so their watermark is an ISO instant. Grok's chat rows carry no
timestamps at all, so its watermark is a compound `{rows, ts}` counting rows in
the chat file and the newest event timestamp beside it. Using time there would
have silently resent the whole conversation on every switch.

So a watermark is whatever the adapter says it is. Callers persist it and hand
it back untouched, never compare one agent's to another's, and never look inside.

## What crosses, and what does not

A delta is a bounded plain-text block with a reading followed by four evidence
sections:

```
[Bridge Context Update]

Summary        what the departing agent thinks matters and why
Conversation   what was said, from the native session files
Decisions      what was decided, and what was rejected and why
Work           files touched, commits, diffstat, from git
Next           the current objective and what is still open
```

Conversation and Work are deterministic: session records newer than the
watermark, plus `git status --porcelain` and `log`/`diff --stat` since the
recorded checkpoint. No summarisation call is added anywhere.

Summary, Decisions and Next come from the departing agent, written in the same
turn the user triggered the switch. They carry intent, which neither files nor
git can show. When the agent cannot provide a summary, the bridge labels the
mechanical extract as a record rather than pretending it is a reading.

**Tool calls and their output never cross.** They are enormous, shaped
differently by every vendor, and not replayable in another agent. On this
repository a raw Claude session file is 14.9MB of which 285KB is conversation:
the tool output is the noise. The receiving agent debugs against the repository
itself rather than against a stale account of somebody else's run. The honest
cost is that a failure which lived only in tool output, and which nobody wrote
down, does not travel.

Each bounded delta is budgeted. The summary and non-trimmable evidence are
reserved first; conversation is carried as whole messages and omitted messages
are counted rather than cut mid-message. Beside it, every handoff also writes a
**full-context checkpoint** holding every message verbatim. That exists because
a size cap once clipped long prose in the middle of drafting it.

## knownBy: why chains keep their history

The naive model is a single sync timestamp per agent, and it loses material as
soon as there are multiple agents: hand from Claude to Grok to Codex, and Codex
receives only what Grok said.

State therefore holds `knownBy[target][source]`: for each pair, how far into the
source's own stream material has been packed for that target. A handoff gathers
from every agent whose watermark for the target is behind, labels each block by
who produced it, and commits the new watermarks only once the delta is actually
delivered. Committing at write time would mark the departing agent's final
answer as delivered before it had been written.

This ledger is also the difference from tools that copy a session on every
switch. Copying needs no such bookkeeping because it starts over each time.

Unlinked session ids are retained as cumulative `rejectedSessions` tombstones.
They are deliberately not aged out by checkpoint retention: a delayed vendor hook
must not resurrect a session the user explicitly forgot. The only removal is a
deliberate relink of that exact id, which retires that one tombstone; unrelated
ids remain rejected. This makes state size proportional to explicit unlink
history, rather than silently trading correctness for a bounded file.

## Delivery: three roads, chosen in advance

A delta reaches its target one of three ways.

**Hook.** Claude and Codex both accept `hookSpecificOutput.additionalContext`
from a `SessionStart` hook, which places the delta inside the conversation. The
hook holds the state lock, writes the complete output to stdout, then renames
the delta to `*.consumed` and commits the delivery state. An output failure leaves
pending context intact. If the process dies or state publication fails after the
rename, a retry reads the consumed file still named by pending state. A crash
after output but before acknowledgement can repeat context; the vendor provides
no receipt, so exactly-once delivery cannot be promised. Successful stdout writes
do not prove the vendor accepted the context or that its model attended to it.
Transient nonblocking-pipe errors have a five-second retry bound; this is not a
deadline for a blocking operating-system write.

A hook delivers *context*, not a *turn*. The delta lands as background, and the
agent has nothing to answer, so it sits idle until a human types. `kickoffArgs`
is the other half: a one-line prompt appended to the resume command that opens
the turn, carrying no delta so the handoff cannot land twice. It fires whenever
the delivery went by hook, whether that is the agent's permanent road (Claude)
or its road for this handoff (Codex, once its hooks are trusted).

**Prompt.** The delta rides as the opening message of the resumed session. This
works everywhere and shapes the session around the delivery. Grok uses it
permanently: its hooks fire but their output is ignored for passive events.

**Store.** OpenCode has neither road: no usable hook, and a resume command that
cannot be handed an opening message. It keeps each session in a local SQLite
database, so `preResume` writes the delta straight into that database as one
idempotent, transactional insert, authless and with no model call. The write IS
the delivery, so the launcher commits it on the insert's success rather than
watching for later activity, and leaves it pending on failure so the next launch
retries. The context is present when the TUI opens; the turn, uniquely among the
five, is the person's to open, because OpenCode exposes no seam to open it for
them.

OpenCode's SQLite store is an intentional compatibility boundary, not a hidden
supported API. The adapter checks the required schema before writing, bounds
discovery and lock waits, performs writes transactionally, and reports the
store's compatibility state through doctor. There is no alternate supported API
to fall back to today; when the schema canary fails, delivery remains pending
and the user is directed to update the bridge or inspect the vendor store rather
than receiving a fabricated success. A future OpenCode API adapter is a separate
compatibility project, not something this release silently claims to provide.

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

The machine-local `state.json`, versioned and written atomically, is migrated with a
`.v<n>.backup` kept and a refusal to read anything newer than this build
understands. Schema-changing loads and direct state writes require a complete
exclusive backup before replacing old state. An existing backup must be a
regular non-symlink file matching the original bytes; a conflict or I/O failure
aborts the write. Migration write failures are reported, not silently treated
as success. Explicit read-only loads can still inspect the upgraded view in
memory without creating a backup or writing state.
Schema-changing loads acquire the same writer lock as lane/project mutations
and re-read the file after acquiring it. A current-schema or explicitly
read-only load does not acquire that write lock.
The shared JSON writer creates an exclusive, randomly named private
temporary file, writes and fsyncs its content, closes it, then renames it over
the destination. POSIX builds then fsync the containing directory. Exclusive
evidence publication similarly syncs its directory after linking the complete
file. A write/content-flush failure leaves the previous destination intact
and cleans only the temporary file owned by that invocation. A subsequent
directory-sync failure reports `BRIDGE_PUBLICATION_UNCERTAIN` with
`published: true`; it does not remove the visible destination. This is not a
complete power-loss durability guarantee: newly created ancestor directories,
multi-file transaction ordering and cleanup require additional guarantees.
Legacy migration additionally flushes the verified destination and backup trees
before recording source retirement. On POSIX it flushes their ancestor directory
chains, the journal's ancestors, and both sides of each source rename. Recovery
repeats these barriers before proceeding. Completion receipts and their parents
are flushed before the progress journal is removed. A failed barrier reports
`BRIDGE_MIGRATION_SYNC_FAILED` and preserves published copies and retired originals
for inspection; it does not guess a rollback. These are OS flush requests, not
evidence of power-cut recovery on every filesystem or storage controller, and
cannot make an uncoordinated old writer's subsequent writes durable.
Windows retains content flush plus atomic publication without the POSIX directory
sync guarantee. Artifact import handles a post-publication exception by re-reading
the state receipt under the project lock. A visible commit keeps its seed and
checkpoint evidence; only uncommitted files matching the preparation journal
can be removed. Failed verification retains evidence rather than guessing a
rollback. The original error is still reported, and retry can recognize the
existing receipt without applying the artifact again.

Saved launch arguments in `config.json` use the same atomic writer and project
lock as state. Per-agent save/clear operations reload config inside the lock so
concurrent changes to different agents are preserved. Only a missing file means
empty settings; unreadable or malformed config fails instead of silently
discarding saved arguments. The exported whole-config save operation replaces
the supplied snapshot, while per-agent operations merge against current data.
Unsupported config versions and invalid argument structures also refuse rather
than being rewritten as version 1. Versionless legacy objects remain readable;
unrecognized metadata on a valid current-version object survives per-agent edits.

Registry, state, schema-backup, saved-config and latest-checkpoint reads share
`readOwnedFile`: only a regular single-link leaf is accepted, opened with
no-follow where available and checked against the named inode. Observed size or
mtime changes cause refusal. Only absence at the initial lookup may mean empty
state/config; a dangling link or disappearance after lookup is an error. Native
causes remain available to callers without being printed as private paths in
expected CLI failures. These checks are not a transactional snapshot or a
general defense against hostile parent-directory replacement, and do not imply
every vendor or other runtime read uses this helper. Registry failures do not
create a replacement identity; disappearance after lookup is an error, not a
fresh registry. Invalid schema and unreadable storage have distinct expected
error codes, without exposing physical registry paths in CLI errors.

State contains references only:

```json
{
  "version": 5,
  "project": "<absolute path>",
  "activeLane": "main",
  "lanes": {
    "main": {
      "activeAgent": "claude",
      "agents": {
        "claude": { "id": "…", "transcriptPath": "…", "mark": "2026-07-21T…", "idle": false },
        "codex":  { "id": "…", "transcriptPath": "…", "mark": "2026-07-21T…", "idle": false, "hookSeen": "…" },
        "grok":   { "id": "…", "transcriptPath": "…", "mark": { "rows": 262, "ts": "…" }, "idle": false }
      },
      "knownBy": { "grok": { "claude": "…", "codex": "…" } },
      "pendingHandoff":   { "target": "codex", "ready": true, "requestedAt": "…" },
      "pendingInjection": { "agent": "codex", "via": "hook", "deltaFile": "…", "sources": {} },
      "git": { "sha": "…", "recordedAt": "…" }
    }
  },
  "launchers": { "71272": { "pid": 71272, "lane": "main", "stateVersion": 5, "recordedAt": "…" } }
}
```

Everything one line of work owns — its agent links, watermarks, pending markers
and git snapshot — lives under `lanes[<name>]`, and `activeLane` names the one in
force. Readers never index `lanes` directly: state loaded for a lane exposes that
lane's fields at the top level (`s.agents`, `s.pendingHandoff`, …) through an
active-lane view, so the whole codebase reads as if there were one lane and a
switch is a single pointer move. A fresh install is one lane called `main`; a
project that never opens a second one never notices the layer.

Two writers are serialised by two locked primitives. `mutateState` read-modify-
writes exactly one lane under an exclusive lock, and refuses to resurrect a lane
an existing project has removed (a delayed hook drops its write instead of
recreating the lane empty). `mutateProject` writes the whole file, for the
lane create / switch / remove commands that are about the set of lanes rather
than the work inside one.

State, registry, migration and artifact-import writers first acquire a kernel guard through
`locking.mjs`. Its regular, non-symlink guard file is permanent: deleting it
would let different processes lock different inodes under the same pathname.
The kernel releases ownership on process exit, including forced termination.
The existing PID marker protocol runs entirely inside this guard to serialize
stale-owner recovery among updated processes. Do not run old writers during
upgrade: old binaries do not participate in the new kernel protocol.

Global state initialization/mutation, checkpoint publication and legacy migration
also hold `locks/<UUID>.runtime.guard` outside the project data directory. The
synchronous project scope is reentrant for nested checkpoint writes; its kernel
guard is not. Identity is checked again after acquiring ownership. The scope
precedes state/migration locks, and registry access inside it never waits for a
runtime lock while holding the registry lock. Explicit adoption acquires the
existing UUID's runtime guard before the registry lock and rechecks its destination
after waiting. Launcher closing-word appends and delivery acknowledgement also
hold runtime ownership. These guards coordinate participating bridge writers,
not unrelated filesystem tools or older bridge versions. Retirement additionally
checks the pending work and operation reservations described below.

Artifact application holds runtime ownership across import-lock acquisition,
state publication and recovery. Its order is runtime -> import -> state; nested
checkpoint writes reuse the runtime scope. Read-only artifact verification does
not acquire runtime ownership. Handoff preparation completion also owns the
project scope; preparation creation/recovery resolve their checkpoint directory
inside state ownership rather than carrying a pre-lock resolved path into it.

Long handoff preparation uses an operation reservation, not a runtime lock held
through the native transfer (which can take up to 120 seconds). After read-only
preview/initial validation, a short runtime scope publishes a unique record in
`operations/<UUID>/`; normal state writers remain available while the handoff
runs. Adoption refuses any record, including uncertain or interrupted records.
Completion removes its own record under the stable UUID guard. Project inspection
lists reservations even if the old project directory is gone. `project recover`
previews interrupted records without mutation; `--apply` revalidates under the
UUID guard and clears only safely read, schema-valid records with definitely
absent process owners. Live/unknown owners and unsafe records remain. Recovery
does not repair/undo handoffs or remove evidence; age alone is never authority.

Project retirement takes the UUID runtime guard before registry ownership and
rechecks quiescence. The registry itself journals `retiring` before renaming
`projects/<UUID>` to `retired-projects/<UUID>`, then publishes `retired`.
Restoration journals `restoring`, moves the same directory back, then publishes
`active`. Non-active identity resolution refuses runtime access. Retrying an
interrupted transition accepts an already-moved destination only when the
matching transition is recorded; both source and destination present is a hard
refusal, never a merge. Missing original working directories do not impede UUID
administration. POSIX rename parent directories are synced before final registry
publication; this is not evidence of physical power-loss or Windows durability.
Permanent purge is separate, requires an already-retired store and an explicit
matching UUID confirmation, and journals `purging` before removing scanned entries
in postorder. Each entry is rechecked before unlink/rmdir; symlinks, hardlinks and
unexpected active stores refuse cleanup. A partial purge can resume, but cannot
restore. Completion publishes `purged` and retains the identity tombstone and
stable guard, preventing delayed recreation. External backups, native sessions
and code are outside its deletion scope. Older nonparticipating writers must be
stopped before using this lifecycle; unrelated filesystem tools are not locked.

Checkpoint content readers in hooks, prompt construction and search reject
linked/shared leaves using descriptor-verified reads in addition to directory
containment. Closing words append through a verified descriptor to existing
single-link regular files; missing full evidence is not recreated as a fragment.
An append failure stops the switch with an actionable error and leaves progress
unadvanced. Full-context and delta appends are not a multi-file transaction:
interruption after the first append can repeat closing words on retry. These
checks do not lock unrelated filesystem writers or prove hostile parent-swap
resistance.

Handoff collection distinguishes unavailable, partial and readable source sessions
using each adapter's parser probe. Source limitations appear in the preview,
delta and full-context record, with their text charged to the delivery budget.
Unavailable sources are omitted; partial sources may contribute readable messages
but neither advances its delivery watermark. Notes-only recovery remains valid,
and an empty readable session is not called unavailable. Closing-word collection
also declines a source that is not fully readable. Probing and extracting vendor
sessions are separate operations, not an atomic snapshot of a concurrently
changing vendor store; a probe cannot eliminate all read-time races.
Delivery marks are captured before extraction, including closing-word collection.
For append-only streams this favors possible repetition of concurrent arrivals
over acknowledging a later row that the payload never read. It does not prove
consistency for an external rewrite or branch replacement during extraction.

Kernel and PID acquisition retries share a 30-second wait budget across nested
synchronous lock scopes. `CONTEXT_BRIDGE_LOCK_TIMEOUT_MS` accepts a positive
integer override. Exhaustion raises `BRIDGE_LOCK_TIMEOUT` without evicting the
owner or running the blocked critical section. A later attempt starts with a
fresh budget. Retries sleep rather than spin; repeated POSIX `EINTR` also counts
towards the budget. This bounds retry waiting, not the duration of a filesystem
call or critical-section work; independent, non-nested lock scopes have separate
budgets. It is not an end-to-end command deadline.

Koffi provides the native binding, loaded only when a mutation needs a lock.
POSIX uses `flock`; Windows uses `CreateFileW` and `LockFileEx` (the Windows
branch still requires native platform acceptance before release). A missing
platform binary refuses mutation rather than falling back to unsafe PID-only
recovery. Local-filesystem verification does not establish network-filesystem
locking guarantees. Installations must retain the platform optional dependency.

Transcripts are deliberately not duplicated here. The native files already are
the transcripts; copying them would double the on-disk footprint of sensitive
conversation, and references plus watermarks are enough to compute every delta.
Runtime state is stored outside the project tree, so no `.gitignore` change is needed and Git is not a prerequisite.
Optional Git identity and audit metadata probes have a two-second per-command
timeout and are terminated if stuck. Failure yields absent Git metadata, not
failure to create a local project UUID. This is a responsiveness policy, not a
guarantee that every command using multiple probes finishes within two seconds.
Bridge identity creation never writes a marker into Git configuration.
The optional identity annotation is captured only at initial registration.
Already-registered identity lookups (including mutating lookups) use the registry
and filesystem identity without launching Git. Audit branch/commit probes remain
independent and current; the identity annotation is not a live Git-config mirror.

`launchers` records each live launcher by pid and the lane it opened. It exists
because a launcher started before an upgrade cannot read a newer state file — it
says so and asks to be restarted rather than waiting for a switch that can never
come — and because knowing which lane a launcher holds lets `lane rm` and
`unlink` refuse only when a launcher is live on the lane they touch, not on any.

## Checkpoints are delivery artifacts

Checkpoint files are packages in transit, not memory. The canonical record is
each agent's native transcript plus `knownBy`.

So retention follows the delivery lifecycle rather than a clock: an un-truncated
full-context checkpoint is retained with the delta and audit manifest, then
pruned by the checkpoint group's retention policy. A pending injection is never
deleted under any flag. Re-issuing a handoff
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
runs its own parse path over the linked session, which cost 98ms measured
across the three that existed when it was added. An empty session is readable, a fresh project is
neutral and never red, and rows that parse into nothing recognisable are the
drift signal.

**Discovery.** Finding a session and reading one are different code, and the
second kind of failure is just as quiet. A rollout head record was parsed into a
fixed 16KB buffer while codex-cli embeds its base instructions there and the
record grew to 22KB; every parse failed, no rollout matched any project, and
Codex discovery returned null for every session on the machine, silently,
because a failed parse looks exactly like "a different project". Each adapter
now reports whether its discovery reader can still name what is stored on disk.

Claude/Codex directory access and file inspection failures are not treated as
empty session stores. Automatic Codex adoption also refuses an incomplete scan,
unidentified header or matching session without a usable timestamp/identifier;
it cannot establish uniqueness from the remaining readable candidates. The
launcher explains the refusal and leaves the session unlinked. An incomplete
or older unrecognised native record can therefore disable automatic fallback;
handing off from inside the intended session remains the explicit recovery path.
Discovery does not mutate vendor transcripts or prove a concurrent snapshot.

An unreadable session takes its routes off green and the exit code with it.
JSONL probes distinguish an absent file (`missing`, ENOENT) from an I/O failure
(`unreadable`, with a sanitized error code). Permission and storage failures do
not imply vendor schema drift or authorize treating the session as empty.
Doctor reports checking permissions/storage rather than claiming the file is
gone; Grok's combined chat/events probe retains this failure status too.
Claude/Codex, Grok and Antigravity conversation extraction also requires its
source files at the actual read, not just during the earlier probe. Read failure
is disclosed and does not advance the source watermark. Grok/Antigravity marks
likewise require the underlying files. Optional audit/discovery/idle readers
retain their existing fallback semantics; this is not an atomic native snapshot
or protection against content rewrites between successful reads.

## Per-agent launch flags

Arming an agent is a moment, not a preference: you work with approvals on, and
then decide, now, that this agent should stop asking. So flags are typed on the
launcher command line and apply to that launch, `--cb-save-args` promotes them
into the machine-local project store, and `--cb-clear-args` takes it back. Nobody edits
the file by hand.

Saved defaults come first and typed flags come last, which relies on a CLI
taking the last occurrence of a repeated flag; that holds for all five agents
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

## Search, Observation and Isolation

`search.mjs` reads retained checkpoint files across project lanes without
creating state or building a separate index. Filters cover lane, agent, UTC
date and the branch recorded in the handoff's audit, not the current checkout.
Results are bounded line snippets, not complete transcripts or an importance
ranking. Checkpoint retention therefore also bounds the available history.

Lane seed preparation and `inspect` share a strict latest-checkpoint reader.
It rejects linked/nonregular files, verifies the opened inode against the named
file and refuses observed size/mtime changes during reading. Missing history is
allowed; unsafe or unreadable history is an error, not an empty briefing or a
reason to silently use an older checkpoint. Invalid audit JSON is likewise an
error. Seed preparation reads state without performing schema-upgrade writes;
the CLI prepares the seed before creating its destination lane. This is not a
transactional snapshot across all source files or protection against every
hostile parent-directory replacement.
The result includes `incomplete` and logical-file `issues`: unreadable or unsafe
entries and unknown metadata required by a branch filter are not silent misses.
CLI returns available matches but exits 1 for an incomplete scan. MCP preserves
the same coverage fields separately from `omittedResults`, which counts only
matching files hidden by its display limit. No scan is an atomic filesystem
snapshot; `incomplete: false` means no skip was observed, not that deleted history
or concurrently arriving evidence was searched.

`watch.mjs` polls authoritative status under an explicit `read-only` policy.
It emits snapshot/change/unavailable/recovered JSON events and pins the
selected directory's device and inode. It performs no repair, switch or
acknowledgement. Polling can miss intermediate transitions; this stream is
not a durable event log or a delivery receipt.

Ordinary lanes separate context, not working files. Optional worktree-backed
lanes use Git worktrees for file isolation, starting from committed HEAD;
uncommitted changes are not copied. Attached worktrees have independent
runtime stores. Removing a lane does not delete its worktree or source files.
Only this opt-in workflow requires Git, not ordinary bridge operation.

## Read-Only MCP

`mcp.mjs` exposes a local stdio server using the official SDK, without a TCP
listener. The operator selects one project; the server pins its directory
identity and refuses reads when that identity changes. Default tools expose
status and adapter declarations. `--allow-content` explicitly enables search
snippets, which can contain private conversation text. There are no mutation,
agent-launch or arbitrary-file-read tools. Tool annotations describe the
contract; the implementation's read-only operations enforce it.

Adapter declarations are not live vendor acceptance. Explicit plugin manifests
execute trusted local code even for read-only commands; see
[the adapter contract](ADAPTERS.md) for that separate trust boundary and the
opt-in Aider/Pi candidates.

## Security and privacy

- Local only: no bridge SaaS, accounts or telemetry. The optional MCP server
  uses stdio, not a network listener.
- No API keys read, requested or stored. Auth checks test for existence and
  never print secret values.
- State holds references, timestamps and bounded delta files. Transcripts stay
  where the vendors put them.
- Full-context checkpoints and audit manifests are local evidence, not canonical
  memory: they may contain sensitive conversation text, command arguments and
  file names. They are excluded from git and npm packages, retained with their
  handoff group (newest 20 and younger than 7 days by default), and removable
  with `bridge clean`; pending handoffs are protected until delivered or
  deliberately superseded.
- Do not share a checkpoint or audit manifest without reviewing it for secrets,
  personal paths and project data. The bridge's opt-in debug logger redacts these
  classes, but stored handoff artifacts preserve the evidence needed for local
  recovery and are not a redaction boundary.
- Deltas travel only inside the CLIs' own subscription-authenticated calls.
- Global CLI configuration is never mutated without confirmation.

## Known limits

- Verified on macOS. The suite runs on Linux in CI, but the vendor directory
  layouts there are unverified. Windows is unsupported.
- One linked session per agent per lane. `bridge unlink <agent>` forgets just that
  one; deleting the machine-local project store still relinks everything at once and takes the saved
  launch flags with it, but is no longer needed to relink a single agent.
- Grok cannot receive a delta through a hook, and that is a limit in Grok.
- Codex stores sessions by date rather than by project, so its discovery check
  answers for the machine rather than for one project.
- Every vendor session format is internal. The parsers are defensive and the
  canaries shout when they stop matching, but a CLI release can still require an
  update here.
