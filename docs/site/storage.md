> Runtime state left the repository in 0.13.0. This is where it went and how to move an existing project.

# Storage and migration

Bridge state used to live in a `.bridge/` directory inside each project. It now lives in a machine-local store:

```
macOS     ~/Library/Application Support/context-bridge
others    $XDG_STATE_HOME/context-bridge
          (default ~/.local/state/context-bridge)
override  CONTEXT_BRIDGE_HOME
```

Windows included. Projects are keyed by a UUID in a registry and resolved through the directory's filesystem identity, which is why a project can now be moved and reconnected instead of losing its history.

## Migrating

Existing project-local state is migrated on first mutating use. To see it first, `bridge storage plan` previews the whole thing and changes nothing. `bridge storage migrate` performs it, keeping verified backups and retaining recovery evidence. Files the bridge does not recognise are preserved, never deleted.

Afterwards, `bridge storage cleanup-ignore` previews removing the now-pointless `.bridge/` rule from your `.gitignore`; `--apply` removes it.

## If the project is on another filesystem

`rename()` is atomic inside a filesystem and unavailable across one, and copy-then-delete is not a move — it is two operations with a window in between. So the bridge will not fake it.

Create a private directory **outside the project but on the project's own filesystem**, and pass it:

```
bridge storage migrate --retirement-dir /absolute/path/to/vault
```

The new runtime and its verified backup still go to the normal home; only the original files stay in the vault, moved by a rename that is allowed to be atomic. Without a suitable vault, cleanup refuses and preserves the source.

A pending migration records the vault it chose and resumes there without the flag — but cannot change location once any source file has been retired, because a half-retired migration pointing at two places is unrecoverable by definition. `bridge storage plan --json` reports the recorded path.

Locks, ordered writes and flushes protect against process death and interruption. They are not a claim about power-loss durability on every filesystem and controller.
