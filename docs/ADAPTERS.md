# Adapter Contract

The adapter API is version 1, defined in `src/adapter-contract.mjs` and exported
as `@serdardb/context-bridge/adapter-sdk`.
The built-in registry validates every adapter at module load. Validation checks
structure, not vendor correctness, authentication or safety of executable code.
It does not call discovery, health probes or any other adapter operation.

## Registration

An adapter exports an `id` containing lowercase ASCII letters, a nonempty
`displayName`, and an `injection` mode (`prompt` or `hook`). IDs deliberately
match the existing checkpoint filename grammar. Hyphens and path characters
are not supported IDs in this version.

`createAdapterRegistry(adapters, apiVersion)` rejects unsupported API versions,
duplicate IDs and invalid adapters. Its immutable, prototype-free lookup table
preserves registration order. Module implementations themselves remain trusted
code; this is not a sandbox. Installing an external package does not automatically
register it with the bridge.

## Explicit Local Plugins

Export a module using the SDK's versioned envelope:

```js
import { defineAdapter } from "@serdardb/context-bridge/adapter-sdk";
export default defineAdapter(adapterImplementation);
```

The implementation must supply the operations and evidence declarations below.
Create a user-managed JSON manifest with `apiVersion: 1` and `modules`, an array
of absolute local `.mjs` or `.js` paths. Set `CONTEXT_BRIDGE_ADAPTERS` to the
absolute manifest path before starting the bridge. `bridge adapters --json`
lists the loaded adapters and their record/operation descriptors without running
health checks or initializing project state.

This environment setting is explicit authorization to execute those modules
with the bridge process's privileges, on every CLI invocation inheriting it.
Review the code first. Project directories, remote URLs and installed packages
are never searched automatically. No code is downloaded. A module's top-level
code runs before its exported contract can be checked; validation cannot undo
its effects or stop a trusted plugin that hangs. Load only trusted local code.

Manifest versions and module availability are checked before any plugin import.
Duplicate module paths, duplicate agent IDs, built-in overrides and CLI-command
name collisions fail closed. A bad plugin prevents that invocation from running;
unset `CONTEXT_BRIDGE_ADAPTERS` to recover. No silent compatibility downgrade is
performed. Removing a plugin does not erase its saved native session data.
Plugin modules must import the SDK, not the built-in registry (which is awaiting
their initialization). The selected manifest must remain available to hooks and
launcher children; it is not exported inside portable context artifacts.

Registered plugins participate in normal agent commands, handoff composition,
state lanes and diagnostics. Prompt delivery requires no core changes. Hook
delivery additionally needs vendor-specific hook installation and trust; declaring
`injection: "hook"` does not install or verify those hooks.

## Packaged Experimental Candidates

Aider and Pi ship as opt-in candidates, not built-in supported agents. Their
namespace modules under `src/agents/` are internal implementations; do not put
those files directly in a plugin manifest. Use the SDK-envelope entry points:

```json
{
  "apiVersion": 1,
  "modules": [
    "/absolute/path/to/context-bridge/src/experimental/aider.mjs",
    "/absolute/path/to/context-bridge/src/experimental/pi.mjs"
  ]
}
```

Set `CONTEXT_BRIDGE_ADAPTERS` to that manifest's absolute path, then run
`bridge adapters --json`. Include only the candidates you intend to enable.
For a local package installation, resolve the paths with
`require.resolve('@serdardb/context-bridge/experimental/aider')` and
`require.resolve('@serdardb/context-bridge/experimental/pi')`. Global installs
live under the package directory reported by `npm root -g`.

Loading the manifest does not install Aider, Python or Pi, run a model, enable
hooks, or prove vendor compatibility. The candidate-specific sections below
describe prerequisites, experiments and remaining acceptance limits. Unsetting
the manifest returns to the five built-ins without deleting native histories.
Release preparation deliberately ignores custom adapter manifests: experimental
candidates are not silently promoted to the supported-agent acceptance matrix.

## Operations

All adapters must implement the operations listed in `REQUIRED_OPERATIONS`:

- `discover(projectDir)` and `hydrate(projectDir, slot)` locate native sessions.
- `startCommand(extraArgs)` and `resumeCommand(ref, extraArgs)` return command
  specifications, not shell command strings.
- `currentMark(ref)` returns an opaque vendor watermark. Callers pass it back
  unchanged to `activitySince(ref, mark)` and `auditSince(ref, mark)`.
- `activitySince` returns normalized messages, patched files and completed turns.
  It may also return `deliveryObserved: boolean`: whether new evidence after the
  supplied watermark confirms receipt of the handoff. When supplied, this is
  authoritative for launcher acknowledgement; `false` preserves partial/failed
  transcript activity without consuming the pending handoff. Omission retains
  the existing new-message fallback. Do not return a cached session-wide `true`:
  the evidence must be newer than the supplied watermark. This confirms receipt,
  not successful edits or correctness of the answer.
- `idleAfter(ref, since)` reports whether the native agent has finished a turn.
- `health()` and `smokeCommand()` support installation and live diagnostics.
- `detectHost(env)` reports only a proven current host, not an ancestor inferred
  from an inherited session variable.
- `discoveryProbe`, `parseProbe`, `adoptStartedSession` and `observeAudit` support
  discovery diagnostics, parsing, safe linking and capability drift checks.

Prompt delivery requires `promptArgs(delta)`. Hook delivery requires
`kickoffArgs()`: injecting context alone need not start an agent turn.
Optional operations include native pre-resume preparation, native session
fabrication, lookup by ID and live recall evaluation. `evaluationUsage` requires
`evaluationCommand`; telemetry parsing without an evaluation command is invalid.

`conflictFlags` is an array of `{ flags, value, why }` rules. `value` is `none`,
`optional` or `required`. These rules prevent caller arguments from overriding
the session or project selected by the bridge.

## Evidence Versus Operations

`capabilities` describes what native records can yield. Every field in
`RECORD_FIELDS` is mandatory, including explicit absence; unknown fields or
values fail validation. `RECORD_VALUES` is the closed vocabulary. A missing
capability is not equivalent to a declared `false`.

`adapterDescriptor(adapter)` returns JSON-safe metadata with separate `record`
and `operations` sections. A live evaluation operation does not imply token
usage is available from native transcripts. Supporting a function does not
prove that the vendor installation can successfully run it.

## Runtime Results

The production registry wraps command, prompt/kickoff argument and activity
methods. Command specifications require a nonempty executable string and an
array of strings; embedded NUL bytes are rejected before launch. An argument
containing spaces remains one argument, not shell syntax. Activity must contain
normalized user/assistant messages, string file paths and a nonnegative integer
turn count. Opaque watermarks are passed through unchanged. These APIs are
synchronous; returning a Promise is invalid.

Discovery, hydration and lookup return either `null` (no session) or a reference
with a nonempty string ID and optional string transcript/event paths. Adoption
returns an array of such references; validation preserves all candidates and
does not resolve ambiguity by choosing one. Undefined and malformed identities
are errors, not absence.

Native `preResume` preparation returns `null` or a command specification with
optional string labels and a positive integer timeout. Zero, negative and
non-finite timeouts are invalid; omitting the timeout retains the launcher's
bounded default. `fabricateSession` returns `null` or a session ID together with
a valid preparation command. This validates the write plan, not its SQL semantics
or whether the selected session actually belongs to the project.

Malformed results raise `AdapterResultError`, naming the adapter and operation
without including private arguments or transcript contents. Handoff propagates
this error rather than treating it as an empty stream. Existing adapters may
still handle vendor read errors internally; validation cannot detect information
they have already discarded. Direct vendor-module imports also bypass wrappers.
Health, discovery/parse probes, audit and capability observations are also
shape-checked. Invalid audit readers are reported as `readerErrors` and rendered
as `INCOMPLETE`, rather than being mistaken for an empty successful audit.

## Acceptance Evidence

Before adding an adapter to production, provide native transcript fixtures,
parser and opaque-watermark tests, argument conflict tests, discovery/adoption
tests and real resume/handoff evidence. Capability declarations must agree with
those records. A passing structural validator cannot replace these checks.

API compatibility is exact-version negotiation for now: unsupported major
versions fail before registration. Runtime verification is structural, not a
complete JSON Schema or security boundary. Plugin-specific ownership, parser
fidelity and actual native execution still require the acceptance evidence above.

## Aider Transport Work

Aider is an opt-in candidate (`src/agents/aider.mjs`), not a built-in agent.
Load it through an explicit local SDK manifest. The transport uses the installed
Python SDK, not `--message` (which exits after one turn) or `--load` (which
interprets slash commands). Native Markdown remains raw evidence rather than
being presented as an unambiguous message protocol.
The driver records observed user input and response text with explicit roles
alongside completion evidence. Failed-turn response text is retained and labelled;
it does not acknowledge delivery. Native bytes not yet covered by an observation
remain a separate unclassified fragment, not invented user/assistant messages.

The runtime resolver requires `CONTEXT_BRIDGE_AIDER_PYTHON` to name an absolute
interpreter in a trusted environment containing `aider-chat==0.86.2` and Python
3.10-3.12. It never installs packages or guesses an interpreter from PATH.
The configured path is invoked unchanged: resolving a virtualenv's Python
symlink to its base executable can silently select the wrong environment.
Probe and driver use Python isolated mode (`-I`), excluding cwd, `PYTHONPATH`
and user site packages. This is not a sandbox: the selected interpreter and
its installed environment remain trusted executable code. Other SDK versions
need native lifecycle verification before the supported version is expanded.

Local deterministic-provider acceptance currently covers initial interaction,
follow-up, native restore, provider refusal and incomplete response evidence.
The session writer uses a permanent OS-locked file, not a stale PID marker.
Bridge-managed sessions live under the global project's `agents/aider/` store
with UUID identities, never a project-local `.bridge`. Creation publishes a
fully prepared directory by rename; discovery ignores unfinished staging
directories and validates project/session identity and recorded history.
Read-only discovery does not create a registry. Same-filesystem project moves
retain the existing project identity; Git is not required.
macOS and Linux process acceptance verify that a concurrent writer is refused and a
SIGKILL releases ownership without deleting/replacing the lock file. The lock
is advisory: it does not prevent an unrelated program from modifying history.
Windows locking has an implementation but still requires native verification.
The packaged `src/agents/aider_driver.py` now verifies identity and prior
history/evidence under that lock before opening the SDK. It records completion
only after an observed response finishes, fsyncs each evidence append, and
preserves failure/partial evidence without claiming delivery. The candidate
entry process (`aider-entry.mjs`) creates new sessions after spawn and records
its PID and launch time; new-session adoption requires both instead of selecting
the newest history. Resuming uses the linked identity and its Python environment.
The entry forwards SIGTERM and waits for the SDK process. Native acceptance
signals only the entry PID during a held-open model stream, verifies no
completion receipt, then resumes the same session to prove the writer lock was
released. A dedicated loopback connection also ties the SDK to its entry's
lifetime: a one-use random handshake identifies the connection, its descriptor
is non-inheritable, and EOF terminates the SDK without declaring completion.
Native macOS and Linux acceptance SIGKILL only the entry during an open model stream,
checks that SDK-held output pipes close, then resumes with the same session
lock. No PID scanning or guessed process killing is used.

Loopback networking must be available. The handshake is not a security boundary
against another process running as the same user. Abrupt shutdown may leave an
incomplete evidence row, which fails closed rather than being accepted as a
receipt; it cannot make native file edits atomic or guarantee cleanup of every
shell-command descendant. Windows behavior still needs native acceptance.
The candidate currently forces no Git/auto-commit/gitignore writes; do not
assume native Aider defaults apply. The actual bridge launcher has been
exercised through the manifest: provider refusal leaves delivery pending, a
later answer consumes it, and the reverse handoff carries the answer. This
uses a real Aider SDK with a deterministic local provider and synthetic Codex
source. First-start launcher acceptance also verifies a newly created session
is linked instead of older histories and its first answer consumes delivery.
A native whole-file edit is exercised on a disposable text file with Git absent,
without creating `.git` or `.gitignore`. Terminal behavior and authenticated
external inference remain unfinished; this is not a support announcement.
Audit/tool capabilities are explicitly unavailable; installed SDK metadata
does not claim provider authentication.

The driver appends the current packaged `codex/SKILL.md` to the native system
template, conditioned on an explicit user handoff request. It copies the prompt
object before modifying it and escapes template braces. The shared skill is
read at launch, not duplicated in an installed Aider-specific instruction file.
Receiving context alone does not instruct another handoff.

Outbound handoffs use Aider's own shell proposals and confirmation. The bridge
does not add an automatic shell executor or change coding mode. Ask/whole modes
do not provide the same shell-proposal execution as diff mode; use Aider's
`/chat-mode diff` when an outgoing command needs that path. No `/bridge` native
slash command is registered. The acceptance asks for a handoff in normal chat.
The target in this acceptance is a capturing fixture executable, not an
authenticated Codex model.

Aider 0.86.2's `main(return_coder=True)` silently turns unspecified approval
settings into `yes_always`. The bridge captures the native parser's final
CLI/config/environment choice before that SDK default and restores it when
constructing native IO. Unspecified approval remains interactive; explicit
settings are preserved. Native `--yes-always` itself declines shell proposals
that require explicit confirmation, and bridge does not bypass that behavior.

Run the isolated lock acceptance with a trusted Python interpreter:

```sh
node test/integration/aider-lock.mjs /absolute/path/to/python
```

Run the actual SDK/local-provider acceptance with an isolated environment
containing `aider-chat==0.86.2` (no external credentials or Git required):

```sh
node test/integration/aider-native.mjs /absolute/path/to/venv/bin/python
```

The macOS/Linux PTY variant requires `/usr/bin/expect`:

```sh
node test/integration/aider-native.mjs /absolute/path/to/venv/bin/python --interactive
node test/integration/aider-native.mjs /absolute/path/to/venv/bin/python --interactive --cross-device
```

It interrupts an actual streaming response with terminal Ctrl+C, then sends
another message in that same process. The entry leaves SIGINT handling to Aider,
which already receives it from the terminal process group; forwarding it again
would deliver two interrupts. Direct SIGINT to only the wrapper is not a
supported way to interrupt generation. Use terminal Ctrl+C or SIGTERM to stop
the wrapper and its SDK child.

This covers ordinary interaction, restore, refusal, incomplete output and
corrupted-history refusal before any provider request. SSE streaming is also
exercised through the actual launcher: a completed response consumes delivery,
a length-limited partial response stays pending while retaining its text, and
a successful streamed retry consumes the same pending delivery. This does not
yet prove abrupt network disconnection. The `--interactive` variant additionally
verifies terminal interruption and continuation in the same process.
It is opt-in, creates
temporary global storage and does not install or modify an Aider environment.
Linux arm64 acceptance uses Python 3.12, actual SDK 0.86.2 and Node 24 inside a
network-disabled container. See the test-only Dockerfile and commands in
DEVELOPMENT.md. Local model responses and the destination Codex executable are
fixtures; this does not establish authenticated model or actual Codex acceptance.

The default exercise now resumes the actual SDK after a same-filesystem project
move and edits a file in its new cwd. Linux `--cross-device` instead copies the
temporary project to `/dev/shm`, proves differing device IDs, removes the old
project and runs explicit `project adopt`. Session resolution must fail before
adoption. History and completion evidence remain byte-identical until native
resume; the restored model context must contain the original conversation and
the new directory's file contents, and the SDK must edit that file without
recreating the old project. The global store, Python environment and native
history stay on the same machine; this is not an artifact-based machine transfer.

## Pi Candidate

`src/agents/pi.mjs` is an experimental adapter, not a built-in supported target.
Its native reader accepts Pi v3 JSONL trees and follows the active parent chain;
it does not treat abandoned branches as new conversation. Discovery verifies the
header's project directory rather than trusting the encoded directory name.

Start and resume append the packaged handoff protocol conditionally to Pi's
system prompt. It applies only to a requested handoff, not to receiving context.
This avoids Pi's first-wins skill-name collisions without disabling user skills
or installing another copy into the home directory. The protocol remains sourced
from `codex/SKILL.md`; it is additional prompt content, not a free capability.

Pi 0.85.1 CLI and terminal resume have been exercised with an isolated local
deterministic provider, including native session continuity and a colliding user
skill. That evidence does not establish external-model comprehension, account
authentication, or model-driven invocation of the handoff command. Those remain
separate acceptance requirements. Pi itself is not a bridge dependency.

For an already-linked Pi session, `bridge project adopt <id>` also authorizes
its recorded old working directory when that directory is absent and belongs
to this project's adoption history. Session ID verification remains mandatory;
ordinary discovery still requires the current project directory. Recreating
the old directory makes the exception fail closed. Bridge never rewrites the
native transcript or bypasses Pi's interactive working-directory confirmation.
Pi may request that confirmation again while its stored header names the old
directory. This is same-machine relocation with native history still present,
not transfer of vendor sessions to another machine.

Run the opt-in native transport exercise against an already installed, trusted
Pi CLI (tested with `@earendil-works/pi-coding-agent` 0.85.1 and Node >=22.19):

```sh
node test/integration/pi-native.mjs /absolute/path/to/pi/dist/cli.js
node test/integration/pi-native.mjs /absolute/path/to/pi/dist/cli.js --bridge
node test/integration/pi-native.mjs /absolute/path/to/pi/dist/cli.js --migrate
node test/integration/pi-native.mjs /absolute/path/to/pi/dist/cli.js --cross-device
```

The default mode runs two print-mode turns. `--interactive` adds a real TUI
resume; `--bridge` instead uses the real bridge launcher for the third turn and
checks pending-delivery consumption plus the reverse handoff. PTY modes require
macOS or Linux with `/usr/bin/expect`. The harness provides an isolated loopback model,
temporary agent home and native session, and removes them afterward. It installs
nothing, does not use account credentials, and does not run in the default unit
suite. The bridge route uses a synthetic Codex source and actual Pi executable;
it verifies transport, not a real Codex/model conversation. Its isolated PATH
has no Git, and it asserts that no project-local `.bridge` directory is created.
`--migrate` stages the fixture's pending runtime store in the old `.bridge`
location before launching. It checks automatic migration, backup preservation,
byte-identical consumed context and continuation of the same native Pi session.
Only this mode intentionally creates the temporary legacy directory; successful
migration removes it. It does not simulate moving the native project to another
filesystem or rewriting vendor-owned working directories.

`--cross-device` is a separate Linux exercise using `/dev/shm`: it asserts that
the original and copied project have different device IDs, deletes only its
temporary original, explicitly adopts the UUID, and confirms Pi's own relocation
dialog in the test PTY. The same native session must receive both earlier
context and the pending handoff, with the new cwd in its system context. The
exercise first cancels that native dialog and checks that no provider request
occurs and delivery remains pending, then resumes and confirms it. The
global store and vendor transcript remain on their original filesystem.

Linux arm64 acceptance also passes with Node 24 and Pi 0.85.1 installed inside
Linux, with install scripts disabled. The network-disabled container exercises
the real TUI, bridge roundtrip and pending migration; it mounts no user home or
credentials. This is native Linux transport evidence, not external-provider
authentication, Windows support or a clean Linux installation of bridge itself.

## Launch Argument Privacy

Bridge-owned launch, status, save, clear and conflict diagnostics show argument
counts or reasons, not arbitrary argument text. Approval/sandbox warnings remain
visible. Arguments still reach the child process unchanged; this is display
privacy, not encryption or redaction of vendor output, shell history or OS
process arguments. `--cb-save-args` explicitly persists the original values in
the machine-local config. Prefer the agent's credential store or environment
configuration over putting credentials in saved arguments.
