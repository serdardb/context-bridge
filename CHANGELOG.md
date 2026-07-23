# Changelog

Newest first. Dates are the day the work landed on `main`.

Entries say what changed and, where it matters, why. Most of the fixes here came
from something failing quietly, and the reasoning is usually the interesting
half.

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
