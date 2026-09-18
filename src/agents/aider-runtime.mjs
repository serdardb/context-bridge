import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Only the SDK lifecycle exercised by native acceptance is enabled. Adding a
// version requires repeating that acceptance, not widening a semver guess.
export const AIDER_SDK_VERSION = "0.86.2";
const probe = "import sys,json,importlib.metadata as m; print(json.dumps({" +
  "'python':list(sys.version_info[:3]),'prefix':sys.prefix," +
  "'isolated':sys.flags.isolated,'aider':m.version('aider-chat')}))";

export function resolveAiderRuntime({ env = process.env, cwd = process.cwd() } = {}) {
  const python = env.CONTEXT_BRIDGE_AIDER_PYTHON;
  if (typeof python !== "string" || !path.isAbsolute(python) || python.includes("\0")) {
    throw new Error("Set CONTEXT_BRIDGE_AIDER_PYTHON to the absolute interpreter path of a trusted Aider environment.");
  }
  try {
    if (!fs.statSync(python).isFile()) throw new Error();
    fs.accessSync(python, fs.constants.X_OK);
  } catch {
    throw new Error("The configured Aider interpreter is not executable.");
  }
  // Do not realpath a venv's Python symlink: invoking its base target selects a
  // different environment. -I excludes cwd, PYTHONPATH and user site packages.
  const result = spawnSync(python, ["-I", "-c", probe], {
    cwd, env, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let info;
  try { info = JSON.parse(result.stdout); } catch {}
  if (result.error || result.status !== 0 || info?.isolated !== 1 ||
      !Array.isArray(info.python) || info.python.length !== 3 ||
      !info.python.every(Number.isSafeInteger) || info.python[0] !== 3 ||
      info.python[1] < 10 || info.python[1] >= 13 ||
      typeof info.prefix !== "string" || !path.isAbsolute(info.prefix)) {
    throw new Error("Aider requires a readable isolated Python 3.10-3.12 environment; runtime verification failed.");
  }
  if (info.aider !== AIDER_SDK_VERSION) {
    throw new Error(`This Aider transport is verified only with aider-chat ${AIDER_SDK_VERSION}; the configured SDK is not supported.`);
  }
  return Object.freeze({ cmd: python, pythonVersion: info.python.join("."),
    sdkVersion: info.aider, prefix: info.prefix, flags: Object.freeze(["-I", "-B"]) });
}
