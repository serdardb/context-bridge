import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { projectStatus } from "./status.mjs";
import { searchProject } from "./search.mjs";
import { AGENT_IDS, adapterFor } from "./agents/index.mjs";
import { adapterDescriptor } from "./adapter-contract.mjs";
import { BridgeError } from "./util.mjs";
import { directoryIdentity } from "./directory-identity.mjs";

const packageName = "@serdardb/context-bridge-mcp";
const require = createRequire(import.meta.url);

async function companion() {
  const explicit = process.env.CONTEXT_BRIDGE_MCP_MODULE;
  let entry;
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new BridgeError("CONTEXT_BRIDGE_MCP_MODULE must name an absolute trusted module file.", { code: "BRIDGE_MCP_CONFIG" });
    entry = explicit;
  } else {
    try { entry = require.resolve(packageName); }
    catch (cause) {
      throw new BridgeError("MCP companion is not resolvable from this Bridge installation. Install @serdardb/context-bridge-mcp alongside Bridge with npm, or set CONTEXT_BRIDGE_MCP_MODULE to its trusted absolute index.mjs path (including isolated package managers). No automatic installation was attempted.",
        { code: "BRIDGE_MCP_UNAVAILABLE", cause });
    }
  }
  let module;
  try { module = await import(pathToFileURL(entry).href); }
  catch (cause) {
    throw new BridgeError("The selected MCP companion could not load. Check its installation and dependencies; project content was not read.", { code: "BRIDGE_MCP_LOAD", cause });
  }
  if (module.bridgeMcpApiVersion !== 1 || typeof module.runMcp !== "function") {
    throw new BridgeError("The selected MCP companion is incompatible with Bridge MCP API 1. Install a compatible companion; project content was not read.", { code: "BRIDGE_MCP_INCOMPATIBLE" });
  }
  return module;
}

export async function runMcp(projectDir, { allowContent = false } = {}) {
  const module = await companion();
  const root = fs.realpathSync(projectDir);
  const initial = directoryIdentity(root);
  if (!initial) throw new BridgeError("MCP requires a verifiable directory creation identity; no project state was changed.", { code: "BRIDGE_PROJECT_IDENTITY_UNAVAILABLE" });
  const read = (fn) => (args) => {
    if (directoryIdentity(root) !== initial) throw new Error("Project replaced");
    const value = fn(args);
    if (directoryIdentity(root) !== initial) throw new Error("Project replaced during read");
    return value;
  };
  const services = {
    version: JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    status: read(() => projectStatus(root)),
    adapters: read(() => ({ adapters: AGENT_IDS.map((id) => adapterDescriptor(adapterFor(id))) })),
  };
  // No content-reading capability is supplied unless the operator opted in.
  if (allowContent) services.search = read(({ query, limit = 20, ...filters }) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BridgeError("MCP search limit must be an integer from 1 to 100.", { code: "BRIDGE_MCP_LIMIT" });
    }
    const report = searchProject(root, query, filters);
    return { ...report, results: report.results.slice(0, limit), totalMatches: report.results.length,
      omittedResults: Math.max(0, report.results.length - limit) };
  });
  return module.runMcp(Object.freeze(services));
}
