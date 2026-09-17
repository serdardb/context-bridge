import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Each test worker owns its store. CLI children inherit it, never the real home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-runtime-"));
process.env.CONTEXT_BRIDGE_HOME = home;
delete process.env.CONTEXT_BRIDGE_STORAGE;
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
