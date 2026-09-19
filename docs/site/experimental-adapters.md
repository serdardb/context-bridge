> Aider and Pi ship in the package as opt-in candidates. What works, how to turn them on, and exactly what has not been proven.

# Experimental adapters

The package contains adapters for **Aider** and **Pi**. They are candidates, not supported agents: the default five-agent set is unchanged, and nothing loads them unless you ask.

## Turning one on

Use the SDK-envelope entry points, never the internal modules under `src/agents/`:

```json
{
  "apiVersion": 1,
  "modules": [
    "/absolute/path/to/context-bridge/src/experimental/aider.mjs",
    "/absolute/path/to/context-bridge/src/experimental/pi.mjs"
  ]
}
```

Point `CONTEXT_BRIDGE_ADAPTERS` at that file and run `bridge adapters --json`. Include only the candidate you actually want. For an installed package, resolve the paths with `require.resolve('@serdardb/context-bridge/experimental/aider')`; a global install lives under the directory `npm root -g` reports.

Loading the manifest installs nothing, runs no model, enables no hooks and proves no vendor compatibility. Unsetting it returns you to the five built-ins without deleting any native history.

Release preparation deliberately ignores custom adapter manifests. A candidate cannot be quietly promoted into the supported-agent acceptance matrix by being present.

## Pi

The reader accepts Pi v3 JSONL trees and follows the active parent chain, so an abandoned branch is not mistaken for new conversation. Discovery verifies the header's project directory rather than trusting the directory name encoded in the path.

The handoff protocol is appended to Pi's system prompt conditionally — only for a requested handoff, never when receiving context. That is what avoids Pi's first-wins skill-name collisions without disabling your own skills or installing a second copy of anything.

**Exercised:** Pi 0.85.1 CLI and terminal resume against an isolated local deterministic provider, including native session continuity and a deliberately colliding user skill.

**Not established:** external-model comprehension, account authentication, and model-driven invocation of the handoff command. Those are separate acceptance requirements, and Pi is not a dependency of the bridge.

On Windows, npm's `pi.cmd` cannot be launched as a native executable, so the adapter resolves the installed package's declared JavaScript entry point from the matching PATH directory and runs it under Node, passing context as literal arguments rather than shell text. Standard npm layouts are recognised; anything else fails with an explicit error rather than a guess.

## Aider

The transport uses the installed Python SDK rather than `--message`, which exits after a single turn, or `--load`, which interprets slash commands. Native Markdown is kept as raw evidence instead of being presented as a message protocol it is not.

The driver records observed input and response text with explicit roles alongside completion evidence. A failed turn keeps its response text, labelled, and does not acknowledge delivery. Bytes not covered by an observation stay an unclassified fragment rather than becoming invented messages.

It requires `CONTEXT_BRIDGE_AIDER_PYTHON` naming an **absolute** interpreter in a trusted environment with `aider-chat==0.86.2` and Python 3.10–3.12. It never installs packages and never guesses an interpreter from PATH. The configured path is invoked unchanged, because resolving a virtualenv's Python symlink to its base executable can silently select a different environment.

The experimental Windows driver additionally needs `httpcore==1.0.9`. During a model send, ordinary socket reads yield periodically to Python signal handling while preserving each underlying read timeout — not a whole-request deadline. Client construction, proxy selection and TLS contexts are untouched, and TLS-in-TLS reads poll only the underlying receive operation.

**Exercised:** on native Windows, local TLS and nested-TLS bytes, timeouts, and Ctrl-C followed by same-process continuation.

**Not established:** authenticated providers and deployed proxies. The release notes say the same thing in one line — Aider authenticated-provider acceptance was not completed, and this release does not claim it.

## Why they ship at all

An adapter that only exists in a branch gets tested once. Shipping these as candidates, behind an explicit manifest, with their limits written down, means the contract gets exercised by something other than the five agents that shaped it — which is the fastest way to find out where the contract is actually wrong.
