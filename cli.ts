#!/usr/bin/env bun
// Thin standalone CLI bootstrap. All behavior lives in the shared capability
// implementation and the reusable core adapter. `--serve <socket>` runs the
// long-lived daemon instead of one CLI invocation.
import { runStandaloneCapabilityCli } from "@agent-software/core";
import { serveDaemon } from "./daemon";

const [flag, socketPath] = process.argv.slice(2);
if (flag === "--serve" && socketPath) {
  await serveDaemon(import.meta.dir, socketPath);
} else {
  process.exit(await runStandaloneCapabilityCli(import.meta.dir));
}
