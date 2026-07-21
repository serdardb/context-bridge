# Changelog

Newest first. Dates are the day the work landed on `main`.

Entries say what changed and, where it matters, why. Most of the fixes here came
from something failing quietly, and the reasoning is usually the interesting
half.

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
