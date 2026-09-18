import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ADAPTER_API_VERSION, validateAdapter } from "./adapter-contract.mjs";
import { readRegularFile } from "./util.mjs";

export { ADAPTER_API_VERSION, AdapterResultError, validateAdapter, validateAdapterResult,
  createAdapterRegistry, adapterDescriptor, REQUIRED_OPERATIONS, RECORD_FIELDS, RECORD_VALUES } from "./adapter-contract.mjs";

export function defineAdapter(adapter, apiVersion = ADAPTER_API_VERSION) {
  validateAdapter(adapter, apiVersion);
  return Object.freeze({ apiVersion, adapter });
}

const RESERVED = new Set(["doctor", "verify", "eval", "release", "storage", "project", "status",
  "clean", "inspect", "handoff", "lane", "unlink", "help", "version", "search", "artifact", "share", "adapters", "mcp", "watch"]);

// Explicit configuration is permission to execute trusted local JS. Never
// discover plugins from a project, package dependency or remote URL implicitly.
export async function loadAdapterPlugins(manifestPath, existingIds = []) {
  if (!manifestPath) return [];
  const fail = (message, cause) => {
    const error = new Error(`Adapter plugins: ${message}`, { cause });
    error.expected = true;
    throw error;
  };
  if (!path.isAbsolute(manifestPath)) fail("CONTEXT_BRIDGE_ADAPTERS must be an absolute manifest path");
  let manifest;
  try { manifest = JSON.parse(readRegularFile(manifestPath)); }
  catch { fail("cannot read the configured JSON manifest"); }
  if (!manifest || manifest.apiVersion !== ADAPTER_API_VERSION || !Array.isArray(manifest.modules) ||
      manifest.modules.some((file) => typeof file !== "string" || !path.isAbsolute(file) || !/\.m?js$/.test(file))) {
    fail("expected apiVersion 1 and an array of absolute local .js/.mjs module paths");
  }
  const files = [];
  for (const file of manifest.modules) {
    try {
      const real = fs.realpathSync(file);
      if (!fs.statSync(real).isFile()) fail("module is not a regular file");
      if (files.includes(real)) fail("duplicate module path");
      files.push(real);
    } catch (error) {
      if (error.expected) throw error;
      fail("configured module is unavailable");
    }
  }
  const ids = new Set(existingIds);
  const adapters = [];
  for (const file of files) {
    let plugin;
    try { plugin = (await import(pathToFileURL(file).href)).default; }
    catch { fail("module failed to load; inspect the trusted plugin implementation"); }
    if (!plugin || plugin.apiVersion !== ADAPTER_API_VERSION) fail("module must default-export defineAdapter(adapter) for API v1");
    let adapter;
    try { adapter = validateAdapter(plugin.adapter, plugin.apiVersion); }
    catch (error) { fail("module exports an invalid adapter contract; inspect the trusted plugin implementation", error); }
    if (ids.has(adapter.id) || RESERVED.has(adapter.id)) fail(`duplicate or reserved agent name '${adapter.id}'`);
    ids.add(adapter.id);
    adapters.push(adapter);
  }
  return adapters;
}
