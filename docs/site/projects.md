> State that outlives its directory needs a way to be listed, reconnected, archived and permanently removed.

# Project lifecycle

Once runtime state is machine-local rather than project-local, it survives the directory it describes. That is the point — a project can move — but it means something has to manage stores whose directory is gone.

## Reconnecting a project that moved

If a move changes the directory's filesystem identity, find the existing UUID with `bridge project list --json` and run `bridge project adopt <id>` from the new location before starting a session there.

Adoption refuses a still-existing old directory, an already registered target, and legacy runtime data in the target. It reconnects the bridge's own store; it does not move vendor-owned native sessions or guarantee the working directories they recorded are still valid.

Older registrations made before identity verification are marked `unverified` and require an explicit adopt after you have checked what they point at. The bridge will not decide on its own that this directory is that project.

## Looking without touching

`bridge project inspect <id>` reads a retained store by UUID **without mutating it**, including for projects whose directory no longer exists. `bridge project recover <id>` previews interrupted operation records and clears them with `--apply`.

## Archiving and removing

`retire` archives a quiescent store, `restore` brings it back, and `purge` deletes an archive permanently. All three preview by default and act on `--apply`.

`purge` additionally requires the id typed back with `--confirm <id>`. The commands that cannot be undone are the ones that ask twice.

Retirement journals its intent before renaming, so an interruption leaves a state that can be read and resumed rather than guessed at.
