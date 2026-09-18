import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { projectStatus } from "./status.mjs";
import { BridgeError } from "./util.mjs";
import { directoryIdentity } from "./directory-identity.mjs";

// Poll authoritative state rather than trusting lossy platform-specific fs events.
// This stream is an observation, never a durable delivery receipt or event log.
export async function watchProject(projectDir, { policy, interval = 1000, signal, emit } = {}) {
  if (policy !== "read-only") throw new Error("watch requires --policy read-only; automatic actions are not supported.");
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60000) throw new Error("Watch interval must be an integer from 100 to 60000 milliseconds.");
  if (typeof emit !== "function") throw new Error("Watch requires an event sink.");
  const root = fs.realpathSync(projectDir);
  const initial = directoryIdentity(root);
  if (!initial) throw new BridgeError("Watch requires a verifiable directory creation identity; no project state was changed.", { code: "BRIDGE_PROJECT_IDENTITY_UNAVAILABLE" });
  let previous = null;
  let unavailable = false;
  let sequence = 0;
  while (!signal?.aborted) {
    let status;
    try {
      if (directoryIdentity(root) !== initial) throw new Error("Project identity changed");
      const candidate = projectStatus(root);
      if (directoryIdentity(root) !== initial) throw new Error("Project identity changed during status read");
      status = candidate;
    } catch {
      if (!unavailable) {
        await emit({ type: "unavailable", sequence: ++sequence, at: new Date().toISOString(),
          reason: "Project state cannot be read safely; no repair was attempted." });
      }
      unavailable = true;
    }
    if (status) {
      const fingerprint = JSON.stringify(status);
      if (unavailable || fingerprint !== previous) {
        await emit({ type: unavailable ? "recovered" : previous === null ? "snapshot" : "change",
          sequence: ++sequence, at: new Date().toISOString(), status });
      }
      previous = fingerprint;
      unavailable = false;
    }
    try { await delay(interval, undefined, { signal }); }
    catch (error) { if (error.name !== "AbortError") throw error; }
  }
}

export async function runWatch(projectDir, options) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.on("error", stop);
  try {
    await watchProject(projectDir, { ...options, signal: controller.signal,
      emit: (event) => new Promise((resolve, reject) => {
        process.stdout.write(`${JSON.stringify(event)}\n`, (error) => error ? reject(error) : resolve());
      }) });
  } catch (error) {
    if (error.code !== "EPIPE") throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.stdout.removeListener("error", stop);
  }
}
