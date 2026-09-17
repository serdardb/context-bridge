import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAiderRuntime } from "../src/agents/aider-runtime.mjs";

test("Aider runtime never guesses a Python from PATH or accepts an unverified interpreter", (t) => {
  for (const value of [undefined, "python", "./python", "/bad\0python"]) {
    assert.throws(() => resolveAiderRuntime({ env: { CONTEXT_BRIDGE_AIDER_PYTHON: value } }), /absolute interpreter/);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-aider-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => resolveAiderRuntime({ env: { CONTEXT_BRIDGE_AIDER_PYTHON: root } }), /not executable/);
  const missing = path.join(root, "absent");
  assert.throws(() => resolveAiderRuntime({ env: { CONTEXT_BRIDGE_AIDER_PYTHON: missing } }), /not executable/);
  // A real executable that is not Python must not be accepted because it starts.
  assert.throws(() => resolveAiderRuntime({ env: { ...process.env, CONTEXT_BRIDGE_AIDER_PYTHON: process.execPath } }),
    /runtime verification failed/);
});
