> Read-only ways to ask what the bridge thinks is true, without changing anything.

# Status, search and watch

`bridge status` shows what is linked in the active lane, which launch flags are armed and what work is pending. `--json` gives the same thing in a shape a script can consume — deliberately without vendor watermarks, session identifiers or absolute paths, because status output has a habit of ending up in issue reports.

## Searching your own evidence

`bridge search <text>` looks through local summaries, checkpoints and audit manifests. It is how you answer "when did we decide that" without opening five sessions.

Two behaviours worth knowing. A search that cannot read part of its evidence **says so** rather than returning a smaller number silently. And an empty filter is refused instead of being treated as no filter — `--lane=` with nothing after it is a mistake, not a request to search every lane.

## Watching

`bridge watch --policy read-only` streams status changes as JSON lines and takes no automatic action. It refuses to start at all unless it can get a verifiable directory creation identity, and it re-checks that identity before emitting, so a directory replaced underneath a long-running watcher stops the stream instead of quietly reporting on somewhere else.

## Everything here is a read

None of these commands write state, link sessions or touch a vendor store. They work when the native locking backend is unavailable, which is the reason inspection was deliberately kept off that dependency: when writes are broken you need to be able to look more than ever.
