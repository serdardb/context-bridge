# context-bridge

[![npm](https://img.shields.io/npm/v/@serdardb/context-bridge)](https://www.npmjs.com/package/@serdardb/context-bridge)
[![CI](https://github.com/serdardb/context-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/serdardb/context-bridge/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@serdardb/context-bridge)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@serdardb/context-bridge)](LICENSE)

**Switch agents. Not context.**

Developers increasingly use multiple coding agents — but switching between them usually means losing conversational context, or manually copying summaries, session IDs and file lists from one tool to the other.

**context-bridge connects native coding-agent sessions.** Each agent keeps its own real session; the bridge remembers which sessions belong to the same project and transfers only the context the other agent is missing.

- It does **not** replace Claude Code, Codex, Grok, Antigravity or OpenCode.
- It does **not** proxy their APIs.
- Bridge requires no separate model API credentials. Each agent uses its own configured authentication, provider and usage limits.

**Supported today: Claude Code, Codex, Grok, Antigravity and OpenCode**, in any of the twenty directions.

🎥 **Walkthrough:** [watch the original install-and-switch demo on X](https://x.com/SerdarDB/status/2078981172080574900). It was recorded with Claude Code and Codex, before Grok, Antigravity and `bridge inspect` were added, so it shows the flow rather than the current full set.

**Project page:** [dogrubakar.com/projects/context-bridge](https://dogrubakar.com/projects/context-bridge) — what it is, why it exists, and the write-ups behind each release.

> **Status: developer preview (0.13.0).** The core flow is tested and used daily, but vendor session formats can change under it — treat it as a private-beta tool, not a hardened production release.

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
- No Bridge model subscription; agent calls use your configured providers and may incur usage charges
- No nested TUIs — a flat launcher owns exactly one agent at a time

## Why context-bridge

One direction already exists officially: OpenAI ships a Claude Code plugin and Codex's `/import` that can turn a Claude session into a Codex thread. context-bridge **uses** that official machinery where it exists — and adds everything around it:

1. **The way back.** Nothing official returns another agent's context to your *original* session. The bridge extracts what changed (conversation, decisions, files, git) and injects it on resume, through each agent's own mechanism.
2. **Repeat switching.** Re-importing creates a brand-new thread every time (we verified this). The bridge links each agent **once**, remembers the session, and afterwards syncs with compact deltas into the *same* sessions.
3. **Chains, not just pairs.** With five agents there are twenty directions, and a hop must not cost you the hop before it. The bridge tracks what each agent has already been told, by each other agent, so a handoff carries everything the target missed no matter who produced it.
4. **Zero session management.** Session discovery, thread capture, resume commands, injection — all automatic. You only ever type `/bridge <agent>` or `$bridge <agent>`.

**Honest about the asymmetry.** The first switch to an agent has to create something, for every tool that does this, because the target has no session yet: Claude → Codex uses OpenAI's official import, and the others open a new session seeded with the conversation. After that first switch the agents differ in how a handoff reaches them, and the difference is worth stating plainly rather than glossing:

| | how a delta arrives | why |
|---|---|---|
| Claude Code | its `SessionStart` hook, plus a one-line prompt that opens the turn | the conversation continues; nothing is pasted in front of it |
| Codex | its `SessionStart` hook, plus a one-line prompt that opens the turn | same, once you have trusted the hooks with `/hooks` |
| Grok | the opening prompt of the resumed session | its hooks exist but ignore what they print, so nothing can be injected |
| Antigravity | the opening prompt of the resumed session | it ships no hook mechanism to inject through |
| OpenCode | written straight into its own session store | it keeps sessions in a local database and its interactive TUI cannot be handed an opening message, so the context is delivered but you open the turn |

The delivery format and capacity differ by route. A bounded preview can omit messages; it identifies omissions and points to retained full context. Delivery does not prove that the model read the whole record. Claude, Codex, Grok and Antigravity receive a turn-opening prompt; with the current OpenCode adapter, context is inserted into its session store and you type to begin the turn.

## How it works

```
shell
└── bridge                     ← launcher (local Node CLI)
    └── one agent child at a time
        claude ⇄ codex ⇄ grok ⇄ antigravity ⇄ opencode  ← real sessions, any direction

global project store            ← machine-local state outside the repository:
                                 native session references, knownBy matrix,
                                 checkpoints and pending markers
                                 (never transcripts; Git is optional)
```

The physical store is `~/Library/Application Support/context-bridge` on macOS,
`$XDG_STATE_HOME/context-bridge` on other platforms, including Windows (falling back
to `~/.local/state/context-bridge`), or `CONTEXT_BRIDGE_HOME` when explicitly
configured for a managed/test environment. Checkpoint text keeps the historical
logical `.bridge/...` name in handoff messages, but no `.bridge/` directory is
created in a project by default.

- `/bridge <agent>` (a Claude plugin skill) and `$bridge <agent>` (a shared skill for Codex, Grok, Antigravity and OpenCode) are the same command with a target argument. The departing agent writes a reading of the work plus decisions and open questions, the bridge computes what the target is missing from every agent's native session files plus git, and delivers a bounded delta with Summary, Conversation, Decisions, Work and Next. Summary is the interpretation; Decisions and Next remain deliberately compact scan/fallback fields, so they are not removed as redundant when a summary exists.
- **Delivery uses whatever each agent supports.** Claude and Codex take the delta through their own `SessionStart` hook, so it lands inside the conversation; Codex falls back to an auto-submitted resume prompt until you have trusted its hooks once with `/hooks`, and Grok always uses the prompt, because its hooks fire but ignore what they print. OpenCode has neither road (no hook, and a resume that cannot be handed a prompt), so the delta is written straight into its session database and is there when its TUI opens. One road is selected per handoff. Hooks write output before acknowledging it; an output failure preserves pending context, while a crash between output and acknowledgement may cause a repeat. No exactly-once guarantee or model-receipt claim is made.
- Later deltas also carry a **full-context checkpoint** in the machine-local project store. Delivered text names its directly readable filesystem path; internal state retains logical `.bridge/checkpoints/...` identifiers. The bounded summary keeps handoffs fast; exact wording remains available after delivery for recovery and audit until the checkpoint group is pruned. Canonical memory is each agent's native transcript plus the `knownBy` matrix.
- **Interrupted closing additions are recoverable.** A pending-state journal freezes the exact additions before either checkpoint changes. Restart `bridge` to finish a verified partial addition without duplicating it. Delivery and replacement handoffs stay blocked until recovery completes; independently changed or unsafe evidence is retained for inspection. `status --json` reports `closing-recovery-required`. This does not establish power-loss durability or compatibility with older writers.
- **Agent flags pass straight through.** `bridge claude --dangerously-skip-permissions --model claude-fable-5` forwards everything after the agent name to that agent verbatim, so any flag it supports (now or later) just works. The set applies to that launch. `--cb-save-args` writes it to this project's machine-local store, `--cb-clear-args` takes it back, and `bridge status` lists what is armed, because a saved permission bypass nobody can find is one nobody can undo. Flags that change what an agent may do without asking are announced on a plain line at every launch. The only args the bridge holds back are the ones that would break its own session link (`-c`, `--resume`, `--fork-session`, `--no-session-persistence` on Claude; `--last`, `--cd`, `--remote` on Codex), each dropped with a printed reason. `--cb-*` is reserved for the bridge itself.
- **A handoff carries what the target missed, from everyone.** The bridge remembers, per pair, how far into each agent's own stream it has packed material for each other agent. So Claude → Grok → Codex works: Codex receives Grok's work *and* the Claude context Grok was given, each block labelled with who said it, instead of losing a hop's worth of history at every switch. Watermarks avoid routine resends; interrupted acknowledgement or revised source history can require replay.
- **Checkpoints are retained evidence.** A handoff to an agent that already has an undelivered one replaces it. The full-context checkpoint, delta and audit manifest share one retention policy: by default, a group is pruned only when it is both older than 7 days and outside its lane's newest 20 groups. Pending injections are protected. `bridge clean` (with `--dry-run`, `--keep N`, `--days N`, `--all`) also provides explicit cleanup. An inspection or deletion failure is reported with a nonzero exit; any earlier deletions are not rolled back. Automatic cleanup warns without undoing a prepared handoff. Canonical memory is each agent's native transcript plus the `knownBy` matrix, never these files.
- **Evidence is local and sensitive.** Full-context checkpoints can contain the exact conversation; audit manifests can contain command arguments, file names and project paths. They live in the machine-local store, are not added to the repository or npm package, follow the same handoff-group retention policy, and should be inspected before sharing. The opt-in debug logger redacts content, tokens and personal paths, but checkpoints are intentionally preserved evidence rather than a redaction boundary.
- **Interrupted evidence writes stay separate.** A checkpoint, audit or preparation journal is published only after its staging file is fully written. `bridge clean --staging --dry-run` previews abandoned staging files; omit `--dry-run` to remove them, optionally scoped by `--lane NAME`. This mode does not prune checkpoint groups. Live or uncertain process owners, symlinks, unknown filenames and pending/preparing groups are preserved. A published preparation journal must be resolved by handoff recovery before its leftover staging file can be removed.
- **Interrupted handoff preparation has a recovery record.** The next handoff checks dead writers' preparation journals before creating new evidence. Unreferenced files are removed only if their complete contents match the recorded hashes; pending or consumed handoffs keep their evidence. Changed files stop recovery for investigation. A prepared audit that cannot be written now fails the handoff instead of silently dropping its evidence. This is process-exit recovery, not a guarantee against power loss or external vendor-session side effects.
- **Handoffs can be previewed safely.** `bridge handoff <agent> --dry-run` reads the current state, sessions and git delta, then reports the selected delivery road and estimated payload without creating a checkpoint, changing pending state, pruning, or importing a vendor session.
- **Portable context is explicit.** `bridge artifact export report.cbctx` writes a versioned, SHA-256 verified, redacted context artifact. `bridge artifact import report.cbctx` verifies it without changing the project; add `--apply` to stage it as an idempotent seed. Native vendor sessions are never claimed to be portable.
- **Export redaction is not a secrecy guarantee.** Export masks the project/home paths, recognized credential assignments and headers, common GitHub/AWS/Slack tokens, JWTs and PEM private-key blocks. It applies to context sections and audit data without editing the local evidence. Unknown secret formats, encoded values and sensitive prose can remain; inspect the artifact before sharing it. Hashes and signatures do not encrypt its contents.
- **Optional local encryption.** `bridge artifact seal report.cbctx --out /existing/parent/new-bundle` validates the artifact and creates a private new directory containing `context.cbsealed` and a separate `key.bin`. Share only the encrypted file; deliver the key through an independent trusted channel, never upload the whole bundle. `bridge artifact open context.cbsealed --key-file key.bin --out /existing/parent/new-report.cbctx` authenticates, decrypts and validates before publishing a new file; it does not import or initialize a project. Signed input still requires `--verify-key trusted-public.pem` at both steps. Version 1 uses a fresh random key and nonce per AES-256-GCM envelope, accepts up to 16 MiB of plaintext, and refuses overwrites. Parent directories must already exist. Encryption does not establish sender identity or revoke copies already received. These commands are local-only; network transfer requires a separate explicit `share` command. Selected Windows publication-interruption checks run in CI; physical power-loss durability is not claimed.
- **Opt-in remote sharing.** Separate `share` commands transfer only existing sealed envelopes to an operator-chosen endpoint. `share send` previews locally unless `--apply` is present. `share fetch` requires the exact ciphertext hash and writes a new encrypted file, never a decryption or automatic import. No normal handoff, artifact export or installation contacts the service. See [remote sharing](docs/SHARING.md) for authentication, TLS, retention and operating limits.
- **Optional sender verification.** Export with `--sign-key private.pem` to sign the redacted artifact using an Ed25519 private key. Import with `--verify-key trusted-public.pem` (and optionally `--apply`) to require a signature matching that explicitly trusted key. Signed artifacts without a trusted key, unsigned artifacts when a key is required, wrong keys and altered payloads are rejected before target initialization. No embedded key is automatically trusted. Exchange the public key through an independent trusted channel; never share the private key. Ordinary unsigned import checks integrity only, not sender identity. Signatures do not encrypt the artifact, revoke keys or prevent a trusted signer from making incorrect claims.
- **Content-addressed local cache.** `bridge artifact cache report.cbctx --json` validates and stores the exact file bytes under the central storage home's `artifacts/sha256/` directory, returning a `sha256:<hash>` reference. Use that reference in place of a filename with `bridge artifact import sha256:<hash> --apply`. Repeated identical files share one entry; changed bytes, even whitespace, have a different address. Every reference read verifies the address and artifact integrity; existing mismatched entries and symlinks are rejected, never overwritten. Signed cache operations and imports still require `--verify-key`. Cache references are local to this machine, not download links: transfer the `.cbctx` file to another machine and cache it there. Cache entries are explicitly retained, not removed by checkpoint pruning.
- Export includes only the audit paired with the selected full-context checkpoint. A missing paired audit stays absent; another handoff's audit is never substituted. A malformed or symlinked paired audit stops export without replacing an existing output artifact.
- New full-context checkpoints record section lengths and a digest in a Markdown comment. Artifact export uses that index, not headings inside messages, and rebuilds it after redaction. Invalid indexes stop export. Legacy checkpoints remain intact as opaque context with empty structured fields (`source.sectionFormat: "opaque"`), rather than guessing their boundaries. Indexed structured fields describe the composition-time sections; closing words appended later remain in the full context. The index detects inconsistency, not sender authenticity.
- Artifact provenance records the producer package version separately from the local state schema version. Export refuses symlinked full-context checkpoints; it does not follow them into external files. Integrity hashes detect content changes but are not signatures or proof of a trusted author.
- Applied artifact hashes are recorded in the target lane's state atomically with the pending seed. Consuming the seed does not erase that receipt, so retrying an import after a process exit cannot enqueue it again. A pre-write import journal lets a retry remove verified, unreferenced checkpoint files left before state commit. Modified files or files referenced by a pending handoff stop recovery rather than being deleted. This covers process exits at the tested write boundaries, not arbitrary power-loss durability.
- **Context evaluation.** `bridge eval --json` runs deterministic fixtures and reports summary, selected transcript and full-context checkpoint checks separately. Required summary facts cannot be satisfied by their presence only in the transcript; every source message must remain whole in the checkpoint. Omission notices must name the correct source and match its selected/omitted counts; a warning with incorrect counts or a duplicated notice fails. These are explicit text-preservation checks, not a claim of semantic understanding or live-agent recall. Live delivery and token-efficiency verification remain separate.
- `bridge eval --live codex --json` explicitly calls the configured Codex provider with synthetic, randomized context in a temporary directory. Provider usage applies. It scores five exact final-answer fields, including declining to invent an absent owner, and rejects prompt echoes, malformed answers, process failures and timeouts. No project transcript is sent. Codex uses an ephemeral read-only session; temporary evaluation files are removed afterward. This is fresh-session prompt recall, not proof of native session continuity, hook delivery or general semantic quality. Other adapters currently reject live evaluation rather than silently running a different check.
- `bridge eval --live codex --scenario decision --json` adds a constrained-choice assessment: distinguish the final decision from an earlier proposal, select its rationale and next check, identify the rejected alternative, and report an unassigned owner and omitted transcript. It randomizes answer codes, choice order and two opposing authorization policies; the correct codes are not supplied in the source context. Six exact fields are scored, not free-text similarity or a model judge. This is synthetic decision interpretation, not general reasoning quality or actual hook delivery; it calls the configured provider and usage applies. The default remains `--scenario recall`.
- `bridge eval --live codex --scenario summary --json` first asks a fresh agent session to summarize a synthetic conversation without seeing the answer choices. A second fresh session receives that generated summary in the bounded context body and answers the six decision checks. Empty, failed or oversized summaries fail without calling the receiver. This uses up to two provider calls within one shared deadline. `generation` reports writer usage separately; top-level `tokens` and efficiency describe the receiver only. No generated text is printed. This is a bounded summary-transfer measurement, not proof of arbitrary summary quality or native hook delivery.
- Live evaluation reports Codex's `turn.completed` token usage when valid, never a bytes-to-tokens estimate. These are **whole-turn** totals, including context outside the bridge delta; cached input is a subset of input, not an additional charge. Efficiency reports context bytes and whole-turn input tokens per correctly recalled field, not pricing or a universal quality score. Missing, invalid or oversized telemetry leaves token usage unknown and cannot satisfy token verification. Raw event text is not included in the report.
- **Release CI evidence.** `bridge release-check --ci --json` uses the authenticated GitHub CLI to check the latest `ci.yml` run for the exact local HEAD and its selected attempt. The run and every reported job must be completed successfully; absent, skipped, failed or unreadable results do not pass. Without `--ci`, CI remains explicitly unverified. A successful HEAD run does not cover uncommitted edits: the separate clean-tree check still applies. This developer release command is not a Git or GitHub requirement for normal bridge use.
- **Prepare acceptance before npm authentication.** `bridge release-prepare` runs tests, syntax checks, deterministic eval, clean installed-package acceptance, dependency audit, exact-HEAD CI/release checks, `verify --all`, and Codex live recall. It records a private receipt outside the repo, bound to the commit, actual tarball SHA-256 and toolchain. Publication runs `release-check --evidence --json`, which verifies those bytes locally without calling agents or GitHub. Missing, failed, changed or older-than-24-hour evidence blocks publication. `verify --all` still requires every supported agent; ordinary `verify` checks installed agents. This local receipt is not tamper-proof attestation or proof of native handoff delivery, which remains a separate release requirement. Normal runtime use does not require GitHub CLI or every vendor installed. See [the release checklist](docs/DEVELOPMENT.md) for the full contract.
- **Stored evidence is searchable.** `bridge search "migration"` searches local delta, delivered delta, full-context and audit files. `--lane` selects a lane; `--agent` matches either end of a handoff. `--since YYYY-MM-DD` and `--until YYYY-MM-DD` filter checkpoint timestamps by inclusive UTC dates. `--json` returns `{ results, incomplete, issues, snippetsOnly }`; filenames are relative to their checkpoint directory. Unreadable/unsafe evidence or unknown branch metadata needed by a filter is disclosed, with exit status 1 and any available matches preserved. An empty result with `incomplete: true` is not proof that nothing matched. The scan covers retained files, not an atomic snapshot or deleted history.
- `bridge search "migration" --branch feature/example` matches the branch recorded in that handoff's paired audit, not the current checkout. Records without branch metadata do not match a branch filter but remain searchable without it. Git is optional when producing audits and is not needed to search already recorded branch metadata.
- **Preview storage migration.** `bridge storage plan` (or `--json`) reads legacy `.bridge` contents without changing either store. It reports file hashes and sizes, conflicting global data, files removed after backup and unrecognized files left in place, including inside checkpoint and lane directories. Only state/config files, versioned state backups and timestamp-and-direction checkpoint filenames are eligible for removal. For an unregistered project, the destination UUID is assigned only when migration runs. The preview is a snapshot; migration rechecks the data when executed.
- **Interrupted migration cleanup is recoverable.** A journal records the verified backup before removing source files. A later migration can finish that cleanup after a process exit, including when the source directory is already gone. `storage plan` reports the pending recovery without performing it. Changed source files or a destination that differs from the backup stop cleanup instead of being overwritten; retain the journal and backup for investigation. This is not a guarantee against power loss or simultaneous writes by older bridge versions.
- Stop legacy launchers before migration. A live launcher recorded in the old state blocks migration before project registration or copying; restart it with the updated bridge after migration. This check cannot detect unrecorded older writers, so do not run old and new bridge versions against the same project during the move.
- Legacy source files are retired by atomic rename into the runtime home's `retired-migrations/` directory, not unlinked after a hash check. These originals are retained separately from the verified backup and are not automatically pruned: an old writer may still hold an append descriptor. A detected late change refuses recovery and names the preserved file. Mixed-version operation remains unsupported; source retirement protects evidence, not automatic merging of concurrent updates.
- Migration flushes verified copies before source retirement, then flushes retired originals and completion evidence in order. POSIX also flushes the affected directory chains; Windows does not have that directory guarantee. A flush failure stops with `BRIDGE_MIGRATION_SYNC_FAILED` and leaves preserved evidence for `bridge storage plan`. This does not promise recovery from power failure on arbitrary hardware or durability of later writes by an old process.
- For a project on a different filesystem from the runtime home, create a private directory **outside the project on the project's filesystem**, then run `bridge storage migrate --retirement-dir /absolute/path/to/vault`. The global runtime and verified backup still live in the normal home; only original source inodes stay in this vault. Without a suitable vault, cleanup refuses and preserves the source instead of doing copy-and-delete. A pending migration records the chosen vault and resumes there without requiring the flag again; it cannot change location after any source file has been retired. `bridge storage plan --json` reports the recorded recovery path. Do not remove the vault while old processes might still write to it.
- If an old process recreates recognized project-local runtime files beside an existing global state, regular reads refuse with `BRIDGE_STORAGE_DIVERGED` rather than silently choosing the old state. `bridge storage plan` remains available for diagnosis. Stop the old processes and reconcile the preserved evidence; the bridge does not guess which concurrent update should win.
- Completed migrations keep private receipts under the runtime home's `migration-receipts/`. `storage plan` and `doctor` compare retired originals with their recorded hashes, so a late append remains visible even after the in-progress journal is gone. Changes, missing originals or an unavailable vault volume fail diagnostics; `verify` also refuses without spending model calls. Normal edits to the active global state are not treated as evidence corruption. Receipts are local recovery records, not tamper-proof attestations, and diagnostics are on-demand rather than background monitoring.
- A legacy state lock with a live or unknown owner also blocks migration without changing either store. A provably dead owner's lock is backed up with the old state and removed from the project; subsequent global writes recover that stale lock normally. Do not manually remove a lock while its writer is running.
- Abandoned migration staging copies are removed after successful migration only when their owner is no longer alive and their files exactly match the verified backup. Changed or unknown contents, symlinks and live-owner copies are retained; `storage plan` lists them with reasons even after migration has completed.
- `bridge storage cleanup-ignore` previews exact obsolete `.bridge` rules in the project's `.gitignore`; add `--apply` to remove them or `--json` for a structured report. It does not run Git, create a registry or edit any other ignore patterns. It refuses cleanup while a local `.bridge` entry remains, including retained user files, and refuses symlinked or non-UTF-8 ignore files. Migration itself never edits `.gitignore`.
- **Reconnect a moved project.** If a move changes the directory's filesystem identity, run `bridge project list --json` to find its existing UUID, then run `bridge project adopt <id>` from the new directory before starting a new bridge session there. Adoption refuses a still-existing old directory, an already registered target or legacy runtime data in the target. Git is not required. This reconnects the machine-local bridge store; it does not move vendor-owned native sessions or guarantee that their stored working directories remain valid.
- **Older registrations and filesystem support.** Automatic matching includes directory birth time to distinguish recycled inodes. On Linux x64/arm64, tmpfs without birth time can instead use its filesystem identity and opaque kernel file handle, scoped to the current boot. Neither route writes a project marker or requires Git. Older registrations are `unverified` and require an explicit `project adopt <id>` after you check ownership. Confirming an old registration in its original directory is allowed even with legacy `.bridge` data: confirmation only updates the identity, then `bridge storage migrate` performs its normal conflict checks and verified backup. Adopting a different directory still refuses legacy data. Other filesystems without a supported creation identity cannot register or adopt projects; the command refuses rather than attach potentially unrelated context.
  Listing is read-only and reports `present`, `missing`, `unreadable`, `replaced`, `redirected` (a symlink), or `not-directory`. These describe the recorded path at inspection time, not the health of its stored sessions. `missing` can mean a move or an offline volume; no record or evidence is automatically deleted. Permission and other inspection errors carry an `errorCode` rather than being treated as absence. Explicit retirement and cleanup are described below.
  `bridge project inspect <id> --json` examines that UUID's retained store even when the old project directory is gone. It reports stored file counts/bytes, pending deliveries, live launcher records, preparation journals, unfinished operation records and incomplete reads without printing conversation bodies or session IDs. `migrationEvidence` inventories matching entries outside that store in `migrations`, `migration-receipts` and `retired-migrations`, even if the store itself is absent; it does not open those entries or validate their contents or external retirement locations. Unsafe or unreadable entries produce `complete: false` and exit 1. It neither migrates nor removes data. This is a point-in-time inspection, not a deletion authorization or proof that an unrecorded agent process is absent; backups and migration/import journals outside the project store are not included in its byte count.
  `bridge project recover <id> --json` previews interrupted handoff operation records. Add `--apply` to remove only validated records whose process owner is definitely gone, under the UUID runtime guard. Live or unverifiable owners are retained regardless of age; PID reuse can conservatively retain a record. Unsafe/unreadable records remain and produce exit 1, even if other safe records were removed. This does not complete a handoff or remove checkpoints, pending deliveries, native sessions or project registrations. It works without the old project directory; inspect the resulting project state before retrying a handoff.
  `bridge project retire <id>` previews archiving a quiescent UUID store; `--apply` performs it. Pending deliveries, live recorded launchers, operation/preparation records, unfinished migration/import evidence and incomplete inspection block retirement. The registry retains an explicit lifecycle record, preventing delayed writers from silently recreating the store. `bridge project restore <id> --apply` restores the same UUID and bytes. Both commands support `--json` and work when the old working directory is missing. Interrupted `retiring` or `restoring` transitions resume by repeating the same command; existing source and destination stores are never merged. Only the bridge-owned UUID directory moves into `retired-projects/`; project code, native agent sessions, migration backups and external receipts remain untouched. Archiving does not free disk space. Stop older bridge versions first: writers that predate lifecycle ownership do not participate in this protocol.
  `bridge project purge <id> --json` previews permanent removal of that archived UUID store, including its file count and logical bytes. It refuses active stores. Deletion requires `--apply --confirm <id>` with the same UUID; it is irreversible. The registry records `purging` before deletion, so a process interruption can resume with the same confirmed command; `restore` is not allowed after purge begins. Unsafe links, unexpected data and unfinished work cause refusal. Completed purge keeps a small `purged` identity record and stable guard, not the archived content, so delayed writers cannot recreate it. The same identity remains unavailable for new work; this is not a reset command. Project code, agent-native sessions, migration backups, exports and external receipts are not deleted. Do not edit archived files with other tools during purge; bridge ownership does not lock unrelated filesystem writers.
- The launcher watches the state file. When a handoff is ready **and the agent's turn has finished**, it terminates its own child process (SIGTERM, never by name, never SIGKILL) and starts the other agent. Terminal state stays healthy; Ctrl+C inside an agent behaves normally. It also records which state version it understands, so a launcher left running across an upgrade is told to restart rather than silently failing to switch.
- **Started without the bridge?** Sessions can be adopted mid-flight. `$bridge claude` inside a Codex session that was never linked adopts it automatically (Codex exposes the running thread via `CODEX_THREAD_ID`); if that variable is unavailable, the newest Codex session working in the project directory is offered as a candidate and linked only after you confirm (`--adopt`). Codex-first projects work too: with no Claude session to resume, the delta — plus a pointer to the full Codex transcript — seeds the first Claude session that starts in the project. The rule everywhere: **automatic when identity is deterministic, confirmed when heuristic.**
- **Recovering from a dead or externally started agent:** run `bridge handoff <target> --from <source>` from a healthy terminal. This rebuilds the handoff from the source agent's readable session on disk and keeps heuristic adoption separate from normal in-session switching. The command does not switch the terminal automatically; launch the target with `bridge <target>` afterward.

## Requirements

- macOS, with selected Linux and Windows acceptance described below. This is
  not a claim that every agent/provider/terminal combination works on every OS.
- Node.js ≥ 18.18
- At least two of the supported agents, logged in:
  - [Claude Code](https://code.claude.com/docs/en/setup) ≥ 2.1.x, with your Claude subscription
  - [Codex CLI](https://developers.openai.com/codex) ≥ 0.143.0, with your ChatGPT subscription (`codex login`)
  - [Grok CLI](https://github.com/superagent-ai/grok-cli) ≥ 0.2.x, with your xAI key (`grok auth`)
  - [OpenCode](https://opencode.ai) ≥ 1.18.x, with a provider configured (a free model works; the bridge never makes the call itself). Reading a handoff snapshot or delivering into it also needs the `sqlite3` CLI, which macOS ships by default; `bridge doctor` says so if it is missing.
  - Antigravity, with its native CLI authenticated and session history available
    (see [adapter requirements](docs/ADAPTERS.md)).
- Core installs Koffi for native locking and safe publication. Keep its platform
  dependencies available; `bridge doctor` checks the backend. MCP is optional
  and installed separately, as described below.
- Git is optional. Project identity, storage, ordinary lanes and handoffs work
  without Git installed. Git-derived work summaries and worktree operations
  require it.

OpenCode store access honors `OPENCODE_DB` (absolute path, or relative to its
data directory) and `XDG_DATA_HOME`. `OPENCODE_HOME` remains a Bridge-specific
data-directory override; keep it aligned with the native agent's configuration.
An in-memory OpenCode database cannot be shared with Bridge. Nonstandard channel
database names currently require an explicit `OPENCODE_DB` path.
For handoff and closing snapshots, Bridge backs up the database through SQLite
into a private temporary directory, then runs the native exporter against that
copy. This includes committed WAL data without mixing later live writes into
the same export. It needs temporary disk space for the whole database; the copy
is removed when export finishes. Backup failure reports an unavailable source
rather than falling back to an inconsistent live export. Abrupt process or
machine termination can leave the private temporary directory behind.

## Installation

```bash
npm install -g @serdardb/context-bridge

bridge doctor        # see what's present and what's missing
bridge doctor --fix  # bootstrap the missing pieces (asks before each change)
bridge verify        # run real smoke checks and verify every installed route
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

Shared skill updates are atomically published. The bridge's Codex allow-rule is
created only when absent; custom `bridge.rules` content is preserved for manual
review, never replaced. Diagnostics recognize the exact managed rule rather than
an arbitrary file; effective permission decisions still belong to Codex.

- the **context-bridge Claude plugin** (provides `/bridge` + session hooks)
- the **official OpenAI Codex plugin** for Claude Code (`openai/codex-plugin-cc`, used for the first import)
- the **$bridge agent skill** (`~/.agents/skills/bridge/SKILL.md`, shared by Codex, Grok, Antigravity and OpenCode)
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

Antigravity
  ✓ Installed: 1.1.10
  ✓ Authenticated
  ✓ Conversation history readable
  ✓ Session readable by this version of the bridge (47 messages)

OpenCode
  ✓ Installed: 1.18.12
  ✓ Authenticated
  ✓ Authentication configured
  ✓ sqlite3 present (used to inject a handoff into OpenCode's session store)
  ✓ Session readable by this version of the bridge

Bridge
  ✓ bridge on PATH (hooks can reach it)
  ✓ Project state: linked claude, codex, grok, antigravity, opencode

Available routes
  claude->codex      ✓ CONFIGURED  first switch: official import
  claude->grok       ✓ CONFIGURED  first switch: delta-seeded
  claude->antigravity ✓ CONFIGURED  first switch: delta-seeded
  claude->opencode   ✓ CONFIGURED  first switch: delta-seeded
  … and 16 more — every ordered pair of the five agents, twenty directions in all

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

The first switch to an agent links it: Claude → Codex uses the official OpenAI transfer, and other first switches seed a new session with bounded context and a retained full-context pointer. After that a switch is a resume plus a compact delta — no re-import, same sessions, prior context intact.

Coming back is the same command in the other direction. Ask the agent *"where were we?"* and it knows, including what happened in an agent you never spoke to on this hop.

Each delta costs the receiving agent one short acknowledgment sentence — that is the entire overhead.

## Lanes

A project directory usually holds one line of work. When it holds two — a feature and an unrelated bug fix — a **lane** keeps them apart: each lane has its own agent links, its own switch history and its own checkpoints, and the lanes do not see each other. Two lanes in two terminals run at once, the way two plain `claude` sessions in one directory already can.

```
bridge lane                    list the lanes here, most recently active first
bridge lane new <name>         start a new, empty lane and switch to it
bridge lane switch <name>      point the default lane at an existing one
bridge lane rm <name> --yes    delete a lane and its checkpoints (--dry-run to preview)
```

A new lane starts empty on purpose: a different line of work inherits nothing, which is the whole reason to open one. A bare `bridge` resumes the lane you were last in, so a project that only ever has one lane never has to think about them.

**Ordinary lanes isolate context, not files.** They share one checkout, so switching an ordinary lane does not switch files. Two lanes editing the same files can collide. For code isolation, use the optional [worktree-backed lanes](#isolated-worktree-lanes) below. Only that feature requires Git; ordinary lanes and handoffs also work without Git installed.

## Architecture

| Piece | What it is |
|---|---|
| `bridge` CLI | Local Node CLI: launcher loop, state, deltas, doctor |
| `global project store/state.json` | Versioned machine-local state: session references, sync watermarks, optional Git metadata, pending markers. Migrated forward automatically, keeping the original as `state.json.v<n>.backup` and saying so once. Never transcripts. |
| `src/agents/` | One adapter per agent: discovery, resume command, activity parsing, idle signal, conflicting flags, health. Adding an agent is one file. |
| `knownBy` matrix | Per pair, how far into each agent's own stream has been packed for each other agent. This is what makes chains keep their history. |
| Claude plugin | `/bridge` skill + `SessionStart` / `Stop` / `UserPromptSubmit` hooks (session recording, delta injection, idle marking) |
| Codex hooks | The same three events in `~/.codex/hooks.json`, installed by `doctor --fix` and merged into whatever is already there. Each hook names the agent it belongs to, so one firing inside a different CLI refuses instead of writing the wrong session into state. |
| Shared agent skill | `$bridge <agent>` for Codex, Grok, Antigravity and OpenCode → runs `bridge handoff <agent>` |
| Official import | The first Claude→Codex switch uses OpenAI's `codex-plugin-cc` transfer (`externalAgentConfig/import` under the hood) |
| `global project store/config.json` | Per-agent launch flags for this project. Written by `--cb-save-args`, summarized in `bridge status`, and cleared with `--cb-clear-args`. |
| `.cbctx` artifact | Explicit portable context only: redacted selected context, structured fields, audit and integrity hash. Never a native session export. |

Full design details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · contributing: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Privacy and security

- Ordinary handoffs and storage are local; Bridge has no required hosted service or telemetry. Explicit `share` commands contact your chosen endpoint. Agents contact their own providers, and live verification runs agent calls.
- No API keys are read, requested, or stored. Auth detection checks *existence* only (e.g. Keychain entry name, `codex login status`) and never touches secret values.
- Runtime state holds references, timestamps and bounded delta files outside the project tree. No `.gitignore` entry is needed, and Git is not required.
- Delivered context becomes input to the receiving agent and may be sent to its configured provider. Artifact export and sharing are separate, explicit operations.

## Compatibility

Vendor session formats can change independently of Bridge. Run `bridge doctor` to check local installation and format compatibility, then `bridge verify` for live responses. Neither is a substitute for a native handoff test. See [platform acceptance](docs/DEVELOPMENT.md#release-checklist) and [adapter-specific requirements](docs/ADAPTERS.md) for test boundaries; a historical successful version is not a guarantee for later vendor releases.

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

- macOS and selected Linux arm64 scenarios are verified. Linux evidence includes
  clean installed-package acceptance on Alpine/Node 18.18, plus native OpenCode
  1.18.31 database snapshot, handoff preparation and closing checks on Node 24.
  This is not acceptance of every Linux agent/provider/terminal combination.
  Windows installed-package, kernel-lock and selected native Pi/Aider transport,
  migration and sharing scenarios have passed CI. Aider uses a fixture provider
  there; this is not authenticated Aider acceptance or validation of every
  built-in agent's Windows workflow. See the development guide for boundaries.
- One linked session per agent per lane. `bridge unlink <agent>` forgets just that agent, and every watermark that named it, so the next switch links it fresh — no more deleting the machine-local bridge store to relink everything at once. It is for a session you are done with, and refuses while a bridge launcher is running, so a live session's next hook cannot re-link the agent you just forgot.
- Ordinary lanes isolate context but share a checkout; concurrent edits can
  collide. Explicit worktree lanes provide separate working directories through
  `bridge lane new --worktree` (see below); this is not a process sandbox.
- `bridge lane rm` refuses while any bridge launcher is running on the lane. Launcher records carry their lane, so unrelated lanes can remain active while the selected lane is removed.
- Only Claude → Codex has an official first-switch import; other first switches seed a new session with bounded context and a retained full-context pointer, using the target adapter's delivery mechanism.
- Codex runs hooks only after you review them once with `/hooks`, and that trust is not readable from outside. Until then a handoff falls back to the prompt path, and when a delta was routed to a hook that never fired the launcher says so and names the file it is still sitting in.
- Grok cannot receive a delta through a hook at all: its hooks fire but their output is ignored for passive events, so Grok stays on prompt delivery.
- OpenCode receives its context but does not open the turn for you. It exposes no hook and its interactive TUI cannot be handed a starting message, so the delta is written straight into its session database and you type once to begin. Every route through it was tried live (a prompt flag that only fills the input box, a run mode that is not the clean TUI, and driving its own HTTP server, which the free model would answer without acting on); the honest landing is that the context arrives and the turn is yours. The other four agents start on their own.
- Bridge-managed OpenCode sessions set `OPENCODE_DISABLE_AUTOUPDATE=true` in the child environment. In OpenCode 1.18.31 on Linux, the startup updater's package-manager probe survived TUI cancellation. Update OpenCode outside a managed session. This does not modify global OpenCode configuration or independent launches, and is not a guarantee that arbitrary agent-spawned jobs terminate with their parent.
- An agent's own dialogs (folder trust, update prompts) can appear before a resumed session; answer them once and the flow continues.
- A launcher left running across a bridge upgrade cannot read the newer state file. It says so and asks to be restarted; the pending handoff is preserved.
- Upgrading the state file is one way. An older bridge refuses a newer one rather than guessing at it, so downgrading means restoring the backup the migration keeps beside it (`state.json.v<n>.backup`). The upgrade says both of these once, when it happens.
- The summary is written by the departing agent, so its quality depends on that agent following its handoff instructions. When one is missing, from a crash or a recovery, the delta says so and falls back to the deterministic Conversation and Work sections rather than presenting an extract as a reading.
- If you run `claude`/`codex` outside the `bridge` launcher, handoffs still record state, but the actual switch is manual (the handoff message tells you exactly what to run).
- Codex stores its sessions by date rather than by project, so the discovery check for it is measured across the machine rather than for one project.
- **This is an early developer preview — not production-ready.**

## Roadmap

- Flags given at handoff time, so a switch can arm the agent it is switching to (per-project defaults and `--cb-save-args` work today)
- Broader Linux and Windows native-agent/provider coverage beyond the selected acceptance scenarios
- Optional MCP quick-question mode (ask the other agent without switching)

### Isolated worktree lanes

Normal lanes need no Git. For explicit code isolation in a Git repository:

```sh
bridge lane new experiment --worktree ../project-experiment
bridge claude --resume experiment
```

The worktree starts from committed `HEAD`; uncommitted source edits are not
copied. `--base <ref>` and `--branch <new-branch>` are optional. The destination
must not exist and must be outside the source project; its parent must exist.
Git is required for creation/attachment, not ordinary lanes or later launches.

Each worktree has its own central project identity, native sessions and state.
The source lane is an explicit launch link, not a second owner of those sessions.
`status --json` follows that link for pending/delivery diagnostics without changing
lanes. Run handoff and context-management commands from the worktree itself.
Seeding from a linked worktree lane is likewise done inside that worktree.
Seed fields are read from the checkpoint's validated section index, not Markdown
headings inside a conversation. If an older checkpoint has no index, create a
new handoff on the source lane before seeding. An invalid index refuses seeding
before a new lane is created; the original evidence remains untouched.
If seed creation fails, automatic rollback removes only a still-empty lane
record with no live launcher. Existing files are retained for inspection, not
recursively deleted. A changed lane or failed state write is reported as an
incomplete rollback; inspect `bridge lane` and `bridge status` before retrying.
If the lane record survived an interrupted creation, use
`bridge lane seed <existing-lane> --seed <source-lane>` after inspection. This
builds a fresh briefing from the source's current evidence, not a replay of the
original snapshot. It does not switch lanes or roll back the existing target on
failure. Pending deliveries, linked sessions, live launchers and worktree links
refuse this operation. Unchanged orphan files from a dead seed writer are
recovered through its hash-checked preparation journal; changed files are
preserved and block recovery.
Explicit `lane rm --yes` rechecks the live-launcher guard under the state lock
and keeps that lock until checkpoint deletion finishes, excluding concurrent
lane recreation. If files cannot be removed safely, it reports their retention.

If creation succeeds but later state setup fails, the bridge preserves the code
and branch. Reconnect with `bridge lane attach experiment --worktree ../project-experiment`;
attachment validates Git ownership and does not choose or overwrite an unrelated
existing lane. Missing/replaced directories fail closed on launch. To relocate a
link, remove the source lane link first and attach the moved worktree explicitly.
`bridge lane rm` removes the source link and its local checkpoints only; it never
deletes the worktree's code, branch or independent bridge state. Remove an unwanted
working tree separately with Git after checking its changes. No automatic merge,
branch deletion, cross-process crash transaction or sandbox is implied.

### Adapter extensions

Trusted local adapters can use `@serdardb/context-bridge/adapter-sdk` and
default-export `defineAdapter(implementation)`. Enable them explicitly with
`CONTEXT_BRIDGE_ADAPTERS=/absolute/path/to/plugins.json`; the manifest contains
`{"apiVersion":1,"modules":["/absolute/path/to/adapter.mjs"]}`.
`bridge adapters --json` lists built-in and configured adapters without probing
vendors. Plugin code runs with your account's privileges, not in a sandbox;
review it first. No project-local or remote code is discovered automatically.
See [Adapter Contract](docs/ADAPTERS.md) for API requirements, delivery limits,
compatibility rules and real-agent acceptance checks.

### Pending delivery diagnostics

`bridge status --json` includes a `delivery` object for a pending injection, or
`null` when none is recorded. It reports the selected route, its byte budget,
checkpoint state (`pending`, `consumed`, `missing`, `unsafe`, or `unreadable`),
and whether a regular full-context file is available. `deltaBytes` measures the
stored text; `deliveredBytes` predicts the current delivery formatter's output,
including its file pointer. `wouldTrim` reports whether that formatter would
trim it. Unknown routes leave delivery size and budget unset.

These are read-only local diagnostics, not proof that an agent read or understood
the context. The output does not include conversation text or checkpoint paths.
The `lanes` array contains the same diagnostics, linked agent names, pending work
and up to five retained switch records for every lane, in name order. Top-level
fields still describe the active lane. Inspection does not switch lanes or run
agent probes. Local integrations can use `projectStatus(projectDir)` from
`src/status.mjs`, the same read-only function used by the CLI; this internal API
is not yet a versioned adapter SDK.

### Status event stream

`bridge watch --policy read-only` emits newline-delimited JSON status events.
It requires this explicit policy and never starts agents, repairs state or
acknowledges delivery. `--project /absolute/path` pins a different project at
startup; `--interval 1000` controls polling in milliseconds (100 to 60000).
No Git installation is required. SIGINT/SIGTERM stop the foreground process.

The first event is `snapshot`; changed observations emit `change`. Read failures
emit `unavailable` once, followed by `recovered` when the original directory can
be read again. A replacement directory is not silently adopted. Events carry
metadata only, using the same privacy boundary as `status --json`.

Polling avoids relying on platform filesystem notifications and tolerates
atomic file replacement. It can miss intermediate transitions between polls:
this is not a durable journal, delivery receipt, or exactly-once subscription.
Slow consumers apply backpressure rather than building an unbounded event queue.
Restarting produces a fresh snapshot; there is no background daemon or cursor.

### Read-only MCP

Starting with 0.13.0, MCP is a separately installed companion. Install both
packages in the same npm prefix:

```bash
npm install -g @serdardb/context-bridge @serdardb/context-bridge-mcp
```

Run `bridge mcp --project /absolute/project/path` from an MCP host using stdio.
The project is fixed at startup; tools cannot choose another directory. By
default only `bridge_status` and `bridge_adapters` are exposed. Neither starts
agents, acknowledges delivery, nor initializes a missing project. No network
listener is opened and Git is not required.

Add `--allow-content` explicitly to expose `bridge_search`. This lets the host
and its model read potentially private checkpoint snippets. It returns at most
100 matching records (20 by default), with omitted-result counts; snippets are
not complete transcripts. The limit bounds output, not the underlying local
scan. Search stays within the selected project's store; status can report
explicitly linked worktree lanes. There is no general file-reading tool.

Example host configuration (adjust executable and project paths):

```json
{
  "mcpServers": {
    "context-bridge": {
      "command": "/absolute/path/to/bridge",
      "args": ["mcp", "--project", "/absolute/path/to/project"]
    }
  }
}
```

Local evidence is untrusted data, not instructions. Read-only tool annotations
do not sandbox installed adapter plugins: `CONTEXT_BRIDGE_ADAPTERS`, when set,
still loads trusted executable code at startup. Unset it for built-ins only.
The companion uses the official MCP SDK, Zod and a Node18-compatible Hono pin;
none are core runtime dependencies. Automatic discovery supports npm sibling
installations. For isolated layouts (pnpm/Yarn PnP), set the MCP host environment
`CONTEXT_BRIDGE_MCP_MODULE` to the trusted absolute companion `index.mjs` path,
with that package's dependencies/loader available. Bridge does not search CWD
or install code automatically. Missing, unloadable and incompatible companions
produce distinct errors. Full pnpm/PnP setup is not claimed verified.

The companion is trusted Node code, not a sandbox. Core withholds the search
callback without content opt-in, but cannot prevent arbitrary installed code
from reading files itself. MCP acceptance is not native-agent acceptance or a
concurrent filesystem snapshot.

## Development status

This checkout prepares the 0.13.0 developer preview. Five built-in agents are
supported; Aider and Pi remain opt-in experimental adapters. Authenticated Aider
acceptance is not complete. No all-provider or all-platform guarantee is made.

Core has one direct runtime dependency, Koffi, for native locking, publication
and supported filesystem identity operations. A missing native backend blocks
operations requiring it; diagnostic and eligible read-only paths remain
available. The optional MCP companion owns its SDK, Zod and Hono compatibility
dependencies. Neither package is dependency-free.

Automated coverage includes source tests, clean installed-package acceptance
and selected native integration scenarios. A configured CI matrix is not a
passed release gate. Publication requires fresh evidence for the exact commit
and both tarballs, plus review of native handoff acceptance.

See [CHANGELOG.md](CHANGELOG.md) for changes by release,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design, and
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for acceptance and release procedures.

## Written about

The thinking behind this tool, and what broke along the way:

- [Building context-bridge with context-bridge](https://dogrubakar.com/blog/building-context-bridge-with-context-bridge) — five agents reviewing the tool they were being carried by
- [The day an agent ran clean in the wrong directory](https://dogrubakar.com/blog/clean-in-the-wrong-directory) — a clean run, every guard held, and it was true about somewhere else
- [The first switch into OpenCode](https://dogrubakar.com/blog/context-bridge-0-12-1) and [The wrong OpenCode session](https://dogrubakar.com/blog/context-bridge-0-12-2) — reaching an agent that keeps its sessions in a database
- [The next learning layer for AI agents may not be the model](https://dogrubakar.com/blog/the-next-learning-layer) — where an agent's experience actually accumulates

More at [dogrubakar.com](https://dogrubakar.com).

MIT © SerdarDB
