#!/usr/bin/env bun
// Thin standalone CLI bootstrap. All behavior lives in the shared capability
// implementation and the reusable core adapter. `--serve <socket>` runs the
// long-lived daemon instead of one CLI invocation.
import { join } from "node:path";
import { runStandaloneCapabilityCli } from "@agent-software/core";
import { serveDaemon } from "./daemon";
import { setupExtensionPairing } from "./src/backends/extension";

const [flag, arg] = process.argv.slice(2);
if (flag === "--serve" && arg) {
  await serveDaemon(import.meta.dir, arg);
} else if (flag === "extension-setup") {
  const extDir = arg || join(import.meta.dir, "extension");
  const result = await setupExtensionPairing(extDir);
  console.log(JSON.stringify(result));
} else {
  process.exit(await runStandaloneCapabilityCli(import.meta.dir));
}
