import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("official transfer failures never print companion content and success requires a thread identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-transfer-output-"));
  const companion = path.join(root, "companion.mjs");
  const secret = "SYNTHETIC_PRIVATE_TRANSFER_CONTENT";
  const module = new URL("../src/transfer.mjs", import.meta.url).href;
  try {
    for (const scenario of ["failure", "invalid-json", "invalid-id", "success"]) {
      const output = scenario === "success" ? JSON.stringify({ threadId: "synthetic-thread" })
        : scenario === "invalid-id" ? JSON.stringify({ threadId: { private: secret } }) : secret;
      fs.writeFileSync(companion, `console.log(${JSON.stringify(output)}); console.error(${JSON.stringify(secret)}); process.exit(${scenario === "failure" ? 7 : 0});`);
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { transferClaudeSession } from ${JSON.stringify(module)};
        try { console.log(JSON.stringify(transferClaudeSession('synthetic-transcript'))); }
        catch (error) { console.error(error.message); process.exit(error.expected ? 1 : 2); }
      `], { encoding: "utf8", timeout: 10000,
        env: { ...process.env, BRIDGE_CODEX_COMPANION: companion, BRIDGE_DEBUG: "1" } });
      assert.equal(result.status, scenario === "success" ? 0 : 1, result.stderr);
      assert.ok(!(result.stdout + result.stderr).includes(secret), `${scenario}: companion content must remain private`);
      if (scenario === "success") assert.equal(JSON.parse(result.stdout).threadId, "synthetic-thread");
      else assert.match(result.stderr, /may have created a session/i);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
