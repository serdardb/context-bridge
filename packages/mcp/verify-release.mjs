// Publishing is supported only from the reviewed repository with pair evidence.
import { fileURLToPath } from "node:url";
try {
  const { verifyReleaseEvidence } = await import("../../src/release-evidence.mjs");
  verifyReleaseEvidence(fileURLToPath(new URL("../../", import.meta.url)));
} catch (error) {
  console.error(error.expected ? error.message : "Publish the MCP companion only from the reviewed Bridge repository after preparing pair acceptance.");
  process.exitCode = 1;
}
