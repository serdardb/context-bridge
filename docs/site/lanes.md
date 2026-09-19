> One directory can hold several independent conversations, and now each can have its own working tree.

# Lanes and worktrees

A lane is a line of work. Each keeps its own agent links, switch history and checkpoints, and lanes cannot see each other — so two terminals can run two conversations in one project without their state colliding.

A bare `bridge` resumes the last lane, which means a project with one lane never has to know lanes exist.

## Starting one from another

`bridge lane new refactor --seed main` starts a lane with another lane's decisions and git state as its opening context. It is the difference between a fresh conversation and a fork of one you were already having.

## Lanes and code

Until 0.13.0 lanes isolated context only: every lane shared one checkout, and that was stated plainly because it is the kind of limit people discover at the worst moment.

Lanes can now take a Git worktree. `bridge lane new <name> --worktree <path>` creates one; `bridge lane attach <name> --worktree <path>` connects a worktree you already have without copying sessions into it. A lane without a worktree behaves exactly as before.

Ordinary projects do not need Git installed. Worktree operations do, because those genuinely are Git.

## When creation is interrupted

Creating a seeded lane writes several things, and an interruption can leave a lane that exists but was never filled. `bridge lane seed <name> --seed <source>` finishes the job explicitly rather than the tool guessing whether a half-made lane should be completed or removed.

Deleting takes `--yes`, and inspects what it would remove before touching state.
