> Release gates that bind their result to the exact commit and packages they checked.

# Release gates

These commands exist because of a specific mistake. A release shipped with notes describing features that had gone out two months earlier — the notes had been written from a session summary rather than from the diff between two tags.

## Checking

`bridge release-check` verifies the release gates; `--ci` additionally checks HEAD on GitHub. `--evidence` verifies local acceptance without calling agents or GitHub, which is the fast path when you only want to know whether recorded evidence still holds.

## Preparing

`bridge release-prepare` runs the acceptance gates and records evidence bound to the exact commit, toolchain and both package hashes. Publish-time verification then rejects evidence that is missing, stale, or no longer matches what is about to be published.

That binding is the whole idea. A passing test run is a fact about a particular tree; evidence that does not name the tree it came from is a claim, and claims are what produced the mistake in the first place.

## The part no command enforces

The release checklist in this repository says to identify the previous tag, write the changelog only from the actual implementation diff, and never turn a session summary or roadmap into current release notes — every entry must be attributable to a changed file.

No test enforces that. It is the kind of thing only a habit catches, which is why it is written down where the person doing the release will read it.
