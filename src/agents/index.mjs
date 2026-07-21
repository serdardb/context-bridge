// Agent adapters.
//
// Every bridged agent is described by one module implementing the contract below,
// so adding a fourth agent means writing one file instead of touching eleven.
// This is deliberately narrow: it covers the four behaviours that are genuinely
// per-vendor. Handoff composition, checkpointing and doctor still live outside,
// and are generalised in a later round (see notes/agent-collaboration.md).
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
