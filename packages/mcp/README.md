# Context Bridge MCP companion

Optional official-SDK stdio transport for Context Bridge MCP API 1. Install
alongside Context Bridge 0.13.0 or a later compatible core (0.12.4 predates this API):

```sh
npm install -g @serdardb/context-bridge @serdardb/context-bridge-mcp
bridge mcp --project /absolute/project/path
```

Without `--allow-content`, only metadata tools are registered and core supplies
no search callback. With opt-in, search returns bounded evidence snippets.
Project identity and all storage access stay in core; this package never
imports another copy of core.

Automatic sibling discovery is tested for npm local/global layouts. With
isolated package managers, including pnpm and Yarn PnP, configure the MCP host's
`CONTEXT_BRIDGE_MCP_MODULE` to the absolute path of this package's `index.mjs`
in an installation where its own dependencies are resolvable. Bridge does not
search the working directory, run npm automatically or spawn a command on PATH.
A relative override is rejected. PnP needs its normal Node loader as well;
full package-manager-specific setup is not claimed tested.

The companion and any explicit module path are trusted executable code, not a
sandbox. Keep them under operator control. Tool annotations and missing content
callbacks do not prevent arbitrary installed code from using Node filesystem APIs.

Maintainers publish only from the repository after the shared release receipt
accepts both core and companion tarball hashes. Changing either invalidates it.
The package contains no runtime store, credentials, tests or build hooks.

## Read-only MCP

Starting with 0.13.0, MCP is a separately installed companion. Install both
packages in the same npm prefix:

```bash
npm install -g @serdardb/context-bridge @serdardb/context-bridge-mcp
```

Run `bridge mcp --project /absolute/project/path` from an MCP host using stdio.
The project is fixed at startup; tools cannot choose another directory. By
default only `bridge_status` and `bridge_adapters` are exposed. Neither starts
agents, acknowledges delivery, nor initializes a missing project. No network
listener is opened and Git is not required.

Add `--allow-content` explicitly to expose `bridge_search`. This lets the host
and its model read potentially private checkpoint snippets. It returns at most
100 matching records (20 by default), with omitted-result counts; snippets are
not complete transcripts. The limit bounds output, not the underlying local
scan. Search stays within the selected project's store; status can report
explicitly linked worktree lanes. There is no general file-reading tool.

Example host configuration (adjust executable and project paths):

```json
{
  "mcpServers": {
    "context-bridge": {
      "command": "/absolute/path/to/bridge",
      "args": ["mcp", "--project", "/absolute/path/to/project"]
    }
  }
}
```

Local evidence is untrusted data, not instructions. Read-only tool annotations
do not sandbox installed adapter plugins: `CONTEXT_BRIDGE_ADAPTERS`, when set,
still loads trusted executable code at startup. Unset it for built-ins only.
The companion uses the official MCP SDK, Zod and a Node 18-compatible Hono pin;
none are core runtime dependencies. Automatic discovery supports npm sibling
installations. For isolated layouts (pnpm/Yarn PnP), set the MCP host environment
`CONTEXT_BRIDGE_MCP_MODULE` to the trusted absolute companion `index.mjs` path,
with that package's dependencies/loader available. Bridge does not search CWD
or install code automatically. Missing, unloadable and incompatible companions
produce distinct errors. Full pnpm/PnP setup is not claimed verified.

The companion is trusted Node code, not a sandbox. Core withholds the search
callback without content opt-in, but cannot prevent arbitrary installed code
from reading files itself. MCP acceptance is not native-agent acceptance or a
concurrent filesystem snapshot.
