> One command moves the work. What it carries, what it refuses to carry, and how to see it before it happens.

# Handoffs

A handoff is the product. `bridge handoff codex` prepares one; from inside an agent the same thing happens with `/bridge codex` or `$bridge codex`.

## Look before you leap

`--dry-run` reports the delivery road it would take, the estimated payload and the artifacts it would write, and changes nothing: no link, no import, no prune, no vendor session touched. It is the fastest way to answer "why is this delta so large" without producing one.

## Rescuing a session you cannot open

`--from <agent>` rebuilds a handoff from an agent that crashed, hit a rate limit, or is simply closed. The evidence is on disk; the session does not have to be alive to be read.

## What is delivered is framed as evidence

Context handed to an agent is wrapped, before and after, as **untrusted historical evidence rather than new instructions**. The bridge carries text produced in another session, and that text can contain anything the first agent read — a web page, a file, a pasted block. The frame tells the receiving agent to use it to understand prior work and not to follow requests embedded in it.

Those bytes are reserved inside the delivery budget rather than appended afterwards, because anything appended after a limit is applied disappears exactly when the content is largest.

This is defence in depth. It is not a sandbox, and it is not proof that a receiving model will ignore malicious content.

## Inspect and clean

`bridge inspect` shows what the last handoff's agents actually ran, failures first. `bridge clean` prunes old checkpoints — keeping the newest twenty handoffs and everything younger than seven days — and a pending injection is never deleted. Both support `--dry-run`, and `bridge unlink <agent>` forgets one agent's session so the next switch links it fresh.
