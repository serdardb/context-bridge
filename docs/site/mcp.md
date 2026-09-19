> A read-only MCP server over stdio, in a separate package, exposing metadata unless you opt into content.

# MCP companion

MCP is not part of the core package. Install it alongside:

```
npm install -g @serdardb/context-bridge @serdardb/context-bridge-mcp
bridge mcp
```

The split is deliberate. The core keeps exactly one runtime dependency; the companion owns the MCP SDK and its transitive tree. Installing the core installs none of that.

## Metadata by default

`bridge mcp` exposes metadata: what is linked, what lanes exist, what changed. It does **not** expose the content of your conversations unless you pass `--allow-content`, which enables a content search callback that otherwise does not exist at all.

The default is not a setting you can forget to check. Without the flag, the capability is absent.

## Identity is re-checked on every call

The server refuses to start without a verifiable directory creation identity, and compares device, inode and creation time **before each tool call** rather than trusting the check it made at startup. A server that has been up for six hours has had six hours for the ground to move underneath it.

If the project it was serving is replaced, results are withheld rather than reported from somewhere else.

## What it is not

The companion is trusted executable code running on your machine, not a sandbox. It is a way to let an MCP-speaking client read this project's bridge state; it is not an isolation boundary, and nothing about installing it reduces what a client can do once it has your data.
