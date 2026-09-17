import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { verifyArtifact } from "../src/artifact.mjs";
import { readFullContextSections } from "../src/delta.mjs";

test("real global-store export masks nested paths and secrets in every context section and audit without editing evidence", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-redaction-")));
  const home = path.join(root, "home"), project = path.join(home, "work/private-project");
  fs.mkdirSync(project, { recursive: true });
  const keys = ["token", "access_token", "refresh_token", "api_key", "api-key", "apikey", "password",
    "passwd", "secret", "cookie", "authorization", "aws_access_key_id", "aws_secret_access_key", "private_key"];
  const credentials = Object.fromEntries(keys.map((key, i) => [key, `structured-secret-${i}`]));
  const secrets = keys.flatMap((key, i) => [`plain-secret-${i}`, `quoted secret ${i}`, `single secret ${i}`]);
  const assignments = keys.flatMap((key, i) => [
    `${key}=plain-secret-${i}`,
    JSON.stringify({ [key]: `quoted secret ${i}` }),
    `${key}='single secret ${i}'`,
  ]);
  const tokens = ["ghp_" + "A".repeat(36), "github_pat_" + "B".repeat(40), "AKIA" + "C".repeat(16),
    "ASIA" + "D".repeat(16), "xoxb-1234567890-9876543210-secret", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.signature",
    "sk-" + "E".repeat(24)];
  const text = ["Keep the reason: retries must preserve the old handoff.",
    `${project}/source.mjs`, `${home}/outside.txt`, ...assignments, ...tokens,
    'api_key="escaped \\"quote secret"',
    "Authorization: Basic basic-secret", "Cookie: session=cookie-one; csrf=cookie-two",
    "-----BEGIN PRIVATE KEY-----\nprivate-key-body-one\nprivate-key-body-two\n-----END PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nopenssh-key-body\n-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: "", NODE_OPTIONS: "", CODEX_THREAD_ID: "",
    CONTEXT_BRIDGE_HOME: path.join(root, "store"), CONTEXT_BRIDGE_STORAGE: "", CONTEXT_BRIDGE_ADAPTERS: "" };
  try {
    const setup = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';
      import {ensureState, writeCheckpoint, safeCheckpointPath} from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
      import {composeFullContext} from ${JSON.stringify(new URL("../src/delta.mjs", import.meta.url).href)};
      import {writeManifest} from ${JSON.stringify(new URL("../src/audit.mjs", import.meta.url).href)};
      const project = process.cwd(), text = ${JSON.stringify(text)};
      ensureState(project);
      const stem = '2026-09-17T00-00-00-000Z-claude-to-codex';
      const context = composeFullContext({fromAgent:'claude', summary:text, decisions:[text], next:[text], work:[], conversation:[{role:'user', text}]});
      const rel = writeCheckpoint(project, 'main', stem + '-full.md', context);
      const audit = writeManifest(project, 'main', stem, {credentials:${JSON.stringify(credentials)}, command:text});
      console.log(JSON.stringify([safeCheckpointPath(project, rel), safeCheckpointPath(project, audit)]));
    `], { cwd: project, env, encoding: "utf8", timeout: 15000 });
    assert.equal(setup.status, 0, setup.stderr);
    const files = JSON.parse(setup.stdout), before = files.map((file) => fs.readFileSync(file));
    const output = path.join(root, "export.cbctx");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/bridge.mjs", import.meta.url)),
      "artifact", "export", output], { cwd: project, env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const artifact = verifyArtifact(output);
    const raw = fs.readFileSync(output, "utf8");
    for (const secret of [...secrets, ...Object.values(credentials), ...tokens,
      "basic-secret", "cookie-one", "cookie-two", "private-key-body-one", "private-key-body-two", "openssh-key-body", "quote secret"]) {
      assert.ok(!raw.includes(secret), `export leaked ${secret}`);
    }
    for (const field of ["context", "summary", "decisions", "next", "conversation"]) {
      assert.ok(artifact[field].includes("<project>/source.mjs"), `${field}: project must be masked before home`);
      assert.ok(artifact[field].includes("<home>/outside.txt"));
      assert.ok(!artifact[field].includes(home));
      assert.ok(!artifact[field].includes("<home>/work/private-project"));
      assert.ok(artifact[field].includes("Keep the reason: retries must preserve the old handoff."));
    }
    assert.equal(artifact.audit.credentials.api_key, "<redacted>");
    assert.ok(artifact.audit.command.includes("<project>/source.mjs"));
    assert.equal(readFullContextSections(artifact.context).summary, artifact.summary);
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i], "export must not redact the source evidence"));
    assert.deepEqual(fs.readdirSync(project), [], "production export must not create project-local runtime files");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
