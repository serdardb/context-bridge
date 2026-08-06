# Changelog

Newest first. Dates are the day the work landed on `main`.

Entries say what changed and, where it matters, why. Most of the fixes here came
from something failing quietly, and the reasoning is usually the interesting
half.

## [0.12.2] — 2026-08-06

### Fixed

- **Re-linking OpenCode no longer grabs a stray session.** Unlike the file-based
  agents, OpenCode keeps every session in one SQLite store, and any `opencode run`
  from a directory — an app making its own model calls, for instance — leaves a
  session filed under it. So a busy project directory fills with two-message
  remnants, and when the bridge had to rediscover OpenCode's session (after an
  unlink, a seed, or a `doctor` relink) it took the newest by time, which was
  usually one of those remnants, and `--adopt` bound to it. Discovery now prefers
  the session the bridge actually manages — one it delivered a handoff into (its
  message carries a `msg_bridge_*` id) or itself fabricated (a `ses_bridge*` id).
  Exactly one such session is adopted silently; several fall back to the newest of
  them behind `--adopt`; none keeps the old newest-wins guess for a genuine first
  adoption. The extra store read happens only when a directory is ambiguous. This
  is independent of git — it matters most in projects that are not git repos, which
  OpenCode files together under its `global` project.

## [0.12.1] — 2026-08-06

### Fixed

- **The first handoff into OpenCode now arrives.** In a project where OpenCode
  had never been linked, the first switch to it delivered nothing: OpenCode has
  no hook and no openable prompt, so a delta is written straight into its SQLite
  store, but a message there has a foreign key to a session and on a first switch
  no session exists yet, so the delta sat pending and the session was never
  linked. The bridge now fabricates that first session directly — one
  transaction inserting the session row and the delta's message and part — then
  resumes it by id and links it, so the first switch delivers exactly like every
  later one. The fabricated session's `project_id` is read from the store
  (`COALESCE((SELECT id FROM project WHERE worktree = …), 'global')`), so a
  projected git repo uses its own project and an un-projected directory falls
  back to the global project as OpenCode's own sessions do. The write is
  idempotent (the session id is derived from the delta) and delivery still
  commits only after it succeeds. Only OpenCode's first switch is affected; every
  other agent and every later OpenCode switch is unchanged.

## [0.12.0] — 2026-08-04

Lanes: two lines of work in one project directory, each with its own agent links,
history and checkpoints, so two sessions run in two terminals without seeing each
other. The full set — open one with `--resume`, start one from another with
`--seed`, scope `clean` and `inspect` to one with `--lane`, and per-lane launcher
tracking so `lane rm`/`unlink` guard precisely. Plus `bridge unlink`, and a long
review hardening every place a checkpoint path is read, written, listed or deleted,
and every lifecycle edge in seeding and unlinking.

### Added

- **Lanes.** A project can hold more than one line of work. `bridge lane` lists
  them, most recently active first with the active one marked; `bridge lane new
  <name>` starts a fresh, empty one and switches to it; `bridge lane switch <name>`
  moves the default; and `bridge lane rm <name> --yes` deletes one and its
  checkpoints (`--dry-run` to preview). A new lane inherits nothing on purpose — a
  different line of work is the whole reason to open one — and a bare `bridge`
  resumes the lane you were last in, so a one-lane project never has to think about
  them. Lanes isolate context, not the working tree: every lane shares one
  checkout, so they are parallel conversation, not parallel code.
- **`bridge <agent> --resume`.** Opens a lane directly: `--resume <name>` enters a
  named one, `--resume` alone offers a picker, and a bare `bridge` resumes the last
  lane. It reuses the flag the bridge already holds back from the agent, so nothing
  leaks to the agent even if you pass it twice.
- **`bridge lane new <name> --seed <source>`.** Starts a lane that is not empty: it
  carries the source lane's decisions, open questions, current git state and the
  files it had touched — a briefing, not a transcript. No conversation, no session
  links, no watermarks cross. It is delivered to whichever agent opens the new lane
  first, and if that launch fails to start the seed is handed back to the next.
- **`--lane` on `clean` and `inspect`.** `bridge clean --lane <name>` prunes one
  lane's checkpoints (protection still scans every lane, so a delta another lane is
  waiting on is safe); `bridge inspect --lane <name>` shows that lane's newest audit.
- **`bridge unlink <agent>`.** Forgets one agent's session in the active lane, and
  every `knownBy` watermark that names it in both directions, so the next switch
  links it fresh. It replaces deleting `.bridge/` to relink one agent, which took
  all of them. The whole slot is reset, not just a session id — `hookSeen`, pending
  markers and `idle` all keep an agent live — and it refuses while a launcher is
  running on that lane. It also leaves a tombstone: a directly-run agent (one
  started outside the launcher) keeps firing hooks, so without it the next one could
  silently re-adopt the session you just forgot, or consume a delta meant for a live
  one. The tombstoned session's hooks become a complete no-op, and every session you
  unlink is remembered separately, so forgetting one never revives another you
  forgot earlier. A tombstone is cleared only by a deliberate re-adopt of that exact
  id; a genuinely new session just links alongside without disturbing the rest.

### Changed

- **Checkpoints live under their lane.** `main` keeps the flat
  `.bridge/checkpoints/` it always had, so paths embedded in old deltas stay true;
  a new lane gets `.bridge/lanes/<lane>/checkpoints/`. Retention, `inspect` and
  `status` all run per lane.
- **State writes are lane-scoped and locked.** One primitive, `mutateState`,
  read-modify-writes a single lane under an exclusive file lock, so two launchers on
  two lanes never clobber each other. A separate `mutateProject` handles the
  project-level changes — creating, switching and removing a lane.
- **Launchers are tracked per lane.** State records each launcher against the lane
  it drives, keyed by pid and pruned when the process is gone, so `lane rm` and
  `unlink` refuse only when a launcher is live on the lane they touch, not on any
  lane at all. A launcher on one lane no longer blocks removing another.

### Fixed

- **Every checkpoint path now passes one of three containment guards.** State can
  be corrupt or hostile, and its paths are read, renamed, deleted, listed and
  written. `safeCheckpointPath`, `safeCheckpointsDir` and `readableCheckpointsDir`
  refuse a `..` traversal, a target outside a `checkpoints/` directory, a symlinked
  directory component and a symlinked `.bridge` root, in every direction;
  `ensureState` refuses a symlinked `.bridge` before it writes. Found and closed
  over an eight-round review the night of 2026-08-03.
- **Retention validates before it deletes.** Pruning checks every lane, state entry
  and pending marker first and deletes nothing until all pass, so a malformed or
  cross-lane pending marker can no longer let one lane be pruned before another's
  fault is seen. Pending protection is keyed to a delta's real directory, not its
  basename.
- **A removed lane stays removed.** `mutateState` no longer recreates a lane an
  existing project deleted, so a delayed hook or a launcher still pinned to it drops
  its write instead of resurrecting the lane empty. Bootstrapping a brand-new
  project's first lane, the one legitimate auto-create, is preserved.

## [0.11.0] — 2026-08-03

A fifth agent, and the delivery machinery that reaching it forced into the open.
OpenCode keeps its sessions in a database rather than in files and offers no hook,
so getting a delta to it needed a road the bridge did not have, and building that
road surfaced two bugs in how every agent was already being handed its context.

### Added

- **OpenCode is the fifth agent.** It stores each session in a local SQLite
  database and, unlike the other four, exposes no seam to hand a running TUI a
  message. So the delta is written straight into that database on resume, as one
  idempotent, transactional insert, authless and with no model call. The first
  approach was `opencode run`, which turned out to be a paid, authenticated model
  call that stalled a live switch on a login prompt, so the direct write replaced
  it. Read-back for building the next delta goes through `opencode export`, which
  truncates a piped buffer at 128KB but writes the whole session to a real file,
  so the export lands in a file. Session discovery uses OpenCode's own
  `session list --format json` rather than a spawned server, for the reason below.
  The one external tool the write needs is the `sqlite3` CLI, and `bridge doctor`
  reports whether it is present, because without it a handoff into OpenCode stays
  pending rather than failing loudly.
- **`kickoffArgs`, the half of hook delivery nobody had built.** A hook delivers
  *context*, not a *turn*: the delta lands as background and the agent has nothing
  to answer, so it sat idle until a human typed, on every hook handoff. Claude and
  Codex now get a one-line opening prompt appended to the resume command, carrying
  no delta so the handoff cannot land twice, which fires whenever the delivery
  went by hook. Verified live: Codex begins reading the handoff on arrival instead
  of waiting.

### Fixed

- **A first switch no longer blows past the command line.** It used to inline the
  entire conversation un-clipped, on the theory that a new agent knows nothing. On
  a large conversation that produced a multi-megabyte delta, and a prompt agent
  receives its delta as a single command-line argument, so `spawn` threw E2BIG and
  the agent never started. This shipped in 0.10.0 and broke the first live switch
  to OpenCode. A first switch is bounded like every other now: the departing
  agent's summary leads, as much conversation as the road allows follows, and the
  rest lives in the full context checkpoint the delta points at.
- **A handoff is committed when the agent answers, not when it spawns.** Delivery
  was recorded the instant the child process started, but a CLI that ignores the
  prompt it was handed produces exactly the same successful spawn as one that
  reads it. A real Claude to Codex handoff was lost that way, with nothing left
  but a checkpoint that never appeared. Delivery now commits on the target's first
  activity; an agent that starts and says nothing leaves the delta pending and
  retryable. The safe direction is a handoff delivered twice, which is visible and
  recoverable, not one delivered never.
- **Session discovery stops leaking a background server.** Listing OpenCode
  sessions first spawned `opencode serve` and killed it after, but a call that
  timed out left the disowned server alive; several piled up, and because OpenCode
  is client and server the TUI could attach to a stale one and show its state, so
  old messages vanished on resume. Discovery now reads OpenCode's own
  `session list --format json`, which needs no server, and the server path that
  remains as a fallback carries a trap so even a timeout takes its server down.

### Changed

- **Each agent's conflicting flags are enforced from the adapter, not a second
  table.** A copy of the conflict rules lived in the argument filter and had
  drifted from the adapters it was meant to mirror: Grok's seven session-breaking
  flags and Antigravity's four were declared but never enforced, and OpenCode's
  were half-enforced. The filter now reads each adapter's own `conflictFlags`, one
  source, with a test that walks every agent and proves the flag it declares is
  the flag that gets dropped.

## [0.10.0] — 2026-07-23

The delta was carrying a tenth of what it was allowed to. This release is mostly
about finding that out and fixing it, and the reasoning is the interesting half.

### Changed

- **A handoff carries whole messages now.** Six numbers decided what survived a
  switch and not one had been chosen against a real constraint: at most fourteen
  messages per agent, each cut to its first 220 characters, an 8KB cap on the
  result, a second copy of the character limit hidden in the launcher, and the
  skill asking the departing agent for "max ~3 items". Measured on a real
  project, that carried 21KB of a 105KB conversation into a 128KB budget. What
  decides now is the road's own limit. A message travels whole or does not
  travel, because a message cut at 220 characters keeps the claim and drops the
  evidence: the review that started this arrived reading "no blockers,
  commit-ready" with its verification list and its warning cut off, which reads
  like a short answer rather than a truncated one.
- **The departing agent writes the handoff.** A transcript says what was said,
  never which of it mattered, and the only thing that knows that is the agent
  leaving. It is now asked for an account rather than three bullet points, with
  a byte budget instead of an item count, and told to mark its own uncertainty
  and say what the next agent should verify first. A summary over budget fails
  the command with both numbers and is never trimmed. A missing one never fails
  at all, because recovery is exactly when an agent could not speak, and the
  delta then says the extract is a record rather than a reading.
- **The full context file outlives the session it was written for.** It used to
  be deleted the moment its reader handed off, on the argument that it was a
  transient duplicate. Once the delta carries whole messages the two are the
  same size, and it is what delivery names whenever it has to trim, which can
  happen after a handoff has ended. One retention rule now, the same group rule
  as everything else. `CHECKPOINT_KINDS.companion` is `fullContext`; the on-disk
  suffix is unchanged, because renaming it would drop every existing file out of
  the pattern that collects them.
- **The hook road's budget is 8KB rather than 4KB.** The cap was measured when
  hook delivery was first proven live, around 2,500 model-visible tokens, and
  4KB was roughly a thousand of them: deliberately below a known limit, out of
  caution that made sense when a delta was a handful of one-line stubs. On the
  deltas written since whole messages arrived, 4KB carries 15% of them intact
  and 8KB carries 73%. It is an operating point rather than proof, since the cap
  is in tokens and the budget is in bytes.

### Added

- **`bridge inspect`** renders what the departing agents actually ran, from an
  audit manifest written beside each delta: commands, exit codes, files changed
  and files read, failures first. It is ground truth from the agents' own files
  rather than anything an agent says about itself, and it costs nothing in
  tokens because the manifest never enters the delta.
- **`bridge handoff <target> --from <agent>`** rebuilds a handoff from a dead
  agent's transcript. When an agent hits a quota or crashes mid-switch it cannot
  run the command itself and its work is stranded; being alive was never what
  the handoff actually needed.
- **Each agent declares what its own record can and cannot yield.** Codex runs
  everything through one exec channel, so it can report commands and never
  reads; Claude names its tools, so it can report both. `bridge inspect` says
  which absences are real and which are simply unknowable for that agent.
- **A project holds lines of work.** The state file now keeps its agents,
  watermarks and pending markers under a lane called `main`, folded there from
  the old shape without losing a byte. Nothing is user-visible yet; the commands
  that use it come next.

### Fixed

- **The hook road had never once been taken.** `hookDeliveryEligible` reads a
  slot's `hookSeen` stamp, and the handoff passed it a facade that exposed four
  fields and not that one. Every handoff this project ever made went by prompt,
  and everything built for the narrow road had only ever run in tests that set
  the route by hand.
- **A delta carried the bridge's own instruction manual.** The handoff skill's
  text was arriving as conversation: on one real delta, 5,587 of 7,670 bytes,
  sent to the agent that already has it.
- **Closing words were appended outside the budget.** The departing agent's last
  message is written after the handoff command runs, so it is added to the delta
  afterwards, and nothing checked whether it still fit. A delta at 130,728 bytes
  against a 131,072 ceiling became 133,690, and what delivery cut was exactly
  those closing words: the message the feature exists to save.
- **A delta said nothing about what it left behind.** Omitted messages left no
  trace at all, and every delta claimed its contents were clipped whether or not
  anything had been. Each source now accounts for itself, before the preview
  rather than after it, so a reader learns what is missing before forming a
  picture from what is not.
- **Audit manifests were written where nothing collected them.** Retention had
  been generalised over agent pairs but still named the file kinds by hand, so
  the manifests accumulated untouched: 24 files, 472KB, invisible to a prune
  with every limit set to zero. The kinds come from one registry now and a test
  walks what a real handoff writes, failing on any kind retention cannot group.
- **A pruned switch history was reported as one that never happened.** `bridge
  status` said an agent had never handed off when its checkpoints had simply
  been cleaned up. Absence of evidence is not evidence of absence, and the
  distinction is the whole point of a status line.
- **A state migration was silent about the way back.** The original has always
  been kept beside the new file and nothing mentioned it, which made a downgrade
  look impossible when it is a copy away. The upgrade now says so once, along
  with the fact that an older bridge refuses the newer file rather than guessing.
- **`bridge status` answered a question nobody asked.** It printed each agent's
  raw watermark under one column labelled "synced": an ISO instant for Claude, a
  JSON object for Grok, a bare step number for Antigravity. What a person wants
  is who handed to whom and how recently, and that was already on disk in the
  checkpoint filenames, unread.

## [0.9.0] — 2026-07-21

### Added

- **Antigravity is the fourth agent.** It joins behind the same adapter contract
  as the others, so the agent itself is one file, and it was handed its own
  adapter to argue against before anything was committed. Two of its objections
  changed the code: its transcripts carry internal memory-compaction rows that
  would otherwise have been forwarded to the next agent as though a person had
  written them, and its idle flag cannot be trusted on its own. One of its
  claims did not survive checking, which is the point of asking.
- **`detectHost` is part of the adapter contract**, and deliberately asks whether
  an environment *proves* a process is that agent rather than which variable
  names it. On that reading three of the four adapters answer null.
- **Codex is hook-driven, like Claude.** It records its own session through its
  hooks, so linking is a fact it reports rather than something inferred from the
  newest file on disk. A delta can arrive inside its conversation through
  `SessionStart` instead of as the opening prompt, and the end of a turn is
  something it says rather than something the launcher works out by re-reading a
  3MB transcript twice a second.
- **Per-agent launch flags.** `bridge codex --dangerously-bypass-…` applies to
  that launch, `--cb-save-args` promotes it into `.bridge/config.json`, and
  `--cb-clear-args` takes it back. Flags that change what an agent may do without
  asking are announced on a plain line at every launch, and `bridge status` lists
  what is armed, because a saved bypass nobody can find is one nobody can undo.
- **A discovery canary.** Finding a session and reading one are different code,
  and both can fail without an error. Each adapter now reports whether its
  discovery reader can still name what is on disk.

### Fixed

- **An agent's identity was read from a variable that outlives it.** A handoff
  decided who was speaking by reading `CODEX_THREAD_ID` first, but that is
  exported into a Codex session and inherits into every process below it, so a
  Grok session opened by a launcher that had itself been opened inside Codex
  reported Codex as the source: the wrong stream was packed and the wrong
  watermark moved. The launcher's own record now wins outright whenever it
  started the process, because preferring a guess over a fact is what made the
  leak reachable. `hooks.mjs` already carried a comment explaining all of this,
  written after the same mistake was made there; the lesson never crossed the
  file boundary, which is why the rule now lives in the contract.
- **The official Claude→Codex import spoke for one agent and returned for all.**
  It seeded the thread and returned before the loop that gathers every other
  agent ran, so on a project where Grok or Antigravity had been working, none of
  it travelled on what is often the very first switch. The same early return
  dropped the decisions and next notes written with the handoff, which is the
  quieter loss and arguably the worse one.
- **A first switch no longer exceeds the command line.** Packing a whole
  conversation produced 1.0MB against an `ARG_MAX` of 1048576 and `spawn`
  refused it outright, so the agent never started and the failure arrived as a
  launch error rather than as anything about context.
- **A delta is delivered only once something is carrying it.** Building the
  command consumed it, so a launch that never started still recorded the context
  as handed over. Delivery is now committed on the child's spawn event.
- **A turn is not over because a tool call started.** Antigravity writes a
  response as `DONE` the instant it issues a tool call, and the tool rows that
  follow are not conversation, so the transcript read as finished for the whole
  duration of every tool call. Replaying one real session, the turn looked over
  at 25 separate moments, each a chance to terminate the agent mid-work.
- **Text an agent truncated itself no longer travels as though it were whole.**
- **A missing binary is looked up by the adapter, not by the agent's id**, which
  had Antigravity reported as not installed while installed, because it is `agy`.
- **A session the bridge starts is a session it can return to.** Starting a fresh
  Codex or Grok session wrote nothing into state, so `bridge grok` refused to
  resume the very session it had just created and every handoff minted another
  one. One project collected six Grok sessions before anyone noticed.
- **Codex discovery had been dead on this machine for weeks.** Rollout head
  records were parsed from a fixed 16KB buffer while codex-cli embeds its base
  instructions there and the record grew to 22KB. Every parse failed, nothing
  matched any project, and none of it produced an error, because a failed parse
  looks exactly like "a different project".
- **A Claude session that never spoke no longer becomes the project's link.**
  Claude names its transcript at session start and writes it at the first
  message, so a session opened and closed without a word left state pointing at a
  file that never existed.
- **A Claude hook running inside another agent refuses instead of writing.** Grok
  loads Claude's own `~/.claude/settings.json` hooks by default, so a bridge hook
  can fire in the wrong agent and record the wrong conversation.
- **Expected failures stopped printing stack traces.** A missing plugin or an
  unreadable source is not a crash, and an eight-line Node stack says the tool is
  broken when the truth is that something needs installing.

### Changed

- **`bridge doctor` stopped overclaiming.** Routes said `READY` when all they
  knew was that the binaries were installed. They say `CONFIGURED` now, backed by
  a canary proving each agent's session still parses with this version, and
  `--deep` reports `LIVE` or `BROKEN` after asking each agent a real question. An
  unreadable session takes its routes off green and the exit code with it.
- **`prepublishOnly` guards the registry.** A published version cannot be
  withdrawn, only superseded, so the tests are no longer the last thing standing
  between a broken build and npm.
- **Documentation caught up.** `ARCHITECTURE.md` had described a two-agent
  product with no adapters and a state schema whose field names were gone, while
  shipping inside the package.

## [0.8.0] — 2026-07-21

First version on npm, as `@serdardb/context-bridge`. The plain name belongs to an
unrelated library, so the package is scoped and everything else keeps its name.

### Added

- **Three agents, six directions.** Grok joined behind an adapter contract, so
  adding an agent is one file rather than a dozen edits.
- **Chains keep their history.** `knownBy[target][source]` records, per pair, how
  far into each agent's own stream material has been packed for each other agent.
  Claude to Grok to Codex now delivers Claude's work to Codex too.
- **Agent flags forwarded through the launcher**, so
  `bridge claude --dangerously-skip-permissions` reaches the agent verbatim.
- **Checkpoint retention built on the delivery lifecycle**, not a clock: a
  companion is dropped once its reader hands off, with `bridge clean` as the
  manual backstop.

### Fixed

- **Watermarks stopped assuming time is universal.** Grok's chat rows carry no
  timestamps, so a time-based mark silently resent the whole conversation on
  every switch. A watermark is now whatever the adapter says it is.
- **Grok's checkpoints were never pruned**, because the retention pattern was
  written by hand for the original pair. Nothing enumerates agents by hand now.
- **A launcher that cannot read a newer state file says so** and asks to be
  restarted, instead of waiting for a switch that can never come.

## [0.7.x] — 2026-07-20

- A handoff carries what the target missed from every agent, not just the last
  one.
- One handoff path for every direction, replacing the pair-shaped original.
- Doctor and the agent skills stopped assuming there were two agents.
- Closing words survive a handoff: the departing agent's final answer is written
  after the handoff command runs, so it used to be dropped.

## [0.4.0 – 0.6.0] — 2026-07-19 to 2026-07-20

- Per-agent adapters introduced, with Grok as the first implementation, and
  uniform agent state with a real migration.
- Checkpoint retention and `bridge clean`.
- The bridge stopped promising switches it could not perform.

## [0.3.0] — 2026-07-19

- **Un-truncated companion beside every delta.** A size cap clipped long prose
  mid-draft; the cap stayed, and the full text now travels beside it.

## [0.2.0] — 2026-07-19

- **Adopt flow.** A session started outside the bridge can be linked mid-flight,
  deterministically where identity is certain and with confirmation where it is a
  guess.

## [0.1.0] — 2026-07-19

Initial public release. Claude Code and Codex, one linked pair per project, the
official import for the first switch and deltas for every switch after it.
