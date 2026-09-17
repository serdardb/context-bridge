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
  try {
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
    await assert.rejects(watchProject(root, { policy: "repair", emit() {} }), /read-only/);
    await assert.rejects(watchProject(root, { policy: "read-only", interval: 1, emit() {} }), /interval/);
  } finally {
    controller.abort();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}-original`, { recursive: true, force: true });
  }
});
