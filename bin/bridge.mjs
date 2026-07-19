#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).catch((err) => {
  if (err?.expected) {
    console.error(`bridge: ${err.message}`);
    process.exit(err.exitCode ?? 1);
  }
  console.error(`bridge: ${err?.stack || err}`);
  process.exit(1);
});
