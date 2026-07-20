---
name: bridge
description: Hand this session off to another coding agent via context-bridge (usage: $bridge claude, $bridge grok)
---

The user invoked the context-bridge handoff, e.g. `$bridge claude` or `$bridge grok`.

Follow these steps exactly:

1. Read the requested target agent from the invocation. If none was given, ask
   which agent to hand off to and stop until they answer.

2. Compose two concise notes covering ONLY what happened in this session since
   the last bridge sync:
   - DECISIONS: concrete decisions made, including rejected approaches and why
     (semicolon-separated, max ~3 items, each one short sentence).
   - NEXT: the current objective and unresolved questions
     (semicolon-separated, max ~2 items).

3. Run exactly this shell command, with the requested agent as the target:

   bridge handoff <target> --decisions "<DECISIONS>" --next "<NEXT>"

   The bridge itself decides which agent is handing off, which target is valid,
   and how the context travels. Do not add flags of your own.

4. If the command fails AND its error output mentions `--adopt`, an unlinked
   session was discovered heuristically: relay the error's timestamps to the
   user (never IDs), ask them to confirm it is the right session, and ONLY
   after an explicit yes rerun the exact same command with `--adopt` appended.
   For any other failure, show the user the exact error output and stop. Do
   not improvise other workarounds.

5. If it succeeds, reply with exactly one short sentence like
   "Handing off to Claude — the bridge will switch automatically." and END
   YOUR TURN immediately. Do not run any further commands. The bridge launcher
   detects the completed turn and performs the switch; never mention session or
   thread IDs.
