---
name: bridge
description: Hand this session off to another coding agent (context-bridge)
argument-hint: codex | grok
allowed-tools: Bash(bridge handoff:*), Bash(bridge doctor:*), Bash(bridge status:*)
disable-model-invocation: true
---

The user wants to hand this session off to another coding agent via context-bridge.
Target agent: $ARGUMENTS

Follow these steps exactly:

1. If no target was given, ask which agent to hand off to and stop until they
   answer. Otherwise take the target as written.

2. Write a SUMMARY of this conversation for the agent taking over, covering only
   what happened since the last bridge point.

   The bridge already carries the transcript, the git changes and a record of
   every command that ran. What it cannot carry is which of that mattered, and
   you are the only thing that knows. So do not list what happened; say what it
   means.

   Cover what was decided and why, what was tried and rejected, what is in
   flight, and what is unresolved. Say what the next agent should verify first.
   Where you are not certain, say so rather than writing it as settled: a summary
   that sounds equally sure of everything is worse than one that marks its own
   soft spots, because the reader cannot tell which parts to check.

   Length is yours to judge. There is no item count and no sentence limit. The
   only limit is a byte budget, and the command will tell you the number if you
   go past it. Do not summarise the whole project, only what happened since the
   bridge brought you here; if nothing of substance happened, say that in a line.

3. Compose two short notes as well:
   - DECISIONS: the concrete decisions made, including rejected approaches and why.
   - NEXT: the current objective and any unresolved questions.
   Both semicolon-separated. These are the scannable form of what the summary
   says at length, not a replacement for it.

4. Run this command with the Bash tool (single call), with the requested agent as
   the target:

   bridge handoff <target> --summary "<SUMMARY>" --decisions "<DECISIONS>" --next "<NEXT>"

   The bridge itself validates the target and decides how the context travels.
   Do not add flags of your own.

5. If the command fails because the summary is too large, it says so and gives
   both numbers. Shorten it yourself and run the same command again, ONCE. Do not
   loop: if the second attempt is refused as well, show the user the error and
   stop. The bridge will not shorten it for you, deliberately, because cutting
   from the front keeps your opening and drops your reasoning.

6. If the command fails AND its error output mentions `--adopt`, this session
   was not recorded by the plugin hook and was discovered heuristically: relay
   the error's timestamps to the user (never IDs), ask them to confirm the
   found transcript belongs to this conversation, and ONLY after an explicit
   yes rerun the exact same command with `--adopt` appended. For any other
   failure, show the user the exact error output and stop. Do not improvise
   other workarounds.

7. If it succeeds, reply with exactly one short sentence like
   "Handing off to Codex — the bridge will switch automatically." and END YOUR
   TURN immediately. Do not run any further tools. The bridge launcher detects
   the completed turn and performs the switch; never mention session or thread IDs.
