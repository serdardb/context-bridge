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
