---
name: bridge
description: Hand this session off to another coding agent (context-bridge)
argument-hint: codex
allowed-tools: Bash(bridge handoff:*), Bash(bridge doctor:*), Bash(bridge status:*)
disable-model-invocation: true
---

The user wants to hand this session off to another coding agent via context-bridge.
Target agent: $ARGUMENTS

Follow these steps exactly:

1. If the target is not `codex`, tell the user that v0.1 only supports `/bridge codex` from Claude, and stop.

2. Compose two concise notes from THIS conversation (only what happened since the
   last bridge sync, if any):
   - DECISIONS: the concrete decisions made, including rejected approaches and why
     (semicolon-separated, max ~3 items, each one short sentence).
   - NEXT: the current objective and any unresolved questions
     (semicolon-separated, max ~2 items).

3. Run this command with the Bash tool (single call):

   bridge handoff codex --decisions "<DECISIONS>" --next "<NEXT>"

4. If the command fails AND its error output mentions `--adopt`, this session
   was not recorded by the plugin hook and was discovered heuristically: relay
   the error's timestamps to the user (never IDs), ask them to confirm the
   found transcript belongs to this conversation, and ONLY after an explicit
   yes rerun the exact same command with `--adopt` appended. For any other
   failure, show the user the exact error output and stop. Do not improvise
   other workarounds.

5. If it succeeds, reply with exactly one short sentence like
   "Handing off to Codex — the bridge will switch automatically." and END YOUR
   TURN immediately. Do not run any further tools. The bridge launcher detects
   the completed turn and performs the switch; never mention session or thread IDs.
