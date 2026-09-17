import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readPiSession } from "./pi-records.mjs";
import { wasAdoptedProjectRoot } from "../storage.mjs";

const expand = (value) => value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);
const canonical = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };

export const piAgentDirectory = (env = process.env) => env.PI_CODING_AGENT_DIR ? expand(env.PI_CODING_AGENT_DIR) : path.join(os.homedir(), ".pi", "agent");

export function piSessionDirectory(projectDir, env = process.env) {
  if (env.PI_CODING_AGENT_SESSION_DIR) return expand(env.PI_CODING_AGENT_SESSION_DIR);
  const home = piAgentDirectory(env);
  const encoded = `--${path.resolve(projectDir).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(home, "sessions", encoded);
}

export function piSessionRef(projectDir, file, expectedId = null) {
  if (!fs.lstatSync(file).isFile()) throw new Error("Pi session must be a regular file.");
  const session = readPiSession(file);
  if (expectedId !== null && session.header.id !== expectedId) throw new Error("Pi session identity differs from the linked session.");
  if (canonical(session.header.cwd) !== canonical(projectDir) &&
      !(expectedId !== null && wasAdoptedProjectRoot(projectDir, session.header.cwd))) {
    throw new Error("Pi session belongs to a different project.");
  }
  return { id: session.header.id, transcriptPath: path.resolve(file), startedAt: session.header.timestamp,
    updatedAt: fs.statSync(file).mtime.toISOString(), deterministic: false };
}

// The directory name is only a lookup hint: path encoding is not injective.
// Every candidate must prove its project using its own native header.
export function piSessionsForProject(projectDir, env = process.env) {
  const dir = piSessionDirectory(projectDir, env);
  let names;
  try { names = fs.readdirSync(dir); }
  catch (error) { if (error.code === "ENOENT") return { sessions: [], examined: 0, unreadable: 0 }; throw error; }
  const sessions = [];
  let examined = 0, unreadable = 0;
  for (const name of names.filter((name) => name.endsWith(".jsonl"))) {
    const file = path.join(dir, name);
    examined++;
    try { sessions.push(piSessionRef(projectDir, file)); }
    catch { unreadable++; }
  }
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) {
    throw new Error("Multiple Pi files claim the same session identity; refusing to choose.");
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { sessions, examined, unreadable };
}
