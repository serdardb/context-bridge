> Two hundred lines that say what an agent must expose, plus a loader that refuses almost everything. Bringing your own agent is mostly writing the agent.

# Adapter contract

Five agents ship built in, and 0.13.0 makes a sixth a supported shape rather than a fork.

It is worth being plain about the size of this. The package exports it as `adapter-sdk`, but it is not a toolkit:

```
src/adapter-sdk.mjs        62 lines
src/adapter-contract.mjs  167 lines
```

`defineAdapter` is three of those lines — validate, freeze, return. Most of the rest is refusal: reject a relative manifest path, reject the wrong API version, reject a duplicate module, reject an id that collides with a built-in command.

The volume lives in the adapter you write. The two candidates that ship in this package needed six modules and two Python files for Aider, three modules for Pi. The contract's job is only to say which four things they have to expose and to stop a broken one from loading quietly.

## What an adapter is

A module exporting an `id` of lowercase ASCII letters, a non-empty `displayName`, and an `injection` mode of either `prompt` or `hook`. The id grammar matches the checkpoint filename grammar deliberately — hyphens and path characters are not valid ids in this version, because an id becomes a filename.

Wrap the implementation in the SDK's versioned envelope:

```js
import { defineAdapter } from "@serdardb/context-bridge/adapter-sdk";
export default defineAdapter(adapterImplementation);
```

Registration rejects unsupported API versions, duplicate ids and invalid adapters, and the resulting lookup table is immutable and prototype-free. API compatibility is exact-version negotiation for now: an unsupported major version fails before registration rather than degrading.

## Loading one

Write a JSON manifest with `apiVersion: 1` and `modules`, an array of **absolute** local `.mjs` or `.js` paths, then point an environment variable at it:

```
CONTEXT_BRIDGE_ADAPTERS=/absolute/path/to/manifest.json
```

`bridge adapters --json` then lists what loaded, with each adapter's record and operation descriptors, without running health checks or initialising project state.

Nothing is searched automatically. Not project directories, not installed packages, not remote URLs. No code is downloaded. Installing a package does not register it.

## Loading is authorization

This is the part worth reading twice.

Setting `CONTEXT_BRIDGE_ADAPTERS` is explicit permission to execute those modules with the bridge process's privileges, on **every** CLI invocation that inherits the variable. A module's top-level code runs before its exported contract can be checked, so validation cannot undo what loading it already did, and it cannot stop a trusted plugin that simply hangs.

There is no sandbox here and none is claimed. Load only local code you have read.

## What fails closed

Manifest versions and module availability are checked before any plugin is imported, and these all refuse the invocation rather than continuing in a reduced mode:

- a duplicate module path or a duplicate agent id
- an attempt to override a built-in
- a CLI command name collision
- an unsupported API version

A bad plugin stops that invocation; unsetting the variable recovers. Removing a plugin does not erase the native session data it produced.

One constraint that catches people: plugin modules must import the SDK, not the built-in registry — the registry is still awaiting their initialisation at that point.

## What registering does not give you

A registered adapter participates in the normal agent commands, handoff composition, lanes and diagnostics, and prompt delivery needs no core changes.

Hook delivery is different. Declaring `injection: "hook"` does not install a vendor's hooks or verify them; that remains vendor-specific work outside the contract.

And a structural validator is not acceptance. Before an adapter is worth trusting in production the project asks for native transcript fixtures, parser and opaque-watermark tests, argument conflict tests, discovery and adoption tests, and real resume and handoff evidence — with capability declarations that agree with those records.
