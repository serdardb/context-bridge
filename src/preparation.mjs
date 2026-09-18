import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AGENT_IDS } from "./agents/index.mjs";
import { safeCheckpointsDir, safeCheckpointPath, checkpointRel, withProjectStateReadLock,
  CHECKPOINT_KINDS, CONSUMED_SUFFIX } from "./state.mjs";
import { writeFileExclusive, readOwnedFile } from "./util.mjs";
import { withProjectRuntimeLock } from "./storage.mjs";

const STEM = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-(?:${AGENT_IDS.join("|")})-to-(?:${AGENT_IDS.join("|")})$`);
const hash = (content) => createHash("sha256").update(content).digest("hex");
const journalName = (stem) => `.handoff-${stem}.json`;

export function preparationStemForName(name) {
  if (typeof name !== "string" || !name.startsWith(".handoff-") || !name.endsWith(".json")) return null;
  const stem = name.slice(".handoff-".length, -".json".length);
  return STEM.test(stem) ? stem : null;
}

/** Retention protects even damaged journals until recovery resolves them. */
export function preparationStems(projectDir, lane) {
  const dir = safeCheckpointsDir(projectDir, lane);
  let names;
  try { names = fs.readdirSync(dir); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.filter((n) => n.startsWith(".handoff-") && n.endsWith(".json")).map((name) => {
    const stem = preparationStemForName(name);
    if (!stem) throw new Error("Unrecognized handoff preparation journal.");
    return stem;
  });
}

/** Reserve the whole filename group before any evidence file is created. */
export function beginPreparation(projectDir, lane, stem, contents) {
  if (!STEM.test(stem)) throw new Error("Invalid handoff preparation stem.");
  const files = Object.entries(contents).map(([suffix, content]) => {
    if (!Object.values(CHECKPOINT_KINDS).includes(suffix)) throw new Error("Invalid preparation file kind.");
    return { suffix, hash: hash(content) };
  });
  return withProjectStateReadLock(projectDir, () => {
    const dir = safeCheckpointsDir(projectDir, lane);
    const journal = path.join(dir, journalName(stem));
    fs.mkdirSync(dir, { recursive: true });
    for (const { suffix } of files) {
      try { fs.lstatSync(path.join(dir, stem + suffix)); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      throw new Error("Preparation evidence already exists; refusing to replace it.");
    }
    writeFileExclusive(journal, JSON.stringify({ version: 1, pid: process.pid, lane, stem, files }));
    return journal;
  });
}

export function finishPreparation(projectDir, journal) {
  return withProjectRuntimeLock(projectDir, () => fs.unlinkSync(journal));
}

/** Recover only dead writers with unchanged, unreferenced evidence. */
export function recoverPreparations(projectDir, lane) {
  return withProjectStateReadLock(projectDir, (disk) => {
    const dir = safeCheckpointsDir(projectDir, lane);
    if (!disk) throw new Error("Handoff recovery requires readable project state.");
    let names;
    try { names = fs.readdirSync(dir); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const name of names.filter((n) => n.startsWith(".handoff-") && n.endsWith(".json"))) {
      const journal = path.join(dir, name);
      const record = JSON.parse(readOwnedFile(journal, { encoding: "utf8" }));
      if (record.version !== 1 || record.lane !== lane || !STEM.test(record.stem) ||
          name !== journalName(record.stem) || !Number.isSafeInteger(record.pid) || record.pid < 1 ||
          !Array.isArray(record.files) || record.files.length < 2 || record.files.length > 3 ||
          new Set(record.files.map((f) => f?.suffix)).size !== record.files.length ||
          !record.files.some((f) => f?.suffix === CHECKPOINT_KINDS.delta) ||
          !record.files.some((f) => f?.suffix === CHECKPOINT_KINDS.fullContext) ||
          record.files.some((f) => !Object.values(CHECKPOINT_KINDS).includes(f?.suffix) || !/^[a-f0-9]{64}$/.test(f?.hash))) {
        throw new Error("Invalid handoff preparation journal; evidence retained.");
      }
      try { process.kill(record.pid, 0); continue; }
      catch (error) { if (error.code !== "ESRCH") continue; }
      const delta = safeCheckpointPath(projectDir, checkpointRel(projectDir, lane, record.stem + CHECKPOINT_KINDS.delta));
      const referenced = Object.values(disk?.lanes ?? {}).some((l) =>
        l.pendingInjection && safeCheckpointPath(projectDir, l.pendingInjection.deltaFile) === delta);
      if (!referenced && !fs.existsSync(`${delta}${CONSUMED_SUFFIX}`)) {
        const files = record.files.map(({ suffix, hash: expected }) => {
          const file = safeCheckpointPath(projectDir, checkpointRel(projectDir, lane, record.stem + suffix));
          if (!file) throw new Error("Unsafe handoff recovery path.");
          let stat;
          try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
          if (!stat.isFile() || hash(readOwnedFile(file)) !== expected) {
            throw new Error("Handoff preparation evidence changed; refusing recovery cleanup.");
          }
          return file;
        });
        for (const file of files) if (file) fs.unlinkSync(file);
      }
      finishPreparation(projectDir, journal);
    }
  });
}
