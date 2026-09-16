#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).catch((err) => {
  if (err?.expected) {
    console.error(`bridge: ${err.message}`);
    if (err.operation) console.error(`  operation: ${err.operation}`);
    if (err.path) console.error(`  path: ${err.path}`);
    if (err.nextCommand) console.error(`  next: ${err.nextCommand}`);
    process.exit(err.exitCode ?? 1);
  }
  console.error(`bridge: ${err?.stack || err}`);
  process.exit(1);
});
