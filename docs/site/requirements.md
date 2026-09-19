> What has to be installed, which versions, and what "supported" is and is not claiming.

# Requirements

- **macOS**, with selected Linux and Windows acceptance. That is not a claim that every agent, provider and terminal combination works on every operating system.
- **Node.js ≥ 18.18**
- **At least two supported agents, logged in.** One agent is not a bridge.

| Agent | Version | Authentication |
| --- | --- | --- |
| Claude Code | ≥ 2.1.x | your Claude subscription |
| Codex CLI | ≥ 0.143.0 | ChatGPT subscription, `codex login` |
| Grok CLI | ≥ 0.2.x | xAI key, `grok auth` |
| OpenCode | ≥ 1.18.x | any configured provider — a free model works, the bridge never makes the call itself |
| Antigravity | agy 1.1.x | native CLI authenticated, session history available |

OpenCode additionally needs the `sqlite3` CLI to read a handoff snapshot or deliver into its store. macOS ships it; `bridge doctor` says so if it is missing.

The core installs Koffi for native locking and exclusive publication — keep its platform dependencies available, and `bridge doctor` will check the backend rather than assume it. MCP is a separate optional package.

Git is **not** required for ordinary projects. Worktree lanes need it, because those genuinely are Git.

## What compatibility means here

Vendor session formats change independently of this tool, and they change in point releases without an announcement. That is the reason `bridge doctor` parses each vendor's session files rather than only checking that a binary exists.

Three levels, and each is weaker than the next one down:

- **`bridge doctor`** — installed, authenticated, configured, and the session still parses with this version.
- **`bridge verify`** — the agents actually answer, and every directed route is configured.
- **A real handoff** — the only thing that proves a handoff works.

Neither of the first two is a substitute for the third, and a version that worked historically is not a guarantee for a later vendor release.
