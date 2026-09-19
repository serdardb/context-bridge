> Install it, let doctor bootstrap what is missing, then start the loop and switch agents with one command.

# Getting started

```
npm install -g @serdardb/context-bridge
bridge doctor --fix
bridge
```

`doctor --fix` is the step worth not skipping. It checks that each agent is installed and authenticated, installs the hooks the bridge needs, and asks before every change it makes. Running `bridge` afterwards starts the loop in Claude Code by default.

From inside any agent, `/bridge codex` in Claude Code or `$bridge codex` elsewhere closes the one you are in and opens the other with the context it was missing. You do not copy anything, and you do not hunt for a session id.

## What actually moves

Not the transcript. The bridge keeps a record of which agent has seen what, computes the difference, and delivers only that. Each agent keeps its own real session — Claude Code resumes as Claude Code, Codex as Codex — so nothing about your normal workflow changes except that the second agent already knows what the first one decided.

The context it carries is the departing agent's own summary, the decisions it recorded, open questions, and as much of the conversation as fits inside the delivery budget for that road.

## Agent flags pass straight through

Everything after the agent name goes to that agent untouched:

```
bridge claude --dangerously-skip-permissions --model claude-fable-5
```

They apply to that launch only. `--cb-save-args` keeps them for this project, `--cb-clear-args` takes it back, and `bridge status` lists what is armed — because a saved permission bypass nobody can find is one nobody can undo.

The only flags held back are the ones that would break the session link the bridge maintains, and each is dropped with a printed reason rather than silently.
