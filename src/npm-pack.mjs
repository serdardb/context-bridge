import { BridgeError } from "./util.mjs";

// npm <=11 returns an array; npm 12 keys the same records by package name.
export function parsePackResult(raw, expectedName) {
  const fail = () => new BridgeError("npm pack did not return one verifiable package with a nonempty file list.",
    { code: "BRIDGE_NPM_PACK_INVALID", operation: "inspect release package" });
  let value;
  try { value = JSON.parse(raw); } catch { throw fail(); }
  if (!value || typeof value !== "object") throw fail();
  const records = Array.isArray(value) ? value : Object.values(value);
  if (records.length !== 1 || (!Array.isArray(value) && Object.keys(value)[0] !== expectedName)) throw fail();
  const record = records[0];
  if (!record || record.name !== expectedName || typeof record.filename !== "string" ||
      !record.filename.endsWith(".tgz") || /[\\/]/.test(record.filename) ||
      !Array.isArray(record.files) || record.files.length === 0 ||
      record.files.some((file) => !file || typeof file.path !== "string" || !file.path.trim())) throw fail();
  return record;
}
