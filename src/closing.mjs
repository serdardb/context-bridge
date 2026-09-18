import fs from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mutateState, agentSlot, safeCheckpointPath, CHECKPOINT_KINDS, requireClosingComplete } from "./state.mjs";
import { withProjectRuntimeLock } from "./storage.mjs";
import { BridgeError, readOwnedFile } from "./util.mjs";
import { AGENT_IDS } from "./agents/index.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const failure = cause => new BridgeError("Closing evidence could not be completed safely. The recovery plan and delivery progress were retained; inspect the pending evidence before retrying.", {
  code: "BRIDGE_CHECKPOINT_APPEND_FAILED", operation: "recover closing words", cause,
});

export { requireClosingComplete } from "./state.mjs";

/** The pending injection is the journal: state publication precedes all appends. */
export function appendClosing(projectDir, lane, state, agent, mark, fullBlock, deltaBlock) {
  const injection = state.pendingInjection;
  requireClosingComplete(injection);
  if (typeof injection?.deltaFile !== "string" || !injection.deltaFile.endsWith(CHECKPOINT_KINDS.delta)) throw failure();
  const full = injection.deltaFile.replace(/\.md$/, CHECKPOINT_KINDS.fullContext);
  const entries = [full, injection.deltaFile].map((rel, index) => {
    const file = safeCheckpointPath(projectDir, rel);
    if (!file) throw failure();
    let bytes;
    try { bytes = readOwnedFile(file); } catch (cause) { throw failure(cause); }
    return { rel, size: bytes.length, hash: hash(bytes), addition: index === 0 ? fullBlock : deltaBlock(bytes.length) };
  });
  mutateState(projectDir, lane, current => {
    if (!isDeepStrictEqual(current.pendingInjection, injection)) throw failure();
    current.pendingInjection.closing = { version: 1, agent, sourceId: agentSlot(current, agent).id,
      previousMark: agentSlot(current, agent).mark, mark, entries };
  });
  return recoverClosing(projectDir, lane);
}

/** Finish only an exact planned prefix; never reconstruct content from a newer transcript. */
export function recoverClosing(projectDir, lane) {
  return withProjectRuntimeLock(projectDir, () => mutateState(projectDir, lane, state => {
    const injection = state.pendingInjection, plan = injection?.closing;
    if (!plan) return;
    try {
      if (typeof injection.deltaFile !== "string" || !injection.deltaFile.endsWith(CHECKPOINT_KINDS.delta)) throw new Error("Invalid closing destination");
      if (!AGENT_IDS.includes(plan.agent) || !Object.hasOwn(plan, "mark") ||
          !Object.hasOwn(plan, "previousMark")) throw new Error("Invalid closing source");
      const slot = agentSlot(state, plan.agent);
      const expected = [injection.deltaFile.replace(/\.md$/, CHECKPOINT_KINDS.fullContext), injection.deltaFile];
      if (plan.version !== 1 || slot.id !== plan.sourceId || !isDeepStrictEqual(slot.mark, plan.previousMark) ||
          !Array.isArray(plan.entries) || plan.entries.length !== 2) throw new Error("Invalid closing plan");
      const prepared = plan.entries.map((entry, index) => {
        if (entry.rel !== expected[index] || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
            !/^[a-f0-9]{64}$/.test(entry.hash) || typeof entry.addition !== "string") throw new Error("Invalid closing entry");
        const file = safeCheckpointPath(projectDir, entry.rel);
        if (!file) throw new Error("Unsafe closing path");
        const bytes = readOwnedFile(file), addition = Buffer.from(entry.addition);
        const written = bytes.length - entry.size;
        if (written < 0 || written > addition.length || hash(bytes.subarray(0, entry.size)) !== entry.hash ||
            !bytes.subarray(entry.size).equals(addition.subarray(0, written))) throw new Error("Closing evidence changed");
        return { file, bytes, remaining: addition.subarray(written) };
      });
      for (const { file, bytes, remaining } of prepared) {
        let fd;
        try {
          const before = fs.lstatSync(file);
          fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0));
          const opened = fs.fstatSync(fd);
          if (!before.isFile() || before.nlink !== 1 || !opened.isFile() || opened.nlink !== 1 ||
              opened.dev !== before.dev || opened.ino !== before.ino || !fs.readFileSync(fd).equals(bytes)) throw new Error("Closing leaf changed");
          if (remaining.length) fs.appendFileSync(fd, remaining);
          fs.fsyncSync(fd);
        } finally { if (fd !== undefined) fs.closeSync(fd); }
      }
      slot.set({ mark: plan.mark });
      if (injection.sources) injection.sources[plan.agent] = plan.mark;
      delete injection.closing;
    } catch (cause) { throw failure(cause); }
  }));
}
