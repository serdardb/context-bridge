> What is stored, where it lives, what can be in it, and what leaves the machine only when you ask.

# Privacy and what is stored

No hosted service is required, there is no telemetry, and there is no database. What exists is files on your own machine.

## What never happens

**No API key is read, requested or stored.** Authentication detection checks *existence* only — a Keychain entry name, the exit code of `codex login status` — and never touches the value. That is a deliberate boundary in the code, not a policy statement.

**Nothing is uploaded.** Ordinary handoffs and storage are local. The `share` commands contact an endpoint you name and run yourself, and they are separate, explicit operations.

## What is stored

Runtime state holds session references, sync watermarks, recovery journals and pending markers. It lives outside the project tree, so no `.gitignore` entry is needed and nothing follows a `git clone`.

Two kinds of file deserve more care than the rest:

- **Full-context checkpoints** can contain the exact conversation.
- **Audit manifests** can contain command arguments, file names and project paths.

Both live in the machine-local store, are excluded from the repository and the npm package, follow the handoff-group retention policy, and are worth reading before you share them. They are intentionally preserved evidence — `bridge inspect` and handoff recovery depend on them existing — which is exactly why they are not a redaction boundary.

Canonical memory is not here at all. It stays in each agent's own native transcript; the bridge keeps references and the `knownBy` matrix, not a copy.

## What leaves the machine, and when

**Delivered context becomes input to the receiving agent**, and that agent sends its input to its own configured provider. That is the feature working: a handoff you asked for reaches a model you chose. It is still worth stating plainly, because it is the one moment ordinary use involves a provider seeing the previous session's content.

**Live verification** (`bridge verify`, `bridge eval --live`) makes real agent calls and uses your quota. That is why neither is the default.

**Artifact export and sharing** are separate explicit commands. Export redaction is heuristic — it masks nested project paths, shares a list of sensitive keys across text and objects, and recognises common credential and private-key formats. That reduces risk; it does not guarantee a clean file. Read a bundle before it leaves.

## Pruning

`bridge clean` prunes old checkpoints, keeping the newest twenty handoffs and everything younger than seven days. A pending injection is never deleted. `--dry-run` shows what would go, and `--staging` cleans only abandoned evidence staging files.

Retention is per handoff group, so deleting one group does not orphan another's evidence.
