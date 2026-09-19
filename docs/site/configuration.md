> Every environment variable the bridge reads, and the three exit codes it promises.

# Configuration and exit codes

There is no configuration file. Everything is a flag, a command, or one of these.

## Bridge variables

| Variable | Effect |
| --- | --- |
| `CONTEXT_BRIDGE_HOME` | Override the machine-local runtime root. Otherwise the platform default is used. |
| `CONTEXT_BRIDGE_LANE` | Select the lane for this invocation without switching the project default. |
| `CONTEXT_BRIDGE_ADAPTERS` | Absolute path to an adapter manifest. Setting it is permission to execute those modules — see the [adapter contract](/docs/context-bridge/adapters). |
| `CONTEXT_BRIDGE_AIDER_PYTHON` | Absolute interpreter path for the experimental Aider candidate. Never guessed from `PATH`. |
| `CONTEXT_BRIDGE_LOCK_TIMEOUT_MS` | How long a lock acquisition may wait before giving up. Default `30000`. A positive integer; anything else is refused rather than silently defaulted. |
| `BRIDGE_DEBUG=1` | Opt-in diagnostics on stderr, redacted by construction. |

`CONTEXT_BRIDGE_LOCK_TIMEOUT_MS` bounds **retries**, not filesystem calls and not a whole command. And a timeout never evicts the holder: it is the bridge giving up, not taking over.

## What debug output redacts

`BRIDGE_DEBUG=1` is safe to turn on and paste into an issue, by construction rather than by care:

- any field named like `prompt`, `token`, `secret`, `password`, `content`, `message` or `transcript` becomes `[redacted]` before it is serialised
- the home directory collapses to `~`, the working directory to `.`, and any other `/Users/<name>` to `~`
- anything shaped like `sk-`, `ghp-` or `xox*-` is stripped

Checkpoints are different: they are intentionally preserved evidence, not a redaction boundary. See [privacy](/docs/context-bridge/privacy).

## Vendor variables the bridge honours

If you have moved an agent's home directory, the bridge follows it rather than guessing:

`CLAUDE_CONFIG_DIR` · `CODEX_HOME` · `GROK_HOME` · `ANTIGRAVITY_HOME` · `OPENCODE_HOME` · `OPENCODE_DB` · `XDG_STATE_HOME` · `XDG_DATA_HOME`

`NO_COLOR` is respected.

## Exit codes

Small and stable on purpose:

| Code | Meaning |
| --- | --- |
| `0` | The operation completed, or a read-only check found no issue. |
| `1` | The operation failed, an integration is unavailable, or a diagnostic found a problem. |
| `2` | The operation needs explicit confirmation before it can continue. The command prints the exact form to retry with. |

Code `2` is today the heuristic session adoption path. It exists so that a script can tell "this needs a human" apart from "this failed", which a single non-zero code cannot express.

Expected operational failures print one actionable line with no stack trace. Unexpected programming failures keep the stack, because those are bugs and should stay diagnosable.
