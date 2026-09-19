> The three failures people actually hit, and what the tool does not do yet.

# When something goes wrong

## An agent crashed or ran out of quota before handing off

Its work is not lost. The bridge builds a delta from the agent's own session files on disk, not from the running process — the agent being alive was never what a handoff needed.

`bridge status` names any agent holding work that never made it out, with the command to free it:

```
Antigravity has work that was never handed off. It is saved, not lost:
bridge handoff claude --from antigravity
```

That works from any terminal, with the stuck agent open, closed, or hours in the past. `--from` names the departing agent explicitly instead of inferring it, which is the entire point: the agent that would normally announce itself is the one that cannot.

## A delta was routed to a hook that never fired

The launcher says so when the session ends, and names the file the context is still sitting in. Nothing is lost and the next handoff carries it again.

For Codex this usually means its hooks have not been trusted yet. Review them once with `/hooks`.

## You want to know what the previous agent actually did

`bridge inspect` renders the audit written beside the last delta: commands with their outcomes, failures first, files changed and read.

Each agent contributes what its own record can yield, and the output says plainly where an agent is **blind** rather than leaving an empty column that reads as "nothing happened". That distinction is deliberate and it runs through the whole tool.

## Mutations refuse with a locking error

If the native backend cannot load, writes refuse and reads keep working:

```
Native locking is unavailable on <platform>/<arch>; mutation refused.
… Read-only inspection remains available.
```

There is no degraded PID-only mode, because a degraded lock is not a slower lock — it is an absent one. Reinstall with optional dependencies enabled for your platform, then run `bridge doctor --json`.

## A command exits 2

That is not a failure. Code `2` means the operation needs explicit confirmation, and the command prints the exact form to retry with. See [exit codes](/docs/context-bridge/configuration).

## Known limits

Worth knowing before you hit them:

- Vendor session formats can change in a point release without warning. `bridge doctor` checks compatibility; it cannot prevent the change.
- OpenCode has no supported API, so the bridge writes into its internal SQLite store and checks the schema first. An incompatible OpenCode release fails closed with a diagnostic.
- Locks, ordered writes and flushes survive process death and interruption. They are not a claim about power-loss durability on every filesystem and controller.
- Experimental adapters are candidates, not supported agents, and release acceptance deliberately ignores them.
