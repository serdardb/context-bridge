import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { watchProject } from "../src/watch.mjs";
import { ensureState, statePath } from "../src/state.mjs";

const cli = fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url));
test("watch requires explicit policy and CLI streams without Git or project writes, then stops on SIGTERM", { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-watch-cli-"));
  const env = { ...process.env, PATH: "", CONTEXT_BRIDGE_HOME: path.join(root, "home") };
  delete env.CONTEXT_BRIDGE_STORAGE;
  delete env.CONTEXT_BRIDGE_ADAPTERS;
  let child;
  try {
    const denied = spawnSync(process.execPath, [cli, "watch"], { cwd: root, env, encoding: "utf8" });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /requires --policy read-only/);
    child = spawn(process.execPath, [cli, "watch", "--policy", "read-only", "--interval", "100"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close");
    let text = "";
    for await (const chunk of child.stdout) {
      text += chunk;
      if (text.includes("\n")) break;
    }
    assert.deepEqual(JSON.parse(text.trim()).status, { state: "absent" });
    child.kill("SIGTERM");
    const [code, signal] = await closed;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { child?.kill("SIGKILL"); fs.rmSync(root, { recursive: true, force: true }); }
});

test("watch reports unavailable and recovery without adopting a replacement directory or repairing state", { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-watch-recovery-"));
  const controller = new AbortController();
  const events = [];
  let stored;
  const stat = fs.statSync, original = stat(root, { bigint: true });
  try {
    // Recycle the original inode for the replacement; only birth time differs.
    fs.statSync = (...args) => {
      const value = stat(...args);
      if (args[0] === fs.realpathSync(root) && events.length === 2) {
        value.ino = args[1]?.bigint ? original.ino : Number(original.ino);
        value.dev = args[1]?.bigint ? original.dev : Number(original.dev);
      }
      return value;
    };
    await watchProject(root, { policy: "read-only", interval: 100, signal: controller.signal,
      emit: async (event) => {
        events.push(event);
        if (events.length === 1) {
          ensureState(root);
          stored = fs.readFileSync(statePath(root));
        } else if (events.length === 2) {
          fs.renameSync(root, `${root}-original`);
          fs.mkdirSync(root);
        } else if (events.length === 3) {
          assert.equal(event.type, "unavailable");
          assert.deepEqual(fs.readdirSync(root), []);
          fs.rmdirSync(root);
          fs.renameSync(`${root}-original`, root);
        } else if (events.length === 4) {
          fs.writeFileSync(statePath(root), JSON.stringify({ version: 999 }));
        } else if (events.length === 5) {
          assert.equal(event.type, "unavailable");
          assert.equal(JSON.parse(fs.readFileSync(statePath(root))).version, 999);
          fs.writeFileSync(statePath(root), stored);
        } else if (events.length === 6) controller.abort();
      } });
    assert.deepEqual(events.map((event) => event.type), ["snapshot", "change", "unavailable", "recovered", "unavailable", "recovered"]);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(fs.readFileSync(statePath(root)), stored);
    fs.statSync = stat;
    const replacement = `${root}-replacement`;
    fs.mkdirSync(replacement);
    ensureState(replacement);
    const duringRead = new AbortController(), observed = [];
    let checks = 0;
    fs.statSync = (...args) => {
      const value = stat(...args);
      if (args[0] === fs.realpathSync(root) && ++checks === 2) {
        // Initial identity and pre-read check see the old inode. Status then
        // resolves a different registered project now occupying that path.
        fs.renameSync(root, `${root}-original`);
        fs.renameSync(replacement, root);
      }
      return value;
    };
    await watchProject(root, { policy: "read-only", signal: duringRead.signal,
      emit: event => { observed.push(event); duringRead.abort(); } });
    assert.equal(observed[0].type, "unavailable", "replacement during status read must not be published as the watched project");
    assert.equal(Object.hasOwn(observed[0], "status"), false);
    fs.statSync = stat;
    await assert.rejects(watchProject(root, { policy: "repair", emit() {} }), /read-only/);
    await assert.rejects(watchProject(root, { policy: "read-only", interval: 1, emit() {} }), /interval/);
  } finally {
    fs.statSync = stat;
    controller.abort();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}-original`, { recursive: true, force: true });
    fs.rmSync(`${root}-replacement`, { recursive: true, force: true });
  }
});
