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
//   id             "claude" | "codex" | "grok"
//   displayName    shown to users
//   injection      "prompt" = delivered as an auto-submitted resume prompt
//                  "hook"   = delivered through the agent's own session hook
//   discover(projectDir)          -> SessionRef | null   (deterministic, no guessing)
//   hydrate(projectDir, slot)     -> SessionRef | null   (rebuild from stored state)
//   resumeCommand(ref, extraArgs) -> {cmd, args}
//   currentMark(ref)              -> sync watermark to persist (vendor-defined)
//   activitySince(ref, mark)      -> {messages, patchedFiles, turnsCompleted}
//   idleAfter(ref, sinceIso)      -> boolean | null   (null = reported out of band)
//   conflictFlags                 -> flags that break the bridge's session link
//
// `messages` is always [{role: "user"|"assistant", text, at}] regardless of vendor.
//
// The watermark is OPAQUE and vendor-defined, which the two-agent design got wrong
// by assuming time is universal. Claude and Codex mark by ISO instant because their
// transcript records are timestamped. Grok's chat rows carry no timestamps at all,
// so it marks by row count; using a timestamp there would silently resend the whole
// conversation on every handoff. Callers must persist whatever currentMark returns
// and hand it back untouched — never inspect it, never compare marks across agents.
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as grok from "./grok.mjs";

export const ADAPTERS = { claude, codex, grok };

export function adapterFor(id) {
  return ADAPTERS[id] ?? null;
}

/** Ids of every agent the bridge can drive, in stable display order. */
export const AGENT_IDS = Object.keys(ADAPTERS);
