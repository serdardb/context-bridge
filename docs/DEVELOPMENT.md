# Developing context-bridge

Contributor guide. For the design itself, read [ARCHITECTURE.md](./ARCHITECTURE.md) first.

## Local setup

```bash
git clone https://github.com/SerdarDB/context-bridge.git
cd context-bridge
npm install -g .     # installs the `bridge` binary (a copy)
# or, to have edits take effect immediately during development:
npm link
```

Requirements: Node ≥ 18.18, git, and at least two of Claude Code, Codex CLI (`codex login`), Grok CLI (`grok auth`), Antigravity and OpenCode, logged in. macOS is the verified platform.

> `bridge` must be on `PATH`: the Claude plugin hooks and the Codex skill invoke it by name. `bridge doctor` checks this.

## Repository structure

```
bin/bridge.mjs        CLI entry point
src/
  cli.mjs             command dispatch (bridge | claude | codex | grok | doctor | verify | status | clean | handoff | internal-hook)
  agents/             one adapter per agent; the only place vendor knowledge lives
    index.mjs         the validated built-in adapter registry
    claude.mjs codex.mjs grok.mjs antigravity.mjs opencode.mjs
  adapter-contract.mjs versioned structural contract and capability descriptors
  state.mjs           machine-local state.json — versioned, atomic writes, forward migrations
  config.mjs          machine-local config.json — per-agent launch flags
  launcher.mjs        flat child-process loop, session linking, idle-safe auto-switch
  handoff.mjs         `bridge handoff <agent>` for every direction
  delta.mjs           deterministic delta extraction (session files + git)
  delivery.mjs        which road a delta takes, and how a trim stays readable
  probe.mjs           the parser canary shared by every adapter
  clean.mjs           checkpoint retention: deltas are delivery artifacts
  transfer.mjs        wrapper around the official OpenAI transfer machinery
  discover.mjs        rollout/transcript lookup helpers
  doctor.mjs          environment checks + --fix bootstrap
  hooks.mjs           hook endpoints for Claude and Codex (stdin JSON)
plugin/               Claude Code plugin (skill /bridge + hooks.json)
codex/SKILL.md        shared $bridge skill for Codex, Grok, Antigravity and OpenCode (~/.agents/skills/bridge)
.claude-plugin/       marketplace manifest — the repo doubles as a Claude plugin marketplace
docs/                 this documentation
```

The bridge uses Node ESM. Core's only runtime dependency is Koffi. The optional
`packages/mcp` companion owns the official MCP SDK and Zod.
`@hono/node-server` is pinned to the SDK-supported Node 18-compatible 1.x
line: the SDK also permits 2.x, whose Node 20 requirement would invalidate
our Node 18.18 installation contract. Verify clean tarball installation with
`--engine-strict` on the exact minimum Node version after dependency updates;
a passing checkout suite does not prove consumer dependency resolution.

Koffi supplies the native kernel-lock backend required for mutations. It is
loaded on demand; read-only commands remain available when it cannot load,
while diagnostics report the failure and mutations refuse safely. MCP is an
explicitly installed companion; its SDK, Zod and Hono pin no longer ship in
core-only production installs. They remain development dependencies for test
clients and source-checkout acceptance. The direct
Hono pin is intentional because npm overrides in a dependency do not govern
the consuming project's installation.

The companion receives versioned guarded read callbacks from core, not another
copy of core's storage implementation. Without content opt-in, no search
callback is provided. It is trusted code, not a sandbox. npm sibling resolution
is supported; isolated layouts can explicitly set `CONTEXT_BRIDGE_MCP_MODULE`
to a trusted absolute module path. Do not infer PnP support from npm tests.

`npm run test:package` packs both packages, verifies a clean core-only install
(including clean MCP refusal), then installs the companion tarball and verifies
real stdio metadata/content reads. Test clients resolve from that installed
companion, not checkout dependencies. Release receipt schema 2 binds both
ordered package hashes; schema 1 receipts cannot authorize publishing either.
Run publication only from the reviewed repository: the companion's
prepublish hook checks the same root receipt. Publishing one package does not
establish registry integrity for the other.

## Storage tests

`npm test` (also `npm run test:global`) runs the suite against the production global runtime
store. Its preload gives each worker an isolated `CONTEXT_BRIDGE_HOME` and
removes the legacy storage override; CLI children inherit that worker's store.
It never uses the developer's real runtime home.

`CONTEXT_BRIDGE_STORAGE=project` is an internal legacy-fixture/migration
compatibility switch, not a supported alternative runtime-store preference.
Do not set it in normal CLI, hook or launcher environments: it bypasses the
global-store migration path. Migration tests use it briefly to construct old
input, then remove it before exercising production behavior.

There is no suite-wide legacy storage pin. CI uses the same `npm test` command.
Legacy migration cases deliberately create project-local input, then verify
the production migration and its retained evidence. Passing this suite does
not replace real-agent, platform or release acceptance.

Run `node test/integration/migration-io.mjs` for the opt-in migration I/O fault
matrix. It enumerates managed mkdir/open/write calls in a real pending-handoff
migration, injects ENOSPC at each point in an isolated child with Git absent,
then checks original-state survival, exact state/context after retry, user-file
preservation and an idempotent second retry. It does not run in `npm test` and
does not prove power-loss durability, arbitrary partial writes or all concurrent
writer schedules. The core suite separately covers process-exit boundaries.

Run `node test/integration/sealed-crash.mjs` for the optional encrypted-artifact
interruption matrix. Independent child processes exit after every observed
write, flush and exclusive publication call in seal/open. A visible bundle must
contain both ciphertext and its matching key; opening must return exact original
artifact bytes. Retrying never replaces an existing key or output. Interrupted
staging stays private and only the fixture's temporary root is removed. This
uses no provider or Git and runs outside `npm test`. It proves process-exit
behavior, not physical power loss, partial syscalls or hostile parent swaps.

Run `node test/integration/remote-tls.mjs` for real HTTPS sharing acceptance.
It generates a one-day synthetic certificate using the local `openssl` tool,
starts an isolated loopback TLS proxy and opaque store, then runs the real CLI
with and without explicit certificate trust. It checks exact ciphertext
roundtrip, chunked response limits, token-free error output and both actual
30-second client/upload deadlines. Allow about 35 seconds; the normal suite
does not include this wait. Neither system trust nor user credentials change.
For a container without OpenSSL, an optional absolute fixture directory argument
may supply synthetic `cert.pem` and `key.pem` (SAN IP 127.0.0.1). Never use real
service keys. This is local TLS behavior, not public deployment or load testing.

Run `node test/integration/remote-store.mjs` for cross-process sharing quota and
server interruption acceptance. Two real servers share one private store; a
barrier before temporary-file creation forces observable kernel contention.
Only one of two objects fits the quota. Separate workers then exit at four
write/flush/publication boundaries; restart must never serve a partial object
or renew an already-published object's expiry. This uses synthetic local data,
and also roundtrips an exact 24MiB envelope with maximum-size synthetic
ciphertext. Both declared-length and chunked uploads one byte over the wire
limit must return413 without leaving an object or staging file. Shape validation
in the opaque store is not cryptographic authentication of that synthetic data.
The harness uses
no provider or Git, and runs outside `npm test`. It does not establish distributed
quota, physical power-loss durability or protection against hostile parent swaps.

New fixtures should register their project before creating checkpoint files,
use `checkpointsDir` / `safeCheckpointPath` for physical storage, and retain
logical checkpoint references in state. Explicit migration and hostile legacy
directory fixtures should keep their deliberate project-local paths.

## Running from source

```bash
node bin/bridge.mjs --help
node bin/bridge.mjs doctor
node bin/bridge.mjs verify
node bin/bridge.mjs status --json
```

For opt-in operational diagnostics, set `BRIDGE_DEBUG=1`. Debug records go to
stderr and redact prompts, message content, tokens, transcript paths and home
directories before writing; the default is silent.

or via the linked global `bridge`.

## Installing the Claude plugin locally

The repository root is itself a Claude plugin marketplace:

```bash
claude plugin marketplace add /absolute/path/to/context-bridge
claude plugin install bridge@context-bridge
```

After changing plugin files, bump `plugin/.claude-plugin/plugin.json`'s `version`, then:

```bash
claude plugin marketplace update context-bridge
claude plugin update bridge@context-bridge
```

New sessions pick up the update (or use `/reload-plugins` inside a session).

Notes that matter:

- The `/bridge` entry ships as a plugin **skill** whose name equals the plugin name — that is what makes it resolve as plain `/bridge`; plugin *commands* are always namespaced (`/plugin:command`).
- Hooks are declared in `plugin/hooks/hooks.json` and call `bridge internal-hook <event>`; they silently no-op in projects without machine-local bridge state.

## Installing/testing the Codex skill locally

```bash
bridge doctor --fix        # offers to install it, plus an optional allow-rule
# or manually:
mkdir -p ~/.agents/skills/bridge && cp codex/SKILL.md ~/.agents/skills/bridge/
```

Invoke inside Codex or Grok by typing `$bridge <agent>`. The optional allow-rule (`~/.codex/rules/bridge.rules`) lets Codex run `bridge handoff` without a per-run approval prompt; its format is a single line — Codex rules files do not accept `//` comments:

```
prefix_rule(pattern=["bridge"], decision="allow")
```

## How bridge doctor works

`src/doctor.mjs` collects a result object and renders it. Agent health rows and
directed routes come from the adapter registry; the Bridge section also checks
the shared runtime.

Both `doctor` and `verify` report `bridge.locking` with `ok`, `platform`, `arch`
and a diagnostic. The native lock probe acquires, releases and reacquires a
private temporary file in a child process with a five-second deadline. Failure
makes either command exit non-zero, even when agents and routes are configured.
Live model probes are skipped when native locking fails. This tests the local
native backend, not the safety of arbitrary network filesystems or mixed
old/new writers; cross-process exclusion has separate regression tests.

Koffi is loaded only when locking is needed. A missing or incompatible backend
refuses mutation with a clean diagnostic rather than falling back to PID-only
locking. Reinstall with optional dependencies enabled for the target platform,
then rerun `bridge doctor --json`. Read-only inspection such as `status --json`
and `storage plan --json` does not need the native backend. Native error numbers
are preserved in diagnostics; internal require stacks are not printed.

Mutation lock retries default to 30 seconds. Set
`CONTEXT_BRIDGE_LOCK_TIMEOUT_MS` to a positive integer number of milliseconds
to change that budget. Nested kernel/PID acquisitions share the remaining
budget. On timeout, the owner is not killed and its lock is not deleted; wait
for it to finish and retry. Do not manually remove a live owner's lock or a
permanent `.guard` file. Critical-section work and blocking filesystem calls
are not covered by this retry budget.

`bridge verify` is the strict release and automation gate. It runs a real smoke
question against every installed supported agent, checks that each agent's
session and discovery readers are healthy, and verifies every directed route
between the installed agents. Use `--json` for automation; it exits non-zero
when any check fails.

`bridge status --json` is the stable machine-readable status view. It reports
the active lane, linked agent identifiers, pending work kind and recent switch
directions without exposing vendor watermarks, session identifiers or full
filesystem paths.

`bridge handoff <agent> --dry-run` is read-only. It calculates the route and
payload from current state, session and git data, but never creates checkpoints,
changes pending state, prunes files or invokes a vendor import. It is intended
for release checks and scripts that need to inspect a handoff before committing
to it.

Read the wording as load-bearing. A route says `CONFIGURED`, meaning installed, configured, and its session still parses; it used to say `READY`, which people reasonably read as proof that a switch would work. `--deep` asks each agent a real one-line question and reports `LIVE` or `BROKEN`. Two canaries run by default and cost about 98ms: one checks that each adapter can still read its linked session, the other that its discovery reader can still name what is stored on disk. An unreadable session takes its routes off green and the exit code with it.

`--json` prints the raw object; `--fix` offers confirmed bootstraps using official mechanisms only. Auth checks are existence-only (Keychain entry name, `codex login status` exit code) and never read or print secret values. Keep it that way.

### Doctor output example

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

## CLI exit codes

The command-line contract is intentionally small and stable:

- `0`: the requested operation completed, or a read-only check found no issue.
- `1`: the operation failed, the requested integration is unavailable, or a
  diagnostic check found a problem.
- `2`: the operation needs explicit user confirmation before it can continue;
  today this is the heuristic session adoption path. The command prints the
  exact confirmation and retry form.

Expected operational failures are printed as one actionable line without a
stack trace. Unexpected programming failures retain the stack trace so they
remain diagnosable during development.

## Linux Acceptance

These commands use the working tree and its existing JavaScript dependencies
read-only. No user home, agent credentials or Docker socket is mounted. The
image build downloads test tools; the test runs themselves have no network
access beyond their isolated loopback interface.

Git-absent storage, migration and portable-artifact acceptance:

```sh
docker run --rm --init --network none -v "$PWD:/workspace:ro" -w /workspace \
  node:24-alpine node test/integration/linux-core.mjs
```

The runner asserts that Git is actually missing and its temporary filesystem is
case-sensitive. It explicitly excludes Git-repository fixtures, not failed
product checks. This is a selected integration matrix, not the full suite.

For the full suite, build the test-only image with Git, SQLite, Bash, Python
and Expect:

```sh
docker build --iidfile /tmp/bridge-linux-image.id \
  -f test/integration/Dockerfile.linux test/integration
docker run --rm --init --network none -v "$PWD:/workspace:ro" -w /workspace \
  "$(cat /tmp/bridge-linux-image.id)" npm test
docker run --rm --init --network none -v "$PWD:/workspace:ro" -w /workspace \
  "$(cat /tmp/bridge-linux-image.id)" node test/integration/aider-parent.mjs /usr/bin/python3
docker run --rm --init --network none -v "$PWD:/workspace:ro" -w /workspace \
  "$(cat /tmp/bridge-linux-image.id)" node test/integration/aider-lock.mjs /usr/bin/python3
```

Use `--build-arg NODE_IMAGE=node@sha256:<digest>` to pin a particular base image
and record that digest with the results. `--init` is significant: Node as PID 1
does not reap orphaned grandchildren. Without it, the fallback-server cleanup
test detects a remaining Linux `Z (zombie)` process even after termination.
The test continues to reject that state rather than treating it as cleanup.

The Python commands verify OS lock and parent-death primitives without Aider
installed. Passing them does not prove Linux vendor transcript layouts, a
supported Aider Python/SDK installation, authenticated agents, or Windows
support. Native-agent acceptance remains a separate requirement.

For Pi native acceptance, install the pinned vendor into a separate temporary
directory using Linux rather than reusing macOS native dependencies. For example,
after building the test image above:

```sh
PI_NATIVE=$(mktemp -d)
docker run --rm --init -v "$PI_NATIVE:/native" node:24-alpine \
  npm install --prefix /native --ignore-scripts --no-audit --no-fund \
  @earendil-works/pi-coding-agent@0.85.1
docker run --rm --init --network none -v "$PWD:/workspace:ro" \
  -v "$PI_NATIVE:/native:ro" -w /workspace \
  "$(cat /tmp/bridge-linux-image.id)" node test/integration/pi-native.mjs \
  /native/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --migrate
```

Only installation accesses the registry. The exercise uses a deterministic
loopback provider, actual Pi TUI and bridge processes, and a synthetic Codex
source. It checks pending migration, unchanged native session identity and
byte-identical consumed context, without accessing account credentials. Keep
the installation's lockfile and image digest with acceptance evidence; this
does not constitute authenticated-model or cross-device-resume validation.

Aider requires a separate image: the core Alpine image's Python is outside the
candidate's supported Python 3.10-3.12 range. The following image installs SDK
0.86.2 in a private Python 3.12 venv and validates dependency consistency:

```sh
docker build --iidfile /tmp/bridge-linux-aider-image.id \
  -f test/integration/Dockerfile.aider-linux test/integration
docker run --rm --init --network none -v "$PWD:/workspace:ro" -w /workspace \
  "$(cat /tmp/bridge-linux-aider-image.id)"
```

Build arguments `NODE_IMAGE` and `PYTHON_IMAGE` accept immutable image digests.
Record those digests and `/opt/aider/bin/python -m pip freeze` with the result;
pinning the top-level SDK is not a complete dependency lock. No host home or
account is mounted. This runs actual Aider with a local provider, including
refusal/partial delivery, native edits, user-confirmed outbound handoff,
terminal interruption and resume after killing only the wrapper. The handoff
target is a fixture executable, not authenticated Codex. Cleanup timing starts
when the signal is sent; a separate timeout bounds the complete invocation.

## Testing a handoff end-to-end

### Installed Package Acceptance

Source-tree tests can accidentally depend on files or development dependencies
that are absent from npm. Exercise the actual tarball in a clean installation:

`npm run test:package` automates pack, a fresh production-only engine-strict
install, and installed-package acceptance, cleaning its temporary directory
afterwards. It needs registry access and does not run as part of `npm test`.
CI runs it separately without installing checkout dependencies, on the exact
Node 18.18.0 minimum and Node 24 on both Linux and macOS. Workflow configuration
is not evidence that these jobs passed; the exact commit must have green runs.
For a network-isolated runtime check, use the container sequence below:

```sh
PACK_DIR=$(mktemp -d)
TARBALL=$(npm pack --silent --pack-destination "$PACK_DIR")
docker run --rm --init -v "$PACK_DIR:/package" node:18.18.0-alpine \
  npm install --prefix /package/install --ignore-scripts --omit=dev \
  --engine-strict --no-audit --no-fund "/package/$TARBALL"
docker run --rm --init --network none -v "$PACK_DIR/install:/installed:ro" \
  -v "$PWD/test/integration/installed-package.mjs:/acceptance.mjs:ro" \
  node:18.18.0-alpine node /acceptance.mjs \
  /installed/node_modules/@serdardb/context-bridge
```

Use the exact minimum version above, not a floating `18` tag. Repeat with a
current supported Node image and a fresh installation prefix. The
runtime container mounts only the installation and standalone acceptance runner,
not the checkout or its node_modules. The runner imports all product code and
MCP client dependencies from that installation. It checks read-only CLI commands,
global runtime without Git, artifact export/import preservation, packaged Python
helpers, private/test-file exclusion and a real MCP stdio connection. Provider
accounts, installed coding agents, every CLI command and the full release gate
remain outside this test. `--ignore-scripts` is for this installation only; never
use it to bypass publish checks. A tarball produced from a working tree is a
local candidate, not evidence that its unchanged version has been published.

Use a throwaway directory; Git is optional:

```bash
mkdir /tmp/bridge-demo
cd /tmp/bridge-demo
bridge doctor        # routes must be CONFIGURED
bridge               # starts Claude; the SessionStart hook records the session
```

1. Do some real work in Claude (create a file, state a decision).
2. Run `/bridge codex` → Claude should close itself and Codex should open with the context.
3. Do some work in Codex (modify a file, state a decision).
4. Run `$bridge claude` → Codex should close and the original Claude session should resume.
5. Ask Claude *"Where were we?"* — it should describe both its own prior work and Codex's, including decisions.
6. Run `/bridge codex` again — see the next section for what to verify.
7. Then `$bridge grok`, and ask Grok what Claude decided. A chain that only carried the previous hop would fail here, which is the whole point of `knownBy`.

Useful inspection points during all of this:

- `bridge status` — where you are, the recent switches, and what each agent is holding. Session ids and raw watermarks are not shown at all; `--debug` adds them.
- Machine-local `state.json` — the ground truth the launcher polls.
- Machine-local checkpoints — logical `.bridge/checkpoints/` delta files; delivered ones are renamed `*.consumed`.
- `bridge artifact export/import` handles explicit portable context; imported artifacts are verified before optional seed application.
- `bridge search <text>` searches checkpoint groups without reading or exposing the physical storage root.

## Verifying first-import vs repeat-resume

The single most important behavioral invariant:

- **First** `/bridge codex` for a project → exactly one new entry appears in Codex's import ledger (`~/.codex/external_agent_session_imports.json`) and `agents.codex.id` appears in machine-local state.
- **Every subsequent** `/bridge codex` → the ledger count for this project **must not change**, the id **must not change**, and the linked thread receives the delta. Where it arrives depends on the road: with Codex hooks installed and trusted the delta lands inside the conversation and the command line stays bare, otherwise it rides as the opening prompt. Ask Codex about something from its earlier turns to confirm the thread's own context survived.

If a change causes a second import, it has broken the product model (each import creates a disconnected new thread).

## Invariants

Treat these as hard rules; changes that violate them should not merge:

1. **Import once.** Never run the official Claude→Codex import for an already-linked pair.
2. **No visible IDs.** Session/thread IDs never appear in user-facing output (debug flags excepted).
3. **No process-name killing.** Never `pgrep`/name-match processes; the launcher may signal only the exact child PID it spawned.
4. **Never SIGKILL** an agent. `SIGTERM` only — both CLIs flush session files on it.
5. **No blind termination.** Auto-exit requires: persisted handoff + confirmed idle + debounce + final state re-read. Idle comes from the agent's own Stop hook where one exists, and from parsing its session file otherwise; both paths stay, because hooks do not run until they are trusted. If idle is uncertain, print guidance and do nothing.
6. **Exactly-once injection.** Pending deltas are consumed atomically (rename before emit); a missing delta file surfaces a warning rather than silence.
7. **One road per delta.** `pendingInjection.via` decides hook or prompt, and exactly one deliverer honours it. Never let both carry the same delta.
8. **No API keys.** Subscription CLIs only; auth detection is existence-only.
9. **No transcripts in bridge state.** References, timestamps, checkpoints and bounded deltas only.
10. **Nothing enumerates agents by hand.** Iterate the adapter registry. A retention rule that hard-coded one pair meant Grok's checkpoints were never pruned at all.
11. **Watermarks are opaque.** Persist what an adapter returns, hand it back untouched, never compare across agents.
12. **Never claim what is not observed.** A green tick, an "installed" that implies "works", a "delivered" that implies "read": each of those has already been wrong here once.

## Compatibility matrix

| Component | Verified | Notes |
|---|---|---|
| Claude Code | 2.1.x (2.1.216) | resume-append semantics, SessionStart `additionalContext`, plugin skills/hooks |
| Codex CLI | 0.144.x | `codex resume <id>` auto-submit, rollout format, `$skill` invocation, plugin transfer RPC, hooks with `additionalContext` (trusted once via `/hooks`) |
| Grok CLI | 0.2.x | resume by id, per-project session directories, live `active_sessions.json`; hooks fire but ignore stdout for passive events |
| OpenCode | 1.18.x | sessions in a SQLite database, authless delta insert via `preResume`, read-back via `opencode export`, discovery via `opencode session list --format json`; no hook and a resume that will not take an opening message, so no auto-start |
| OS | macOS, selected Linux and Windows acceptance | Installed-package Windows checks and selected native Pi/Aider transport, migration and sharing scenarios have passed CI. This does not validate every built-in vendor/provider workflow. |
| Node | ≥ 18.18 | clean package and MCP stdio must work at the minimum version |

Every CLI's session format is vendor-internal. When a new CLI release changes behavior, re-run the end-to-end handoff test above before assuming compatibility.

The installed-package CI matrix includes Windows at Node 18.18.0 and 24, alongside
macOS and Linux. It builds a tarball, installs it without lifecycle scripts or dev
dependencies, then exercises Git-absent CLI reads, artifact export/import, MCP
stdio, and the installed native lock backend. A separate owner process must
exclude a contender; forcefully terminating that owner must allow reacquisition
without replacing the guard file. No source-tree dependencies are borrowed.
Installed-package checks alone do not validate native vendor layouts or terminals.
Separate Windows jobs exercise actual Pi and Aider processes, including selected
terminal and migration paths, and sharing/publication interruption scenarios.
Aider model responses use a local fixture, not authenticated provider acceptance.
Neither layer establishes network-filesystem or physical power-loss durability.
The last pre-release implementation run was [CI 35405385709](https://github.com/SerdarDB/context-bridge/actions/runs/35405385709)
at `f9d7e3e793b518f3c98567607cc1d4f65ca57ec1`; the release candidate must pass its own exact-commit gate.

## Release checklist

1. Identify the previous release tag first: `git describe --tags --abbrev=0`.
2. Write the changelog only from the actual implementation diff: `git diff --stat <previous-tag>..HEAD -- src bin plugin codex packages docs package.json package-lock.json .github`. Do not turn a session summary, roadmap or cumulative feature list into the current release notes. Every entry must be attributable to a changed file or be explicitly marked as documentation/CI/release work.
3. On the final clean, committed candidate, run `node bin/bridge.mjs release-prepare` before starting npm authentication (`bridge release-prepare` is equivalent only when linked to that checkout). It runs the full tests, syntax, deterministic eval, clean installed-package acceptance, npm audit, `release-check --ci --json`, `verify --all --json`, and `eval --live codex --json`. Any failure stops preparation and leaves no success receipt. GitHub authentication, successful exact-HEAD CI and all supported agents are still required at this stage; live steps use configured providers and may incur usage. Preparation disables custom adapter manifests so they cannot substitute for supported-agent checks.
   The private receipt lives in the machine-local store's `release-evidence/` directory, outside the repository and tarball. It binds the exact commit and actual tarball SHA-256, package version, Node/npm versions, platform and architecture. The candidate is packed before and after the checks and must match. `prepublishOnly` now runs only `release-check --evidence --json`: it repacks locally and checks the receipt, without calling agents or GitHub. Missing/incomplete evidence, dirty state, different bytes/toolchain or evidence older than **24 hours from preparation start** refuses publication. This is an explicit freshness policy, not a guarantee that providers remain available. `prepack`, `prepare` and `postpack` lifecycle scripts are refused because they could rewrite bytes after verification; build before preparing acceptance.
   The receipt is trusted local evidence, not a cryptographic attestation against its owner. Keep the tree unchanged between acceptance and publish. Do not bypass the lifecycle with `--ignore-scripts`. This does not replace the native handoff exercise below: smoke checks verify responses and route configuration, not actual transfers. No command publishes or authorizes a release automatically.
4. `npm pack --dry-run` includes `bin/`, `src/`, `plugin/`, `codex/`, `.claude-plugin/`, `docs/`.
   Preserve the preparation toolchain through publication. In a measured Node
   18.18/npm9 versus Node24/npm11 comparison, identical source produced different
   gzip bytes while the decompressed tar was byte-identical, including headers.
   Matching extracted files does not authorize substituting a different `.tgz`:
   receipts bind the compressed artifact, not merely its source or file list.
5. Fresh-install path works from a clean checkout: `npm install -g .` → `bridge doctor` → `--fix` → routes CONFIGURED. Worth doing from a packed tarball into an isolated prefix at least once per release, since `REPO_ROOT` resolves differently under `node_modules`.
6. Full end-to-end handoff test, including the repeat-switch ledger check and one three-agent chain.
7. Hygiene scan: no machine-specific paths, no credentials, and no tracked runtime state.
8. Coordinate the core and MCP companion versions in `package.json` and `packages/mcp/package.json`, and refresh the lockfile. Keep the core version in sync with `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. The CLI reads its version from `package.json`; it is not another source. Prepare and publish both packages from the same accepted commit and toolchain.
9. Update README and docs if user-visible behaviour changed. The published package is `@serdardb/context-bridge`, because the plain name belongs to an unrelated library; publishing needs `--access public`.
10. Publish the accepted MCP companion first, verify its version is available in
    the npm registry, then publish core with the same toolchain and unchanged
    checkout. npm does not publish these two packages atomically. Core's README
    links to the companion's npm documentation, so publishing core first would
    expose an unavailable installation target. If either publication fails,
    inspect registry state before retrying; do not assume both succeeded.

### Changelog Attribution

Before the release commit, prepare `docs/release-evidence.json` for the newest
changelog section. Its `version` matches that section, `baseTag` is `v` followed
by the second changelog version, and `baseCommit` is that tag's resolved commit.
The previous tag must be an ancestor of HEAD and contain the corresponding
package version. A tag already on HEAD does not change the comparison base.

Each `entries` item contains `sha256`, `files` and `rationale`. Obtain the entry
hashes from the actual notes, not a session summary:

```sh
node --input-type=module -e 'import fs from "node:fs"; import { changelogEvidenceEntries } from "./src/release-provenance.mjs"; console.log(JSON.stringify(changelogEvidenceEntries(fs.readFileSync("CHANGELOG.md", "utf8")), null, 2));'
```

The format is a list of top-level Markdown bullets with indented continuations;
section headings and blank lines are allowed. Unaccounted prose fails closed.
Every current entry needs exactly one evidence record. List actual paths from
`git diff --name-only <baseTag>..HEAD`; unchanged historical implementation files,
the changelog itself and the evidence manifest are not supporting evidence.
Explain how each file supports the claim in `rationale`. Commit the evidence
with the release changes so clean-tree and exact-HEAD CI checks cover it.

This proves traceability, not semantic truth: a reviewer must still read the
diff and verify that the cited changes really implement the stated feature or
fix. Rewording an entry invalidates its prior attribution. Do not fabricate
evidence for an unfinished release just to make the gate green.
