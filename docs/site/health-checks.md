> Doctor reports what it can see, verify proves it works, and the difference between the two is the point.

# Doctor, verify and adapters

`bridge doctor` checks the things a setup needs: agents installed, authentication present, hooks in place, routes configured. `--fix` bootstraps what is missing and asks before each change. `--deep` goes further and puts a real one-line question to each agent, reporting LIVE or BROKEN rather than "installed".

That distinction runs through this whole tool. A binary existing is not an agent answering. A route being configured is not a handoff arriving.

## Verify is the strict version

`bridge verify` exists for releases and CI. It smoke-tests every installed agent, checks each session and discovery reader, and walks **every directed route** between installed agents — five agents means twenty routes, because Claude to Codex is not the same path as Codex to Claude. It exits non-zero if a single one fails, and `--json` makes it usable from a script.

It also fails when the native locking backend cannot actually acquire and release a lock, probed in a bounded temporary process. Installation is not evidence that mutations work.

## Doctor also checks the things that break silently

Vendor session formats are internal. A renamed field ships in a point release with no announcement, and without a check every handoff would quietly return an empty delta while everything still looked installed. Doctor parses each vendor's session files with this version of the bridge and says so when they no longer agree.

For OpenCode it goes one step further and reads the schema of the SQLite store the bridge writes into, reporting incompatibility rather than discovering it mid-handoff.

## Evaluation

`bridge eval` runs deterministic context-quality fixtures with no agent calls. `--live` opts into synthetic recall tests that do use your provider quota, which is why they are not the default: `--scenario decision` checks final decisions, reasons and omitted context, and `--scenario summary` measures an agent-written summary inside a second fresh session.

For what is registered and what each adapter declares it can do, see the [adapter contract](/docs/context-bridge/adapters).
