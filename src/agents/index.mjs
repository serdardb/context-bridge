// Agent adapters.
//
// Every bridged agent is described by one module implementing the contract below,
// so adding a fourth agent means writing one file instead of touching eleven.
// This is deliberately narrow: it covers the four behaviours that are genuinely
// per-vendor. Handoff composition, checkpointing and doctor still live outside,
// and are generalised in a later round.
//
// @typedef {Object} SessionRef
//   id             native session/thread id, the thing we resume by
//   transcriptPath absolute path to whatever the agent writes its conversation to
//   eventsPath     optional separate event stream (Grok); defaults to transcriptPath
//
// @typedef {Object} AgentAdapter
//   id             "claude" | "codex" | "grok" | "antigravity"
//   displayName    shown to users
//   injection      "prompt" = delivered as an auto-submitted resume prompt
//                  "hook"   = delivered through the agent's own session hook
//   discover(projectDir)          -> SessionRef | null   (deterministic, no guessing)
//   hydrate(projectDir, slot)     -> SessionRef | null   (rebuild from stored state)
//   resumeCommand(ref, extraArgs) -> {cmd, args}
//   startCommand(extraArgs)       -> {cmd, args}   (fresh session, no id yet)
//   promptArgs(delta)             -> string[]      (prompt-injecting agents only)
//   currentMark(ref)              -> sync watermark to persist (vendor-defined)
//   activitySince(ref, mark)      -> {messages, patchedFiles, turnsCompleted}
//   idleAfter(ref, sinceIso)      -> boolean | null   (null = reported out of band)
//   conflictFlags                 -> flags that break the bridge's session link
//   health()                      -> {version, auth, extras, ready, installHint}
//   smokeCommand()                -> {cmd, args}   (harmless headless probe)
//   detectHost(env)               -> id | null   (see the warning below)
//   capabilities                  -> what this agent's own record can ever yield
//
// `messages` is always [{role: "user"|"assistant", text, at}] regardless of vendor.
//
// The watermark is OPAQUE and vendor-defined, which the two-agent design got wrong
// by assuming time is universal. Claude and Codex mark by ISO instant because their
// transcript records are timestamped. Grok's chat rows carry no timestamps at all,
// so it marks by row count; using a timestamp there would silently resend the whole
// conversation on every handoff. Callers must persist whatever currentMark returns
// and hand it back untouched — never inspect it, never compare marks across agents.
//
// `detectHost(env)` answers one narrow question: does this environment PROVE that
// the current process is running inside this agent? Read the question carefully,
// because the obvious reading is the wrong one and it already cost us a bug.
//
// It is not "which variable names this agent". Environment variables are inherited
// by every child process, so a variable that merely identifies a session says only
// that this agent is somewhere in the ancestry, and answers yes from inside a
// completely different agent the bridge launched. `handoff.mjs` trusted
// `CODEX_THREAD_ID` that way, so a Grok session started by a launcher that was
// itself opened inside Codex reported Codex as the agent handing off, packing the
// wrong stream and advancing the wrong watermark. `hooks.mjs` had already learned
// this and written it down; the lesson simply never crossed the file boundary,
// which is most of why this now lives in the contract where it can be seen.
//
// So the honest answer for an agent with only ambient session variables is null,
// and Codex returns exactly that. A marker qualifies only if the agent sets it per
// process rather than exporting it into the session. Returning null costs little:
// under the launcher the bridge already knows who is running from its own record,
// and this is consulted only for sessions started outside it.
//
// `capabilities` answers a different question from anything else here: not what
// happened in a handoff, but what this agent's own record COULD ever tell us.
// The two must not be mixed. An empty list of commands in a manifest means no
// command ran; an agent that cannot record command text at all is not the same
// fact, and a reader with only the manifest cannot tell them apart. That is the
// exact shape of the worst bug this project has had, where Codex discovery was
// dead for weeks because a failed parse looked identical to a project with no
// match. So the structural limit is declared once, here, rather than repeated
// into every manifest as noise.
//
// Values are deliberately not booleans, because the truth is not binary:
//   true        the vendor records it as a structured field
//   false       it is not recorded at all, and no amount of parsing will find it
//   "parsed"    recoverable only by reading it out of an unstructured string,
//               so it works today and is the first thing to break on a reword
//   "partial"   recorded for some paths and invisible for others by construction
//   "pointer"   too large to carry, but reachable in the agent's own files
//   "full"      recorded complete and in the clear, with nothing held back
//   "summary"   only a condensed form exists; the full thing is not available
//   "truncated" recorded but cut by the vendor before we ever see it
//   "keyed"     calls and results pair on an id, so pairing survives reordering
//   "positional" they pair by order alone, which is the first thing to distrust
//               if the agent ever runs tools concurrently
//
// The list is closed, and a test enforces that. A value outside it is not a
// lesser fault than a missing one, because a reader that meets a word it does
// not know will either guess or ignore it.
//
// Every value below was measured against a real session on this machine, never
// read from a vendor's documentation. Documentation was wrong three times in one
// day here: on Antigravity's storage, on OpenCode's storage, and on OpenCode's
// environment. `capabilities` is a claim, and an unverified claim is how `READY`
// came to mean "the binary is installed". Fixture tests cut from real transcripts
// pin these, and a probe compares what is declared against what a live session
// actually yields — in BOTH directions, because a canary that only catches loss
// would never notice a vendor starting to record something we still report as
// missing, and we would under-report it forever without a single failure.
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as grok from "./grok.mjs";
import * as antigravity from "./antigravity.mjs";

export const ADAPTERS = { claude, codex, grok, antigravity };

export function adapterFor(id) {
  return ADAPTERS[id] ?? null;
}

/** Ids of every agent the bridge can drive, in stable display order. */
export const AGENT_IDS = Object.keys(ADAPTERS);
